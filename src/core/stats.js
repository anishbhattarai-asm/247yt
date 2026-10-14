// System stats for the status view and the health watchers.

import { statfs } from 'node:fs/promises';
import os from 'node:os';

export class Stats {
  constructor({ mediaDir }) {
    this.mediaDir = mediaDir;
    this.prev = sampleCpu(); // health's one-minute window
    this.cpu = 0;
    this.ui = { prev: sampleCpu(), at: Date.now(), value: 0 }; // status view's short window
  }

  // CPU % across all cores since the previous call — the health watcher calls
  // this once a minute for its sustained-high-CPU check.
  sampleCpu() {
    const now = sampleCpu();
    this.cpu = percent(this.prev, now);
    this.prev = now;
    return this.cpu;
  }

  // Recent CPU % for the status view, on its own baseline (>= 2 s window) so
  // frequent polling doesn't disturb the health watcher's minute window.
  recentCpu() {
    if (Date.now() - this.ui.at >= 2000) {
      const now = sampleCpu();
      this.ui = { prev: now, at: Date.now(), value: percent(this.ui.prev, now) };
    }
    return this.ui.value;
  }

  async disk() {
    const s = await statfs(this.mediaDir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  }

  async snapshot() {
    const disk = await this.disk().catch(() => null);
    return {
      cpuPercent: Math.round(this.recentCpu()),
      cores: os.cpus().length,
      memory: { processBytes: process.memoryUsage().rss, freeBytes: os.freemem(), totalBytes: os.totalmem() },
      disk,
      uptimeSeconds: Math.round(process.uptime()),
      hostUptimeSeconds: Math.round(os.uptime()),
    };
  }
}

function percent(a, b) {
  const total = b.total - a.total;
  return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - (b.idle - a.idle) / total))) : 0;
}

function sampleCpu() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const [k, v] of Object.entries(c.times)) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}
