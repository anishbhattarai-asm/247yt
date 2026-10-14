// Stable link: http://<server-ip>:<port> always leads to the panel.
//
// The free Cloudflare link changes whenever cloudflared restarts, so this tiny
// HTTP server answers every request with a redirect to whichever link is live
// now (or a "starting" page that retries). It serves nothing else: no panel
// pages, no API, no files. Off unless finder.port is set (the Oracle stack
// sets 8080 and opens it in the firewall).

import http from 'node:http';
import { EventEmitter } from 'node:events';

const page = (title, text) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5">
<title>${title}</title><style>:root{--bg:#0e1015;--text:#e7e9ee;--muted:#959cab;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f4f5f8;--text:#161a22;--muted:#5f6878;color-scheme:light}}
body{font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text);display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{max-width:420px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:var(--muted)}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

export class Finder extends EventEmitter {
  constructor({ getConfig, tunnel, bind = '0.0.0.0', log = () => {} }) {
    super();
    this.getConfig = getConfig;
    this.tunnel = tunnel;
    this.bind = bind;
    this.log = log;
    this.server = null;
    this.port = 0;
    this.error = null;
  }

  // Start, stop or move to match finder.port. Safe to call after any change.
  apply() {
    const want = this.getConfig().finder.port || 0;
    if (want === this.port && (this.server || !want)) return;
    this.close();
    if (want) this.#listen(want);
  }

  #listen(port) {
    const server = http.createServer((req, res) => this.#answer(req, res));
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.on('error', (err) => {
      this.error = err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message;
      this.log(`stable link: ${this.error}`);
      if (this.server === server) this.server = null;
    });
    server.listen(port, this.bind, () => {
      this.error = null;
      this.log(`stable link on port ${port}: it forwards to the current panel link`);
      this.emit('listening', { port: server.address().port });
    });
    this.server = server;
    this.port = port;
  }

  #answer(req, res) {
    const headers = {
      'cache-control': 'no-store', // the target changes; never let a browser remember it
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, allow: 'GET, HEAD' });
      return res.end();
    }
    const url = this.tunnel.status().url;
    if (url) {
      res.writeHead(302, { ...headers, location: url });
      return res.end();
    }
    const off = !this.getConfig().tunnel.enabled;
    res.writeHead(503, {
      ...headers,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'retry-after': '5',
    });
    res.end(req.method === 'HEAD' ? undefined : off
      ? page('Panel link is off', 'The Cloudflare link is switched off in the panel (Settings, Access), so there is nothing to forward to. This page checks again every few seconds.')
      : page('The panel is starting', 'Its link is on the way. This page tries again every 5 seconds and opens the panel as soon as it is ready.'));
  }

  status() {
    return { port: this.port, listening: Boolean(this.server?.listening), error: this.error };
  }

  close() {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    this.port = 0;
  }
}
