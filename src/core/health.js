// Health: the external heartbeat plus resource watchers.
//
// Healthchecks.io rule — "reality matches intent": ping OK when the user wants
// the stream on and frames are flowing, or wants it off and the backend is up.
// Otherwise ping /fail with the reason. If pings stop entirely (VM dead,
// network cut, Oracle stopped the instance), Healthchecks alerts on its own —
// the one failure this box can't report itself.
//
// Also: low-disk and sustained-high-CPU alerts (with cooldowns), and a
// month-to-date egress estimate (stream bitrate x seconds live).

const ALERT_COOLDOWN = 6 * 3600_000;
const HIGH_CPU = 90; // percent
const HIGH_CPU_MINUTES = 10;
const kbps = (b) => Number(String(b).replace(/k$/, ''));

export class Health {
  constructor({ getConfig, supervisor, stats, notifier, state, log = () => {} }) {
    this.getConfig = getConfig;
    this.supervisor = supervisor;
    this.stats = stats;
    this.notifier = notifier;
    this.state = state;
    this.log = log;
    this.lastPing = { at: null, ok: null, error: null };
    this.lastAlert = { lowDisk: 0, highCpu: 0 };
    this.cpuHighSince = null;
    this.lastPingAt = 0;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => this.log(`health: ${err.message}`)), 60_000);
    this.timer.unref?.();
    setTimeout(() => this.tick().catch(() => {}), 5000).unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  // Does what's happening match what the user asked for?
  verdict() {
    const s = this.supervisor.status();
    if (!s.desired) return { ok: true, reason: 'stopped on purpose; backend alive' };
    if (s.phase === 'live' && s.outTime !== null) return { ok: true, reason: 'streaming' };
    if (s.phase === 'waiting') return { ok: false, reason: `waiting: ${s.problem ?? 'nothing to play'}` };
    return { ok: false, reason: `should be streaming but ${s.phase}` };
  }

  async tick(now = Date.now()) {
    const cfg = this.getConfig();
    const s = this.supervisor.status();
    if (s.phase === 'live') await this.#countEgress(cfg, now);

    const cpu = this.stats.sampleCpu();
    if (cpu >= HIGH_CPU) {
      this.cpuHighSince ??= now;
      const minutes = (now - this.cpuHighSince) / 60_000;
      if (minutes >= HIGH_CPU_MINUTES) this.#alert('highCpu', now, () => this.notifier.highCpu({ percent: cpu, minutes: Math.round(minutes) }));
    } else {
      this.cpuHighSince = null;
    }

    const disk = await this.stats.disk().catch(() => null);
    const min = cfg.limits.minFreeDiskBytes;
    if (disk && disk.freeBytes < min * 1.5) {
      this.#alert('lowDisk', now, () => this.notifier.lowDisk({ freeGB: disk.freeBytes / 1024 ** 3, minGB: min / 1024 ** 3 }));
    }

    if (cfg.healthcheck.url && now - this.lastPingAt >= cfg.healthcheck.intervalMinutes * 60_000 - 5000) {
      this.lastPingAt = now;
      await this.ping(cfg.healthcheck.url);
    }
  }

  async ping(url) {
    const v = this.verdict();
    const target = v.ok ? url : `${url.replace(/\/$/, '')}/fail`;
    try {
      const res = await fetch(target, { method: 'POST', body: v.reason, signal: AbortSignal.timeout(10_000) });
      this.lastPing = { at: Date.now(), ok: v.ok && res.ok, error: res.ok ? null : `HTTP ${res.status}`, reason: v.reason };
    } catch (err) {
      this.lastPing = { at: Date.now(), ok: false, error: err.message, reason: v.reason };
    }
    return this.lastPing;
  }

  status() {
    const month = this.state.data?.egress;
    const cfg = this.getConfig();
    const rate = (kbps(cfg.profile.videoBitrate) + kbps(cfg.profile.audioBitrate)) * 1000;
    return {
      healthcheck: { configured: Boolean(cfg.healthcheck.url), ...this.lastPing },
      verdict: this.verdict(),
      egress: month ? { month: month.month, gb: (month.seconds * rate) / 8 / 1e9 } : null,
    };
  }

  #alert(kind, now, send) {
    if (now - this.lastAlert[kind] < ALERT_COOLDOWN) return;
    this.lastAlert[kind] = now;
    send();
  }

  async #countEgress(cfg, now) {
    const month = new Date(now).toISOString().slice(0, 7);
    await this.state.update((d) => {
      if (d.egress?.month !== month) d.egress = { month, seconds: 0 };
      d.egress.seconds += 60;
    });
  }
}
