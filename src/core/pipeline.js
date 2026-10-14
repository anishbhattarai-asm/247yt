// Pipeline: Node feeds one file at a time into ONE long-running FFmpeg that
// holds the connection to YouTube. Every mechanism here was first proven in
// a standalone test harness against real YouTube.
//
//   feeder (per file):  ffmpeg <inputs> -c copy -output_ts_offset T -f mpegts pipe:1
//   Node (TsJoiner):    whole packets, continuity counters, timestamps, clean
//                       cuts, per-packet pacing against the wall clock
//   pusher (session):   ffmpeg -f mpegts -i pipe:0 -c copy -f flv <rtmp>
//
// Pacing is Node's job, by the wall clock (Date.now(), kept right by NTP).
// FFmpeg's -re paces by the monotonic clock instead, and on WSL that clock was
// measured running 0.7% slow: the stream fell ~25 s/hour behind real time
// and YouTube reported "not receiving enough video". Node releases media at
// most `maxLead` seconds ahead of real time, and the pusher sends whatever it
// gets at once, so the output tracks real time and catches up after any gap.
//
// The pipeline runs ONE session (one pusher) at a time and reports what
// happened. Deciding whether and when to start the next session — desired
// state, backoff, stall watchdog, planned restarts — is the Supervisor's job.
//
// Events:
//   session-start {session}            live {session}
//   on-air {id, title, outTime}        boundary {id, reason, sent, nextT, lead, lag}
//   feeder-failed {id, attempt, error} quarantine {id, title, error}
//   warning {text}                     idle {problem}
//   live-end {seconds}                 (OBS's segment finished)
//   session-end {session, intent, code, signal, ranFor, resume, wentLive, error}
//     intent: 'stop' | 'planned' | 'stall' | 'drop' | 'empty' | null (crash)
//     error: FFmpeg's first error line, stream key masked

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { FFMPEG, terminate } from './ffmpeg.js';
import { GOP_SECONDS } from './normalizer.js';
import { TsJoiner } from './ts.js';

const GAP = 0.1; // seconds between one file's last PTS and the next file's first DTS
// After a feeder dies mid-file, where its last audio PES ends is unknown; with
// -muxdelay 0.1 one audio PES spans at most ~0.05 s, so leave 0.1 s.
const CRASH_MARGIN = 0.1;
const STARTUP_LEAD = 6; // the pusher probes ~5 s of input before it starts sending
const WARN = /non[- ]?monoton|invalid.*dts|dts.*invalid|corrupt|discontinu|out of order|backward|error|invalid/i;

const snap = (pos) => Math.floor(Math.max(0, pos) / GOP_SECONDS) * GOP_SECONDS;

export class Pipeline extends EventEmitter {
  // playlist: { next(afterId), resolve(id), problem() }
  // getDest(session): { url, format } — rtmp URL, or a file path in tests
  // onQuarantine(id, error): persist it (awaited before the next file starts,
  //   so the playlist can't hand the same broken file straight back)
  constructor({ playlist, getDest, onQuarantine = async () => {}, maxLead = 1.5, log = () => {} }) {
    super();
    this.playlist = playlist;
    this.getDest = getDest;
    this.onQuarantine = onQuarantine;
    this.maxLead = maxLead;
    this.log = log;
    this.session = 0;
    this.pusher = null;
    this.feeder = null;
    this.cur = null; // { seg, seek } — what the next feeder plays
    this.live = null; // OBS's segment while OBS is connected (see ingest.js)
    this.afterLive = null; // { id, seek }: where the playlist was cut for OBS
    this.T = 0; // -output_ts_offset for the next feeder
    this.failures = new Map();
    this.stats = { boundaries: 0, maxLag: 0, lag: 0, maxLead: 0 };
  }

  get running() {
    return Boolean(this.pusher);
  }

  get lastAdvanceAt() {
    return this.pusher?.lastAdvanceAt ?? null;
  }

  // A stop, restart or kill is already under way for the current session.
  get ending() {
    return Boolean(this.pusher?.intent);
  }

