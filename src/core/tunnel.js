// Cloudflare quick tunnel: outbound-only HTTPS to the panel, no open ports,
// VM IP hidden. The free URL changes whenever cloudflared restarts, so every
// new URL is saved and announced (de-duped: only when it actually changed).
//
// A quick tunnel can also vanish while cloudflared keeps running: seen after
// a laptop sat offline through a power cut, Cloudflare deleted the name and
// cloudflared never noticed. So every minute the panel calls its own health
// page through the public link; after 3 misses in a row, while the internet
// itself works, it restarts cloudflared to get a new link (announced as usual).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function parseTunnelUrl(line) {
  return line.match(URL_RE)?.[0] ?? null;
}

// Does the public link reach this panel? (A deleted name fails DNS.)
async function reachesPanel(url) {
  const res = await fetch(`${url}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (res.status !== 200) {
    await res.body?.cancel(); // don't leave the connection hanging on every failed check
    return false;
  }
  return (await res.text()).trim() === 'ok';
}

// Is the internet up at all? Without it, a dead link proves nothing.
async function internetUp() {
  try {
    return (await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}

export class Tunnel extends EventEmitter {
  constructor({
    getConfig, port, state, log = () => {},
    launch = (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
    probe = reachesPanel, online = internetUp,
    checkEvery = 60_000, graceMs = 120_000, misses = 3, baseDelay = 5,
  }) {
    super();
    this.getConfig = getConfig;
    this.port = port;
    this.state = state;
    this.log = log;
    this.launch = launch;
    this.probe = probe;
    this.online = online;
    this.checkEvery = checkEvery;
    this.graceMs = graceMs; // a brand-new name can take a moment to resolve
    this.maxMisses = misses;
    this.baseDelay = baseDelay;
    this.proc = null;
    this.url = null;
    this.urlAt = 0;
    this.error = null;
    this.failures = 0;
    this.misses = 0;
    this.checking = false;
    this.watcher = null;
    this.closed = false;
  }

  start() {
    const cfg = this.getConfig().tunnel;
    if (!cfg.enabled || this.proc || this.closed) return;
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`];
    const proc = this.launch(cfg.cloudflaredPath, args);
    this.proc = proc;
    this.misses = 0;
    const startedAt = Date.now();
    const onLine = (line) => {
      const url = parseTunnelUrl(line);
      if (url && url !== this.url) this.#gotUrl(url);
    };
    readline.createInterface({ input: proc.stdout }).on('line', onLine);
    readline.createInterface({ input: proc.stderr }).on('line', onLine);
    proc.on('error', (err) => {
      this.error = err.code === 'ENOENT' ? 'cloudflared is not installed (or not on PATH)' : err.message;
    });
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null;
      this.url = null;
      if (this.closed) return;
      // Stopped on purpose (link dropped, or switched off and on again): a
      // new one right away, and it is not a crash.
      if (proc.stoppedOnPurpose) {
        this.log('cloudflared stopped; starting it again for a new link');
        return this.start();
      }
      if (Date.now() - startedAt > 300_000) this.failures = 0;
      this.failures++;
      // Not installed: check again every 5 min. Crashed: back off up to 1 min.
      const delay = this.error?.includes('not installed') ? 300 : Math.min(60, this.baseDelay * 2 ** (this.failures - 1));
      this.log(`cloudflared exited (${code}); restarting in ${delay} s${this.error ? ` — ${this.error}` : ''}`);
      setTimeout(() => this.start(), delay * 1000).unref?.();
    });
    this.#watch();
  }

  #watch() {
    if (this.watcher) return;
    this.watcher = setInterval(() => this.check(), this.checkEvery);
    this.watcher.unref?.();
  }

  // One look at the public link (also called by the tests).
  async check() {
    const { url, proc } = this;
    if (!url || !proc || this.checking || Date.now() - this.urlAt < this.graceMs) return;
    this.checking = true;
    try {
      let ok = false;
      try {
        ok = await this.probe(url);
      } catch {}
      if (ok || url !== this.url) {
        this.misses = 0;
        return;
      }
      if (!(await this.online())) return; // the whole internet is down: wait
      this.misses++;
      if (this.misses < this.maxMisses || this.proc !== proc) return;
      this.misses = 0;
      this.log(`panel link stopped answering (${url}): Cloudflare dropped it. Getting a new one`);
      proc.stoppedOnPurpose = true;
      proc.kill();
    } finally {
      this.checking = false;
    }
  }

  async #gotUrl(url) {
    this.url = url;
    this.urlAt = Date.now();
    this.misses = 0;
    this.error = null;
    this.log(`panel URL: ${url}`);
    const announce = this.state.data?.lastAnnouncedUrl !== url;
    await this.state.update((d) => {
      d.panelUrl = url;
      d.lastAnnouncedUrl = url;
    });
    if (announce) this.emit('url', { url });
  }

  status() {
    return { enabled: this.getConfig().tunnel.enabled, running: Boolean(this.proc), url: this.url, error: this.error };
  }

  // Re-enable after close() (tunnel switched back on in settings).
  open() {
    this.closed = false;
    this.start();
  }

  close() {
    this.closed = true;
    clearInterval(this.watcher);
    this.watcher = null;
    if (this.proc) {
      this.proc.stoppedOnPurpose = true; // if it is switched on again before this exits
      this.proc.kill();
    }
  }
}
