// OBS takeover: OBS (or any SRT encoder) streams to the panel instead of
// straight to YouTube. The panel stays the ONLY connection to YouTube, so the
// two never fight over the stream key: when OBS connects, the pipeline cuts
// the playlist at a clean point and puts OBS on air; when OBS stops (or its
// feed dies) the playlist carries on where it was cut. One broadcast throughout.
//
//   OBS --SRT (encrypted, passphrase)--> listener ffmpeg --MPEG-TS--> Node
//     video: copied — OBS must send the profile's resolution and frame rate
//            (re-encoding 1080p takes more CPU than the free server has), so
//            anything else is refused with a plain-language fix
//     audio: re-encoded to the profile (cheap) — OBS defaults to 48 kHz,
//            and a sample-rate change mid-stream breaks the audio
//   Node keeps the latest GOP, so a takeover starts on a keyframe.
//
// Events: listening {port}   connected {info}   rejected {reason}
//         ended {reason, seconds}

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { FFMPEG, terminate } from './ffmpeg.js';

const PACKET = 188;
const RELISTEN_DELAY = 1000; // ms after OBS leaves before accepting again
const MAX_GOP_BYTES = 64 * 1024 * 1024;
const SRT_LATENCY_US = 2_000_000; // retransmission window: generous, latency doesn't matter here

// What OBS is sending, from the listener's "Input #0" stream lines.
export function parseStreamLine(line, info) {
  const v = /Stream #0:\d+.*?: Video: (\w+).*?, (\d{2,5})x(\d{2,5})/.exec(line);
  if (v) {
    const rate = /, ([\d.]+) fps/.exec(line) ?? /, ([\d.]+) tbr/.exec(line);
    Object.assign(info, { videoCodec: v[1], width: Number(v[2]), height: Number(v[3]), fps: rate ? Number(rate[1]) : null });
  }
  const a = /Stream #0:\d+.*?: Audio: (\w+).*?, (\d+) Hz, ([\w.() ]+?),/.exec(line);
  if (a) Object.assign(info, { audioCodec: a[1], sampleRate: Number(a[2]), channels: a[3] });
  return info;
}

// Why OBS's stream can't go on air as-is (with where to fix it in OBS), or null.
export function checkInfo(info, p) {
  if (!info.videoCodec) return 'OBS is sending no video.';
  if (info.videoCodec !== 'h264') {
    return `OBS is sending ${info.videoCodec.toUpperCase()} video. In OBS: Settings > Output > Encoder: x264 (or any H.264 encoder).`;
  }
  if (info.width !== p.width || info.height !== p.height) {
    return `OBS is sending ${info.width}x${info.height}, the stream is ${p.width}x${p.height}. In OBS: Settings > Video > Output (Scaled) Resolution: ${p.width}x${p.height}.`;
  }
  if (!info.fps || Math.abs(info.fps - p.fps) > 0.05) {
    return `OBS is sending ${info.fps ?? '?'} fps, the stream is ${p.fps} fps. In OBS: Settings > Video > Common FPS Values: ${p.fps}.`;
  }
  if (!info.audioCodec) return 'OBS is sending no audio track.';
  return null;
}

export function obsUrl({ host, port, passphrase }) {
  return `srt://${host}:${port}?passphrase=${passphrase}&latency=${SRT_LATENCY_US}`;
}

export class Ingest extends EventEmitter {
  // getConfig(): config with .obs and .profile. bind: listen address.
  // idleTimeout: seconds without data before OBS counts as gone (a frozen
  // encoder can keep the SRT connection open).
  constructor({ getConfig, bind = '0.0.0.0', idleTimeout = 5, log = () => {} }) {
    super();
    this.getConfig = getConfig;
    this.bind = bind;
    this.idleTimeout = idleTimeout;
    this.log = log;
    this.proc = null;
    this.state = 'off'; // off | listening | connected | live | rejected
    this.since = null;
    this.info = null;
    this.lastError = null;
    this.keyint = null; // seconds between OBS keyframes
    this.sink = null;
    this.closing = false;
    this.#resetStream();
  }