  // Start a session. resume: { id, pos } from the last session-end, or null.
  start({ resume = null } = {}) {
    if (this.pusher) throw new Error('pipeline already running');
    if (this.live) {
      // OBS is on: the new session goes straight back to it.
      this.cur = { seg: this.live, seek: 0 };
      this.#startPusher();
      return true;
    }
    const problem = this.playlist.problem();
    if (problem) {
      this.emit('idle', { problem });
      return false;
    }
    let seg = resume ? this.playlist.resolve(resume.id) : null;
    let seek = seg ? snap(resume.pos) : 0;
    if (!seg) {
      seg = this.playlist.next(resume?.id ?? null);
      seek = 0;
    }
    if (!seg) {
      this.emit('idle', { problem: 'Nothing to play' });
      return false;
    }
    this.cur = { seg, seek };
    this.#startPusher();
    return true;
  }

  // Skip to the next file: cut at the next clean point, no dropout.
  // false only when not streaming (or stopping/restarting). Between files, or
  // with a skip already under way, the current file has ended — that's done.
  skip() {
    const p = this.pusher;
    if (!p || p.intent) return false;
    const f = this.feeder;
    if (f?.seg.live) return false; // OBS ends when OBS stops streaming
    if (!f || f.intent) return true;
    this.log(`skip requested: ${f.seg.title}`);
    f.draining = true; // lift the lead limit so the cut lands on the next frame
    clearTimeout(f.paceTimer);
    f.paceTimer = null;
    f.joiner.requestCut();
    this.#pump(this.pusher, f);
    return true;
  }

  // OBS went live: cut the current file at the next clean point and play
  // `seg` (from ingest.segment()) until endLive(); then the playlist carries
  // on from where it was cut. No pusher restart, so viewers see one stream.
  takeover(seg) {
    this.live = seg;
    const f = this.feeder;
    if (!f || f.intent || f.seg.live) return; // between files: #startFeeder picks it up
    this.log(`OBS takeover: cutting ${f.seg.title}`);
    f.takeover = true;
    f.draining = true;
    clearTimeout(f.paceTimer);
    f.paceTimer = null;
    f.joiner.requestCut();
    this.#pump(this.pusher, f);
  }

  // OBS left. Its feeder ends by itself when the ingest closes its input.
  endLive() {
    this.live = null;
  }

  // Clean restart of the pusher (FLV timestamp limit). Viewers don't notice.
  plannedRestart() {
    if (!this.pusher || this.pusher.intent) return false;
    this.pusher.intent = 'planned';
    this.#cutAndEnd(this.pusher);
    return true;
  }

  // Stop on purpose: cut cleanly, let the pusher flush. Resolves when closed.
  stop() {
    const p = this.pusher;
    if (!p) return Promise.resolve();
    const closed = new Promise((r) => this.once('session-end', r));
    if (!p.intent || p.intent === 'planned') {
      p.intent = 'stop';
      this.#cutAndEnd(p);
    }
    return closed;
  }

  // Hard kill (stall watchdog, simulated outage). session-end follows.
  kill(intent) {
    const p = this.pusher;
    if (!p) return false;
    p.intent = intent;
    terminate(p.proc);
    return true;
  }

  status() {
    const p = this.pusher;
    const air = p && this.#onAirAt(p, p.lastOut);
    return {
      running: Boolean(p),
      live: Boolean(p?.baseWall !== null && p),
      session: this.session,
      sessionStartedAt: p?.startedAt ?? null,
      outTime: p?.lastOut ?? null,
      onAir: air ? { id: air.seg.id, title: air.seg.title, position: Math.max(0, air.pos), live: Boolean(air.seg.live) } : null,
      feeding: this.feeder ? { id: this.feeder.seg.id, title: this.feeder.seg.title } : null,
      lag: this.stats.lag,
      boundaries: this.stats.boundaries,
    };
  }

  // ------------------------------------------------------------ pusher

