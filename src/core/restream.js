// Multistream: the same stream to Twitch, Kick, Facebook or any RTMP(S)
// server alongside YouTube. Node copies the joined MPEG-TS that feeds the
// YouTube pusher into one small FFmpeg per destination (-c copy, almost no
// CPU; ~3 Mbps of upload each). Every destination connects, reconnects and
// fails on its own, so one platform's trouble never touches the others or
// YouTube. They follow the main stream: while it is off (or reconnecting to
// YouTube) they get no data. A new relay starts on a keyframe, tables first.
//
// Events: up {id, name, downtime}   down {id, name, error}

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { FFMPEG, terminate } from './ffmpeg.js';

export const PLATFORMS = {
  twitch: { name: 'Twitch', url: 'rtmp://live.twitch.tv/app' },
  // Tested with Kick: its page shows the URL without "/app"; this form works.
  kick: { name: 'Kick', url: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app' },
  facebook: { name: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp' },
  custom: { name: 'Custom', url: '' },
};
export const MAX_DESTINATIONS = 5;

const PACKET = 188;
const MAX_BACKLOG = 16 * 1024 * 1024; // bytes queued for a relay before it counts as stuck
const CONNECT_TIMEOUT = 30_000;
const STALL_TIMEOUT = 30_000;
const HEALTHY_AFTER = 60_000;
const BACKOFF = [2, 4, 8, 16, 30];
const MAX_RUN_DAYS = 20; // FLV timestamps wrap at ~24.8 days

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

// The full ingest address: server URL + key.
export function destUrl(d) {
  return `${d.url.replace(/\/+$/, '')}/${d.key}`;
}

// Checks and cleans a destination from the API. `existing`: what it replaces.
export function cleanDestination(input, existing = null) {
  const d = { ...(existing ?? { id: randomBytes(4).toString('hex'), enabled: true }) };
  if (input.platform !== undefined) {
    if (!PLATFORMS[input.platform]) throw badRequest(`platform must be one of ${Object.keys(PLATFORMS).join(', ')}`);
    d.platform = input.platform;
  }
  if (!d.platform) throw badRequest('platform is required');
  if (input.name !== undefined || !d.name) {
    const name = String(input.name ?? PLATFORMS[d.platform].name).trim().slice(0, 40);
    d.name = name || PLATFORMS[d.platform].name;
  }
  if (input.url !== undefined || !d.url) {
    const url = String(input.url ?? PLATFORMS[d.platform].url).trim();
    if (!/^rtmps?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) throw badRequest('Server URL must start with rtmp:// or rtmps://');
    d.url = url;
  }
  if (input.key !== undefined) {
    const key = String(input.key).trim();
    if (!/^[^\s]{4,512}$/.test(key)) throw badRequest('Paste the stream key (no spaces)');
    d.key = key;
  }
  if (!d.key) throw badRequest('A stream key is required');
  if (input.enabled !== undefined) d.enabled = Boolean(input.enabled);
  return d;
}

export class Restream extends EventEmitter {
  // getConfig(): config with .restream.destinations. bin: FFmpeg path (tests).
  constructor({ getConfig, log = () => {}, bin = FFMPEG }) {
    super();
    this.getConfig = getConfig;
    this.log = log;
    this.bin = bin;
    this.relays = new Map(); // id -> relay state
    this.pat = null;
    this.pmt = null;
    this.pmtPid = null;
    this.closing = false;
    this.watchdog = setInterval(() => this.#check(), 5000);
    this.watchdog.unref?.();
    this.apply();
  }

  // Sync relays with the saved destinations (added, removed, changed).
  apply() {
    const dests = this.getConfig().restream.destinations;
    const ids = new Set(dests.map((d) => d.id));
    for (const [id, r] of this.relays) {
      if (!ids.has(id)) {
        this.#stopRelay(r);
        this.relays.delete(id);
      }
    }
    for (const d of dests) {
      const r = this.relays.get(d.id);
      if (!r) {
        this.relays.set(d.id, { dest: d, proc: null, state: d.enabled ? 'waiting' : 'off', since: Date.now(), lastError: null, failures: 0, retryTimer: null, wasLive: false, downSince: null });
        continue;
      }
      const changed = destUrl(r.dest) !== destUrl(d);
      r.dest = d;
      if (!d.enabled) this.#stopRelay(r, 'off');
      else if (changed) this.#stopRelay(r, 'waiting');
      else if (r.state === 'off') this.#setState(r, 'waiting');
    }
  }

  status() {
    return [...this.relays.values()].map((r) => ({
      id: r.dest.id, name: r.dest.name, platform: r.dest.platform, enabled: r.dest.enabled,
      state: r.state, since: r.since, lastError: r.lastError,
    }));
  }

  // Every chunk of the joined stream (whole TS packets), as it goes to YouTube.
  feed(buf) {
    if (this.closing || !this.relays.size) return;
    const keyAt = this.#scan(buf);
    for (const r of this.relays.values()) {
      if (!r.dest.enabled || r.retryTimer) continue;
      if (!r.proc) {
        if (keyAt >= 0 && this.pat && this.pmt) this.#spawn(r, Buffer.concat([this.pat, this.pmt, buf.subarray(keyAt)]));
        continue;
      }
      const stdin = r.proc.stdin;
      if (stdin.destroyed || stdin.writableEnded) continue;
      if (stdin.writableLength > MAX_BACKLOG) {
        this.#fail(r, 'Not keeping up (the connection to this platform is too slow)');
        continue;
      }
      stdin.write(buf);
      r.wroteAt = Date.now();
    }
  }

  // The main stream stopped: flush and close every relay.
  stopAll() {
    for (const r of this.relays.values()) this.#stopRelay(r, r.dest.enabled ? 'waiting' : 'off');
  }

  // Planned restart: fresh relays (timestamps), they rejoin at the next keyframe.
  restartAll() {
    for (const r of this.relays.values()) if (r.proc) this.#stopRelay(r, 'waiting');
  }

  close() {
    this.closing = true;
    clearInterval(this.watchdog);
    for (const r of this.relays.values()) this.#stopRelay(r, 'off');
  }


  // Cache PAT/PMT; return the byte offset of the first video keyframe, or -1.
  #scan(b) {
    let keyAt = -1;
    for (let o = 0; o + PACKET <= b.length; o += PACKET) {
      if (b[o] !== 0x47 || !(b[o + 1] & 0x40)) continue; // only payload starts matter
      const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
      const afc = (b[o + 3] >> 4) & 0x3;
      let p = o + 4;
      let rai = false;
      if (afc & 0x2) {
        rai = b[o + 4] > 0 && (b[o + 5] & 0x40) !== 0;
        p += 1 + b[o + 4];
      }
      if (pid === 0) {
        this.pat = Buffer.from(b.subarray(o, o + PACKET));
        const s = p + 1 + b[p];
        if (s + 12 <= o + PACKET) this.pmtPid = ((b[s + 10] & 0x1f) << 8) | b[s + 11];
      } else if (pid === this.pmtPid) {
        this.pmt = Buffer.from(b.subarray(o, o + PACKET));
      } else if (keyAt < 0 && rai && p + 4 <= o + PACKET && b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 1 && b[p + 3] >= 0xe0 && b[p + 3] <= 0xef) {
        keyAt = o;
      }
    }
    return keyAt;
  }

  #spawn(r, first) {
    const url = destUrl(r.dest);
    const masked = `${r.dest.url.replace(/\/+$/, '')}/***`;
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-nostats',
      '-progress', 'pipe:1', '-stats_period', '2',
      // Our own joiner's output, always the same layout: a short probe.
      '-probesize', '131072', '-analyzeduration', '500000',
      '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0', '-c', 'copy', '-flvflags', 'no_duration_filesize',
      '-f', 'flv', url,
    ];
    const proc = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    r.proc = proc;
    r.startedAt = Date.now();
    r.wroteAt = Date.now();
    r.outAt = null;
    r.lastOut = 0;
    this.#setState(r, 'connecting');
    this.log(`${r.dest.name}: connecting to ${masked}`);
    proc.on('error', (err) => {
      r.lastError = err.message;
    });
    proc.stdin.on('error', () => {});
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      // A relay being stopped still prints its last progress: not "live" again.
      if (r.proc !== proc || !line.startsWith('out_time_us=')) return;
      const t = Number(line.slice(12));
      if (!Number.isFinite(t) || t <= r.lastOut) return;
      r.lastOut = t;
      r.outAt = Date.now();
      if (r.state !== 'live') this.#onLive(r);
    });
    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      if (r.proc !== proc) return;
      if (/error|failed|refused|denied|invalid|timed out|unauthori|forbidden|not found/i.test(line)) {
        r.lastError = line.split(url).join(masked).replace(/^\[[^\]]+\]\s*/, '').slice(0, 300);
      }
    });
    proc.on('close', (code) => this.#onClose(r, proc, code));
    proc.stdin.write(first);
  }

  #onLive(r) {
    this.#setState(r, 'live');
    r.lastError = null;
    this.log(`${r.dest.name}: live`);
    if (r.downSince) {
      this.emit('up', { id: r.dest.id, name: r.dest.name, downtime: (Date.now() - r.downSince) / 1000 });
      r.downSince = null;
    }
    r.wasLive = true;
  }

  #onClose(r, proc, code) {
    if (r.proc !== proc) return; // a deliberate stop already let go of it
    r.proc = null;
    const ranFor = Date.now() - r.startedAt;
    if (!r.dest.enabled || this.closing) return this.#setState(r, 'off');
    if (ranFor > HEALTHY_AFTER && r.state === 'live') r.failures = 0;
    const delay = BACKOFF[Math.min(r.failures, BACKOFF.length - 1)];
    r.failures++;
    if (r.wasLive && !r.downSince) {
      r.downSince = Date.now();
      this.emit('down', { id: r.dest.id, name: r.dest.name, error: r.lastError });
    }
    this.log(`${r.dest.name}: disconnected (code ${code})${r.lastError ? `: ${r.lastError}` : ''}, retrying in ${delay} s`);
    this.#setState(r, 'retrying');
    r.retryTimer = setTimeout(() => {
      r.retryTimer = null;
      if (r.dest.enabled && r.state === 'retrying') this.#setState(r, 'waiting'); // respawns at the next keyframe
    }, delay * 1000);
    r.retryTimer.unref?.();
  }

  #fail(r, reason) {
    r.lastError = reason;
    if (r.proc) terminate(r.proc);
  }

  // Deliberate stop: flush (end of input), then make sure it exits.
  #stopRelay(r, state = 'off') {
    clearTimeout(r.retryTimer);
    r.retryTimer = null;
    if (r.proc) {
      const proc = r.proc;
      r.proc = null;
      proc.stdin.end();
      setTimeout(() => terminate(proc), 3000).unref?.();
    }
    this.#setState(r, state);
  }

  #setState(r, state) {
    if (r.state === state) return;
    r.state = state;
    r.since = Date.now();
  }

  #check() {
    const now = Date.now();
    for (const r of this.relays.values()) {
      if (!r.proc) continue;
      if (r.state === 'connecting' && now - r.startedAt > CONNECT_TIMEOUT) {
        this.#fail(r, r.lastError ?? 'Could not connect to this platform');
      } else if (r.state === 'live' && now - (r.outAt ?? 0) > STALL_TIMEOUT && now - r.wroteAt < 5000) {
        this.#fail(r, 'Stopped sending (stalled)');
      } else if (now - r.startedAt > MAX_RUN_DAYS * 86_400_000) {
        this.#stopRelay(r, 'waiting'); // fresh timestamps
      }
    }
  }
}
