// Supervisor: keeps reality matching the user's intent.
//
// Owns `desired` (should we be streaming?) and turns pipeline events into
// recovery: reconnect with fast backoff (YouTube ends a go-live-now broadcast
// after 40–90 s offline; a scheduled one with Auto-stop OFF survived 3 min),
// a stall watchdog (FFmpeg can freeze without exiting), planned restarts for
// the FLV timestamp limit, and a saved resume point so a reboot carries on
// from the same file and second.
//
// High-level events for notifications:
//   started {}   stopped {reason}   dropped {reason, retryIn, attempt}
//   online {downtime, downSince}     frozen {idle, title}
//   failing {attempts, retryIn}      skipped {id, title, error}
//   waiting {problem}                 restarted {planned: true}

import { EventEmitter } from 'node:events';

// Plain-language reading of FFmpeg's error, for alerts and the panel.
export function hintFor(error) {
  if (!error) return null;
  if (/Input\/output error|Broken pipe|Connection reset|end of file/i.test(error)) {
    return 'YouTube refused the stream. Usually the stream key is wrong, or another encoder is already streaming with it.';
  }
  if (/Connection refused|timed out|Network is unreachable|resolve|No route|Connection to tcp:\/\/\S+ failed/i.test(error)) {
    return "Can't reach YouTube's servers — check this server's internet connection.";
  }
  return null;
}

const BACKOFF_CAP = 30; // seconds — keep reconnects well inside YouTube's patience
const IDLE_RETRY = 15; // seconds between tries while there's nothing to play
const HEALTHY_AFTER = 60; // a session this long resets the failure count
const HARD_RESTART_DAYS = 20; // FFmpeg's FLV timestamps wrap at ~24.8 days