  #startPusher() {
    this.session++;
    const dest = this.getDest(this.session);
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-nostats', '-y',
      '-progress', 'pipe:1', '-stats_period', '1',
      '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0', '-c', 'copy',
      '-flvflags', 'no_duration_filesize',
      '-f', dest.format || 'flv', dest.url,
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const p = {
      proc, joiner: new TsJoiner(), startedAt: Date.now(), lastAdvanceAt: Date.now(),
      lastOut: 0, baseWall: null, intent: null, T0: null, segments: [], onAir: null, handoff: null,
      ending: false, error: null,
    };
    // FFmpeg's errors quote the destination URL, stream key included.
    const masked = dest.url.replace(/[^/]+$/, '***');
    const safe = (line) => line.split(dest.url).join(masked);
    this.pusher = p;
    this.log(`pusher started (session ${this.session})`);
    this.emit('session-start', { session: this.session });

    proc.on('error', (err) => this.log(`pusher spawn error: ${err.message}`));
    proc.stdin.on('error', () => {}); // EPIPE/EOF when the pusher dies; 'close' handles it
    readline.createInterface({ input: proc.stdout }).on('line', (l) => this.#onProgress(p, l));
    readline.createInterface({ input: proc.stderr }).on('line', (l) => {
      this.log(`ffmpeg: ${l}`);
      if (WARN.test(l)) this.emit('warning', { text: safe(l) });
      // Keep the first real error of the session: it names the cause.
      if (!p.error && /error|denied|refused|not found|timed out/i.test(l)) p.error = safe(l).replace(/^\[[^\]]+\]\s*/, '');
    });
    proc.on('close', (code, signal) => this.#onPusherClose(p, code, signal));
    this.#startFeeder();
  }

