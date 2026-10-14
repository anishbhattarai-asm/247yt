// Cloudflare quick tunnel: outbound-only HTTPS to the panel, no open ports,
// VM IP hidden. The free URL changes whenever cloudflared restarts, so every
// new URL is saved and announced (de-duped: only when it actually changed).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function parseTunnelUrl(line) {
  return line.match(URL_RE)?.[0] ?? null;
}

export class Tunnel extends EventEmitter {
  constructor({ getConfig, port, state, log = () => {} }) {
    super();
    this.getConfig = getConfig;
    this.port = port;
    this.state = state;
    this.log = log;
    this.proc = null;
    this.url = null;
    this.error = null;
    this.failures = 0;
    this.closed = false;
  }

  start() {
    const cfg = this.getConfig().tunnel;
    if (!cfg.enabled || this.proc || this.closed) return;
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`];
    const proc = spawn(cfg.cloudflaredPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
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
      this.proc = null;
      this.url = null;
      if (this.closed) return;
      if (Date.now() - startedAt > 300_000) this.failures = 0;
      this.failures++;
      // Not installed: check again every 5 min. Crashed: back off up to 1 min.
      const delay = this.error?.includes('not installed') ? 300 : Math.min(60, 5 * 2 ** (this.failures - 1));
      this.log(`cloudflared exited (${code}); restarting in ${delay} s${this.error ? ` — ${this.error}` : ''}`);
      setTimeout(() => this.start(), delay * 1000).unref?.();
    });
  }

  async #gotUrl(url) {
    this.url = url;
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
    this.proc?.kill();
  }
}