  #resetStream() {
    this.remainder = null;
    this.pat = null;
    this.pmt = null;
    this.pmtPid = null;
    this.videoPid = null;
    this.gop = null; // packets since the latest keyframe
    this.gopBytes = 0;
    this.lastKeyAt = null; // 90 kHz PTS of the latest keyframe
  }

  start() {
    this.closing = false;
    if (this.getConfig().obs.enabled) this.#listen();
    this.watchdog ??= setInterval(() => this.#checkIdle(), 1000);
    this.watchdog.unref?.();
  }

  // Settings changed: (re)open the listener with the new port/passphrase.
  apply() {
    const { enabled, port, passphrase } = this.getConfig().obs;
    const key = `${enabled}:${port}:${passphrase}`;
    if (key === this.applied) return;
    this.#kill('settings changed');
    if (enabled) setTimeout(() => this.#listen(), 300);
    else this.#setState('off');
  }

  close() {
    this.closing = true;
    clearInterval(this.watchdog);
    this.watchdog = null;
    this.#kill('shutting down');
  }

  // Refuse what OBS is sending (wrong format, stream stopped): drop the
  // connection so OBS shows an error instead of pretending to be live.
  reject(reason) {
    this.lastError = reason;
    this.log(`refused OBS: ${reason}`);
    this.emit('rejected', { reason });
    this.#kill('refused', 'rejected');
  }

  status() {
    const cfg = this.getConfig().obs;
    return {
      enabled: cfg.enabled, port: cfg.port, state: this.state, since: this.since,
      info: this.info, keyint: this.keyint, lastError: this.lastError,
    };
  }

  // The pipeline's segment for OBS. Its feeder reads MPEG-TS from stdin.
  segment() {
    return {
      id: 'obs',
      title: 'OBS (live)',
      live: true,
      // Short probe: our own listener's output, always the same layout. The
      // default (5 s) delayed the first output ~3.5 s, a pause on YouTube.
      inputArgs: () => ['-probesize', '131072', '-analyzeduration', '500000', '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0'],
      attach: (stdin) => this.#attach(stdin),
    };
  }

  // ------------------------------------------------------------

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.since = Date.now();
  }

  #listen() {
    if (this.proc || this.closing) return;
    const { obs, profile: p } = this.getConfig();
    this.applied = `${obs.enabled}:${obs.port}:${obs.passphrase}`;
    const url = `srt://${this.bind}:${obs.port}?mode=listener&passphrase=${obs.passphrase}&latency=${SRT_LATENCY_US}`;
    const args = [
      '-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin',
      '-i', url,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', p.audioBitrate, '-ar', String(p.sampleRate), '-ac', '2',
      '-f', 'mpegts', 'pipe:1',
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.#resetStream();
    this.info = null;
    this.keyint = null;
    this.connectedAt = null;
    this.lastDataAt = null;
    this.#setState('listening');
    this.log(`waiting for OBS on port ${obs.port} (SRT)`);
    this.emit('listening', { port: obs.port });

    const info = {};
    let section = null;
    proc.on('error', (err) => this.log(`listener spawn error: ${err.message}`));
    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      if (line.startsWith('Input #0')) section = 'input';
      else if (/^(Output #0|Stream mapping)/.test(line)) {
        if (section === 'input') this.#onConnected(info);
        section = 'output';
      } else if (section === 'input') parseStreamLine(line, info);
      if (/error|failed|invalid/i.test(line) && !/Error during demuxing/.test(line)) this.lastError = this.#mask(line.trim());
    });
    proc.stdout.on('data', (chunk) => this.#onData(chunk));
    proc.on('close', (code) => this.#onClose(proc, code));
  }

  #mask(s) {
    const pass = this.getConfig().obs.passphrase;
    return pass ? s.split(pass).join('***') : s;
  }

  #onConnected(info) {
    this.info = { ...info };
    this.connectedAt = Date.now();
    this.lastDataAt = Date.now();
    this.log(`OBS connected: ${info.videoCodec} ${info.width}x${info.height} ${info.fps} fps, audio ${info.audioCodec ?? 'none'} ${info.sampleRate ?? ''} Hz`);
    const problem = checkInfo(info, this.getConfig().profile);
    if (problem) return this.reject(problem);
    this.lastError = null;
    this.#setState('connected');
    // 'connected' fires once the first keyframe is in hand (see #onData).
  }

  #onData(chunk) {
    this.lastDataAt = Date.now();
    const buf = this.remainder ? Buffer.concat([this.remainder, chunk]) : chunk;
    const whole = buf.length - (buf.length % PACKET);
    this.remainder = whole < buf.length ? Buffer.from(buf.subarray(whole)) : null;
    if (!whole) return;
    for (let o = 0; o < whole; o += PACKET) this.#inspect(buf, o);
    if (this.sink) this.#write(buf.subarray(0, whole));
  }

  #inspect(b, o) {
    if (b[o] !== 0x47) return;
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    const pusi = (b[o + 1] & 0x40) !== 0;
    const afc = (b[o + 3] >> 4) & 0x3;
    const packet = () => Buffer.from(b.subarray(o, o + PACKET));
    let p = o + 4;
    let rai = false;
    if (afc & 0x2) {
      rai = b[o + 4] > 0 && (b[o + 5] & 0x40) !== 0;
      p += 1 + b[o + 4];
    }
    if (pid === 0 && pusi) {
      this.pat = packet();
      // PAT section: pointer, table header (8), then program -> PMT pid
      const s = p + 1 + b[p];
      if (s + 12 <= o + PACKET) this.pmtPid = ((b[s + 10] & 0x1f) << 8) | b[s + 11];
      return;
    }
    if (pid === this.pmtPid && pusi) {
      this.pmt = packet();
      return;
    }
    if (pusi && p + 14 <= o + PACKET && b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 1 && b[p + 3] >= 0xe0 && b[p + 3] <= 0xef) {
      this.videoPid = pid;
      if (rai) this.#onKeyframe(b, p);
    }
    if (this.gop) {
      this.gop.push(packet());
      this.gopBytes += PACKET;
      if (this.gopBytes > MAX_GOP_BYTES) this.gop = null; // no keyframes coming: start fresh at the next one
    }
  }

  #onKeyframe(b, p) {
    if (b[p + 7] & 0x80) {
      const pts = ((b[p + 9] >> 1) & 0x07) * 0x40000000 + b[p + 10] * 0x400000 + (b[p + 11] >> 1) * 0x8000 + b[p + 12] * 0x80 + (b[p + 13] >> 1);
      if (this.lastKeyAt !== null && pts > this.lastKeyAt) this.keyint = (pts - this.lastKeyAt) / 90000;
      this.lastKeyAt = pts;
    }
    this.gop = [];
    this.gopBytes = 0;
    if (this.state === 'connected' && !this.announced) {
      this.announced = true;
      this.emit('connected', { info: this.info });
    }
  }

  #attach(stdin) {
    stdin.on('error', () => {});
    if (!this.gop || !this.pat || !this.pmt || !this.proc || (this.state !== 'connected' && this.state !== 'live')) {
      stdin.end(); // OBS already left: the live segment ends at once
      return;
    }
    this.sink = stdin;
    this.#setState('live');
    // Start on the latest keyframe, tables first.
    this.#write(Buffer.concat([this.pat, this.pmt, ...this.gop]));
    stdin.once('close', () => {
      if (this.sink === stdin) this.sink = null;
    });
  }

  #write(data) {
    const s = this.sink;
    if (!s || s.destroyed || s.writableEnded) return;
    s.write(data); // live data can't wait: let Node buffer (the pacing lead is bounded)
  }

  #checkIdle() {
    if (!this.proc || !this.connectedAt || !this.lastDataAt) return;
    if ((Date.now() - this.lastDataAt) / 1000 > this.idleTimeout) {
      this.log(`no data from OBS for ${this.idleTimeout} s`);
      this.#kill('OBS stopped sending');
    }
  }

  #kill(reason, nextState = null) {
    const proc = this.proc;
    if (!proc) return;
    this.endReason = reason;
    this.nextState = nextState;
    terminate(proc);
    proc.stdout.destroy();
  }

  #onClose(proc, code) {
    if (this.proc !== proc) return;
    this.proc = null;
    const wasConnected = this.connectedAt !== null;
    const announced = this.announced;
    const seconds = wasConnected ? (Date.now() - this.connectedAt) / 1000 : 0;
    const reason = this.endReason ?? (wasConnected ? 'OBS stopped streaming' : `listener exited (code ${code})`);
    this.endReason = null;
    this.announced = false;
    this.connectedAt = null;
    const enabled = this.getConfig().obs.enabled;
    this.#setState(this.nextState ?? (this.closing || !enabled ? 'off' : 'listening'));
    this.nextState = null;
    // Listeners (the pipeline) must hear 'ended' BEFORE the live feed's stdin
    // ends, or the pipeline would put OBS straight back on air.
    if (announced) {
      this.log(`OBS ended after ${seconds.toFixed(0)} s: ${reason}`);
      this.emit('ended', { reason, seconds });
    } else if (!wasConnected && code !== 0 && code !== null && !this.closing) {
      this.log(`listener exited (code ${code}): ${this.lastError ?? 'no detail'}`);
    }
    const sink = this.sink;
    this.sink = null;
    sink?.end();
    this.#resetStream();
    if (this.closing || !enabled) return;
    // A listener that dies at once (port taken, bad build) must not spin.
    const quick = !wasConnected && code !== 0;
    setTimeout(() => this.#listen(), quick ? 15_000 : RELISTEN_DELAY).unref?.();
  }
}