  #onAirAt(p, outPos) {
    let seg = null;
    for (const s of p.segments) {
      if (s.start <= outPos) seg = s;
      else break;
    }
    return seg && { seg: seg.seg, pos: seg.seek + (outPos - seg.start) };
  }

  #onProgress(p, line) {
    const eq = line.indexOf('=');
    if (line.slice(0, eq) !== 'out_time_us') return;
    const s = Number(line.slice(eq + 1)) / 1e6;
    if (!Number.isFinite(s) || s <= p.lastOut + 0.001) return;
    const now = Date.now();
    if (p.baseWall === null) {
      p.baseWall = now - s * 1000;
      this.emit('live', { session: this.session });
    }
    p.lastOut = s;
    p.lastAdvanceAt = now;
    // Output vs wall clock: about -maxLead (ahead) when healthy; positive =
    // behind real time (a gap the pacing is catching up on).
    this.stats.lag = (now - p.baseWall) / 1000 - s;
    this.stats.maxLag = Math.max(this.stats.maxLag, this.stats.lag);
    const air = this.#onAirAt(p, s);
    if (air && air.seg.id !== p.onAir) {
      p.onAir = air.seg.id;
      this.emit('on-air', { id: air.seg.id, title: air.seg.title, outTime: s });
    }
  }

  #onPusherClose(p, code, signal) {
    if (this.pusher !== p) return;
    this.pusher = null;
    const ranFor = (Date.now() - p.startedAt) / 1000;
    // Resume from what viewers last saw: anything still in the dead pusher's
    // buffers never went out.
    const air = p.handoff ?? this.#onAirAt(p, p.lastOut);
    const f = this.feeder;
    if (f) {
      f.intent = 'restart';
      this.#killFeeder(f);
      this.feeder = null;
    }
    // OBS isn't a resume point: the file it interrupted is.
    const resume = air && !air.seg.live ? { id: air.seg.id, pos: snap(air.pos) }
      : this.afterLive ? { id: this.afterLive.id, pos: this.afterLive.seek }
        : this.cur && !this.cur.seg.live ? { id: this.cur.seg.id, pos: snap(this.cur.seek) } : null;
    this.cur = null;
    this.log(`pusher exited (session ${this.session}, intent ${p.intent ?? 'none'}, code ${code}, ${ranFor.toFixed(0)} s)`);
    const wentLive = p.baseWall !== null;
    this.emit('session-end', { session: this.session, intent: p.intent, code, signal, ranFor, resume, wentLive, error: p.error });
  }

  #endPusher(p) {
    if (p.ending) return;
    p.ending = true;
    if (this.feeder && !this.feeder.intent) {
      this.feeder.intent = 'restart';
      this.#killFeeder(this.feeder);
    }
    p.proc.stdin.end(); // lets ffmpeg flush and close the output cleanly
    setTimeout(() => terminate(p.proc), 5000).unref();
  }

  // Stop at the next clean cut point, then end the pusher.
  #cutAndEnd(p) {
    const f = this.feeder;
    if (!f || f.intent) return this.#endPusher(p);
    f.draining = true;
    clearTimeout(f.paceTimer);
    f.paceTimer = null;
    f.joiner.requestCut();
    this.#pump(p, f);
    setTimeout(() => this.#endPusher(p), 3000).unref(); // in case the feeder ends first
  }

  // ------------------------------------------------------------ feeder

  #startFeeder() {
    const p = this.pusher;
    if (!p || this.feeder) return;
    if (p.intent) return this.#endPusher(p); // a file ended while a restart/stop was pending
    if (!this.cur && this.live) {
      this.cur = { seg: this.live, seek: 0 };
    } else if (!this.cur && this.afterLive) {
      // Back from OBS: the interrupted file, if it can still play.
      const seg = this.playlist.resolve(this.afterLive.id);
      if (seg) this.cur = { seg, seek: this.afterLive.seek };
      this.afterLive = null;
    }
    if (!this.cur) {
      const seg = this.playlist.next(this.lastSegmentId ?? null);
      if (!seg) {
        const problem = this.playlist.problem() ?? 'Nothing to play';
        this.log(`nothing to play: ${problem}`);
        this.emit('idle', { problem });
        p.intent = 'empty';
        return this.#endPusher(p);
      }
      this.cur = { seg, seek: 0 };
    }
    const { seg, seek } = this.cur;
    const joiner = p.joiner;
    joiner.beginSegment();
    if (p.T0 === null) p.T0 = this.T;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...seg.inputArgs(seek),
      '-c', 'copy',
      '-output_ts_offset', this.T.toFixed(6),
      // Small audio PES: a skip's audio catch-up overshoots the video end less.
      '-pes_payload_size', '0', '-muxdelay', '0.1',
      '-f', 'mpegts', 'pipe:1',
    ];
    const proc = spawn(FFMPEG, args, { stdio: [seg.live ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const f = {
      proc, seg, seek, T: this.T, joiner, intent: null, frozen: false, draining: false,
      waitingDrain: false, paceTimer: null, stderr: '', exit: null, closed: false, takeover: false,
    };
    this.feeder = f;
    p.segments.push({ seg, seek, start: f.T - p.T0 });
    this.log(`feed ${seg.title}${seek ? ` from ${seek}s` : ''}`);
    proc.on('error', (err) => this.log(`feeder spawn error: ${err.message}`));
    if (seg.live) seg.attach(proc.stdin);
    proc.stdout.on('data', (chunk) => this.#pump(p, f, chunk));
    proc.stderr.on('data', (d) => {
      f.stderr = (f.stderr + d).slice(-2000);
    });
    proc.on('close', (code, signal) => {
      // Packets held back by pacing still belong to this file: send them first.
      if (f.intent || !joiner.hasPending()) return this.#onFeederClose(f, code, signal);
      f.exit = { code, signal };
      if (!f.paceTimer) this.#pump(p, f);
    });
  }

  // How far into this segment the feed may go right now (seconds), or null.
  #limitFor(p, f) {
    if (f.draining) return null;
    const segStart = f.T - p.T0;
    if (p.baseWall === null) return STARTUP_LEAD - segStart;
    const out = Math.min((Date.now() - p.baseWall) / 1000, p.lastOut + 1);
    this.stats.maxLead = Math.max(this.stats.maxLead, segStart + f.joiner.span() - out);
    return out + this.maxLead - segStart;
  }

  #maybeResume(f) {
    if (!f.frozen && !f.waitingDrain && !f.paceTimer && !f.intent && !f.joiner.held) f.proc.stdout.resume();
  }

  // Moves feeder output into the pusher, holding anything past the lead limit.
  #pump(p, f, chunk) {
    if (f.frozen || f.intent) return;
    f.joiner.limit = this.#limitFor(p, f);
    const out = f.joiner.push(chunk);
    if (out && this.pusher === p && !p.proc.stdin.destroyed && !p.proc.stdin.writableEnded) {
      if (!p.proc.stdin.write(out)) {
        f.waitingDrain = true;
        f.proc.stdout.pause();
        p.proc.stdin.once('drain', () => {
          f.waitingDrain = false;
          this.#maybeResume(f);
        });
      }
    }
    if (f.joiner.cutDone) return this.#onCut(p, f);
    if (f.joiner.held) {
      f.proc.stdout.pause();
      f.paceTimer ??= setTimeout(() => {
        f.paceTimer = null;
        this.#pump(p, f);
      }, 200);
      return;
    }
    if (f.exit) return this.#onFeederClose(f, f.exit.code, f.exit.signal); // backlog sent
    this.#maybeResume(f);
  }

  // The joiner reached a clean cut point: a skip, a planned restart, or a stop.
  #onCut(p, f) {
    if (f.intent) return;
    if (p.intent === 'planned' || p.intent === 'stop') {
      // Everything fed goes out (the pusher flushes on stdin end), so the next
      // session picks up right where this cut happened.
      p.handoff = { seg: f.seg, pos: f.seek + f.joiner.span() };
      f.intent = 'restart';
      this.#endFeeder(f);
      this.#endPusher(p);
    } else {
      f.intent = 'skip';
      this.#endFeeder(f);
    }
  }

  // Its stdout may be paused with unread data (pacing), and Node only fires
  // 'close' once that stream ends — so destroy the stream too.
  #killFeeder(f) {
    terminate(f.proc);
    f.proc.stdout.destroy();
  }

  #endFeeder(f) {
    if (f.exit) this.#onFeederClose(f, f.exit.code, f.exit.signal);
    else this.#killFeeder(f);
  }

  #onFeederClose(f, code, signal) {
    if (f.closed) return;
    f.closed = true;
    if (this.feeder === f) this.feeder = null;
    clearTimeout(f.paceTimer);
    const p = this.pusher;
    if (f.intent === 'restart' || !p) return; // the pusher's end owns what's next

    const span = f.joiner.span();
    const sent = f.joiner.packets;
    if (f.seg.live) {
      // OBS stopped, its feed broke, or a cut: back to the playlist either way.
      if (sent > 0) this.T = f.T + span + GAP + (code === 0 || f.intent ? 0 : CRASH_MARGIN);
      else this.live = null; // got nothing at all: don't spin on a dead input
      this.stats.boundaries++;
      this.cur = null;
      this.log(`OBS segment ended after ${span.toFixed(0)} s`);
      this.emit('live-end', { seconds: span });
      return this.#startFeeder();
    }
    if (f.takeover) this.afterLive = { id: f.seg.id, seek: snap(f.seek + span) };
    if (f.intent === 'skip' || (code === 0 && sent > 0)) {
      this.T = f.T + span + GAP;
      this.stats.boundaries++;
      this.failures.delete(f.seg.id);
      const lead = p.baseWall ? this.T - p.T0 - p.lastOut : null;
      this.emit('boundary', { id: f.seg.id, reason: f.intent === 'skip' ? 'skip' : 'end', sent: f.seek + span, nextT: this.T, lead, lag: this.stats.lag });
      this.lastSegmentId = f.seg.id;
      this.cur = null;
    } else {
      const n = (this.failures.get(f.seg.id) || 0) + 1;
      this.failures.set(f.seg.id, n);
      if (sent > 0) this.T = f.T + span + GAP + CRASH_MARGIN;
      const error = f.stderr.trim().split('\n').pop() || `exit ${code ?? signal}`;
      this.log(`feeder failed: ${f.seg.title} (attempt ${n}): ${error}`);
      this.emit('feeder-failed', { id: f.seg.id, attempt: n, error });
      if (n >= 2) {
        this.failures.delete(f.seg.id);
        this.emit('quarantine', { id: f.seg.id, title: f.seg.title, error });
        this.lastSegmentId = f.seg.id;
        this.cur = null;
        Promise.resolve(this.onQuarantine(f.seg.id, error))
          .catch((err) => this.log(`quarantine save failed: ${err.message}`))
          .finally(() => this.#startFeeder());
        return;
      } else {
        this.cur = { seg: f.seg, seek: snap(f.seek + span) }; // retry from where it died
      }
    }
    this.#startFeeder();
  }
}