// Minutes past midnight on the wall clock of `timeZone` (empty = the server's).
const zoneFormats = new Map();
export function clockMinutes(now, timeZone = '') {
  if (timeZone) {
    try {
      let f = zoneFormats.get(timeZone);
      if (!f) {
        f = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
        zoneFormats.set(timeZone, f);
      }
      const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
      return Number(p.hour) * 60 + Number(p.minute);
    } catch {} // unknown zone: fall back to the server's clock
  }
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

export class Supervisor extends EventEmitter {
  // state: JsonStore (data/state.json) — desired + resume survive reboots
  // preflight(): a reason we can't stream yet (e.g. no stream key), or null
  constructor({ pipeline, state, getConfig, preflight = () => null, stallTimeout = 30, log = () => {} }) {
    super();
    this.pipeline = pipeline;
    this.state = state;
    this.getConfig = getConfig;
    this.preflight = preflight;
    this.stallTimeout = stallTimeout;
    this.log = log;
    this.closing = false;
    this.phase = 'stopped'; // stopped | starting | live | reconnecting | waiting | stopping
    this.failures = 0;
    this.downSince = null;
    this.retryTimer = null;
    this.nextRetryAt = null;
    this.problem = null;
    this.announced = false; // 'started' sent for this run
    this.everLive = false; // got on air at least once this run
    this.lastError = null; // FFmpeg's reason for the current outage (key masked)
    this.offlineUntil = 0; // simulated outage (tests)

    pipeline.on('live', () => this.#onLive());
    pipeline.on('session-end', (e) => this.#onSessionEnd(e));
    pipeline.on('idle', ({ problem }) => {
      this.problem = problem;
    });
    pipeline.on('quarantine', (e) => this.emit('skipped', e));
    pipeline.on('on-air', () => this.#saveResume());
  }

  get desired() {
    return Boolean(this.state.data?.desired);
  }

  // Call once at boot: resumes streaming if it was on before.
  async boot() {
    this.watchdog = setInterval(() => this.#tick(), 1000);
    this.watchdog.unref?.();
    if (this.desired) {
      this.log('resuming stream after restart');
      this.#launch();
    }
  }

  async start() {
    if (this.desired && this.phase !== 'stopped') return this.status();
    await this.state.update((d) => {
      d.desired = true;
    });
    this.failures = 0;
    this.announced = false;
    this.everLive = false;
    this.lastError = null;
    this.#launch();
    return this.status();
  }

  async stop(reason = 'stopped from the panel') {
    await this.state.update((d) => {
      d.desired = false;
    });
    this.#clearRetry();
    if (this.pipeline.running) {
      this.phase = 'stopping';
      await this.pipeline.stop();
    }
    const wasOn = this.announced || this.downSince !== null;
    this.phase = 'stopped';
    this.downSince = null;
    this.problem = null;
    if (wasOn) this.emit('stopped', { reason });
    this.announced = false;
    return this.status();
  }

  skip() {
    return this.pipeline.skip();
  }

  restartNow() {
    return this.pipeline.plannedRestart();
  }

  // Go off air on purpose until release(): YouTube only auto-starts a
  // broadcast when its stream goes inactive -> active (youtube.js). A clean
  // cut, no alerts. Released automatically after `maxSeconds` as a safety.
  hold(reason, maxSeconds = 90) {
    if (!this.desired || !this.pipeline.running || this.held) return false;
    this.held = reason;
    this.holdTimer = setTimeout(() => this.release(), maxSeconds * 1000);
    this.holdTimer.unref?.();
    this.log(`pausing the stream: ${reason}`);
    this.pipeline.plannedRestart();
    return true;
  }

  release() {
    if (!this.held) return;
    clearTimeout(this.holdTimer);
    this.held = null;
    this.log('resuming the stream');
    this.#launch();
  }

  // Test hook: cut the connection and stay offline for `seconds`.
  simulateOutage(seconds) {
    this.offlineUntil = Date.now() + seconds * 1000;
    return this.pipeline.kill('drop');
  }

  // Called when the playlist may have become playable (media ready, mode change).
  poke() {
    if (this.desired && this.phase === 'waiting') {
      this.#clearRetry();
      this.#launch();
    }
  }

  status() {
    const outage = this.downSince !== null && this.lastError;
    return {
      desired: this.desired,
      phase: this.phase,
      problem: this.phase === 'waiting' ? this.problem : null,
      lastError: outage ? this.lastError : null,
      hint: outage ? hintFor(this.lastError) : null,
      everLive: this.everLive,
      downSince: this.downSince,
      nextRetryAt: this.nextRetryAt,
      failures: this.failures,
      ...this.pipeline.status(),
    };
  }

  close() {
    clearInterval(this.watchdog);
    this.#clearRetry();
  }

  // Service stop/restart: flush the stream cleanly but keep `desired`, so the
  // stream resumes on the next boot.
  async shutdown() {
    this.closing = true;
    this.close();
    if (this.pipeline.running) await this.pipeline.stop();
  }


  #launch() {
    this.nextRetryAt = null;
    if (this.pipeline.running || this.closing || this.held) return;
    const blocked = this.preflight();
    if (blocked) {
      this.problem = blocked;
      this.phase = 'waiting';
      this.emit('waiting', { problem: blocked });
      return this.#retryIn(IDLE_RETRY);
    }
    this.phase = this.downSince ? 'reconnecting' : 'starting';
    const started = this.pipeline.start({ resume: this.state.data?.resume ?? null });
    if (!started) {
      this.phase = 'waiting';
      this.emit('waiting', { problem: this.problem });
      this.#retryIn(IDLE_RETRY);
    }
  }

  #onLive() {
    this.phase = 'live';
    this.problem = null;
    this.everLive = true;
    this.lastError = null;
    if (!this.announced) {
      this.announced = true;
      this.emit('started', {});
    }
    if (this.downSince !== null) {
      const downtime = (Date.now() - this.downSince) / 1000;
      this.emit('online', { downtime, downSince: this.downSince });
      this.downSince = null;
    }
  }

  async #onSessionEnd({ intent, ranFor, resume, wentLive, error }) {
    if (resume) await this.#saveResume(resume);
    if (!this.desired || this.closing) return; // stop() / shutdown() handle the rest
    if (intent === 'planned' && this.held) {
      this.phase = 'waiting';
      this.problem = this.held;
      return; // release() relaunches
    }
    if (intent === 'planned') {
      this.log('planned restart');
      this.emit('restarted', { planned: true });
      return this.#launch();
    }
    if (intent === 'empty') {
      this.phase = 'waiting';
      this.emit('waiting', { problem: this.problem });
      return this.#retryIn(IDLE_RETRY);
    }
    const firstFailure = this.downSince === null;
    this.downSince ??= Date.now();
    this.lastError = error ?? this.lastError;
    this.phase = 'reconnecting';
    let delay;
    if (intent === 'drop') {
      delay = Math.max(0, (this.offlineUntil - Date.now()) / 1000);
    } else {
      if (ranFor > HEALTHY_AFTER) this.failures = 0;
      delay = Math.min(BACKOFF_CAP, 2 ** this.failures);
      this.failures++;
    }
    const reason = intent === 'stall' ? 'stream froze' : intent === 'drop' ? 'network outage (test)' : 'connection lost';
    const hint = hintFor(this.lastError);
    // One alert per outage, not one per retry.
    if (!this.everLive && !wentLive) {
      if (this.failures === 1) this.emit('cantConnect', { error: this.lastError, hint, retryIn: delay });
    } else if (firstFailure && intent !== 'stall') {
      this.emit('dropped', { reason, error: this.lastError, retryIn: delay, attempt: this.failures });
    }
    if (this.failures === 5) this.emit('failing', { attempts: this.failures, retryIn: delay, error: this.lastError, hint });
    this.#retryIn(delay);
  }

  #retryIn(seconds) {
    this.#clearRetry();
    this.nextRetryAt = Date.now() + seconds * 1000;
    this.retryTimer = setTimeout(() => this.#launch(), seconds * 1000);
  }

  #clearRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  async #saveResume(resume) {
    const r = resume ?? this.pipeline.status().onAir;
    if (!r || r.live) return; // OBS isn't a resume point
    const next = { id: r.id, pos: Math.floor(r.pos ?? r.position ?? 0) };
    const cur = this.state.data?.resume;
    if (cur && cur.id === next.id && Math.abs(cur.pos - next.pos) < 10) return;
    await this.state.update((d) => {
      d.resume = next;
    });
  }

  #tick() {
    const now = Date.now();
    // This runs every second. A much longer gap means this process itself was
    // frozen — laptop sleep, or a cloud host pausing the VM — not FFmpeg.
    const gap = this.lastTick ? (now - this.lastTick) / 1000 : 0;
    this.lastTick = now;
    if (gap > 15) this.pausedFor = gap;
    const p = this.pipeline;
    if (!this.desired || !p.running || p.ending) return;
    const idle = (now - p.lastAdvanceAt) / 1000;
    if (idle > this.stallTimeout) {
      const title = p.status().onAir?.title ?? null;
      const paused = this.pausedFor ?? null;
      this.pausedFor = null;
      this.log(paused ? `server was paused for ${paused.toFixed(0)} s — reconnecting` : `stall: no output for ${idle.toFixed(0)} s`);
      this.emit('frozen', { idle, title, paused });
      p.kill('stall');
      return;
    }
    this.pausedFor = null;
    if (now % 30_000 < 1000) this.#saveResume(); // keep the resume point fresh
    this.#maybePlannedRestart(now);
  }

  #maybePlannedRestart(now) {
    const startedAt = this.pipeline.status().sessionStartedAt;
    if (!startedAt) return;
    const days = (now - startedAt) / 86_400_000;
    const { everyDays, at, timeZone } = this.getConfig().restart;
    const [h, m] = at.split(':').map(Number);
    // Minutes since "at", wrapping past midnight (a 23:50 window runs to 00:20).
    const minutes = (clockMinutes(now, timeZone) - (h * 60 + m) + 1440) % 1440;
    const inWindow = minutes < 30;
    if ((days >= everyDays - 0.5 && inWindow) || days >= HARD_RESTART_DAYS) {
      this.log(`planned restart (session age ${days.toFixed(1)} days)`);
      this.pipeline.plannedRestart();
    }
  }
}
