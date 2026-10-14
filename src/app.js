// The Express app: panel files + REST API, one origin (no CORS anywhere).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { LoginLimiter } from './core/auth.js';
import { requireAuth } from './middleware/requireAuth.js';
import { csrfGuard, securityHeaders } from './middleware/security.js';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { mediaRoutes } from './routes/media.js';
import { obsRoutes } from './routes/obs.js';
import { youtubeRoutes } from './routes/youtube.js';
import { restreamRoutes } from './routes/restream.js';
import { streamRoutes } from './routes/stream.js';
import { terminalRoutes, terminalSocket } from './routes/terminal.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
// The Terminal tab's browser side (xterm.js), straight from node_modules.
const MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url));
const VENDOR = {
  'xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
};

// Start listening with keep-alive longer than cloudflared's (90 s). Node's
// default (5 s) races proxies that reuse idle connections: a request sent
// just as Node closes the socket fails with ECONNRESET (seen in tests under
// slow ARM emulation; through the tunnel it would surface as random errors).
export function listen(app, port, host, onListening) {
  const server = app.listen(port, host, onListening);
  server.on('upgrade', (req, socket, head) => (app.upgrade ? app.upgrade(req, socket, head) : socket.destroy()));
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  return server;
}

export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  app.use('/api', csrfGuard, express.json({ limit: '1mb' }));
  // One lockout for every check of the panel password (sign-in, password
  // change, turning the terminal on); its own for the terminal password.
  const panelLimiter = new LoginLimiter();
  const terminalLimiter = new LoginLimiter();
  panelLimiter.on('guessing', (e) => ctx.notifier.guessing({ ...e, what: 'the panel password' }));
  terminalLimiter.on('guessing', (e) => ctx.notifier.guessing({ ...e, what: 'the terminal password' }));
  app.use('/api/auth', authRoutes(ctx, panelLimiter));
  const auth = requireAuth(ctx.getConfig);
  app.use('/api/media', auth, mediaRoutes(ctx));
  app.use('/api/config', auth, configRoutes(ctx));
  app.use('/api/stream', auth, streamRoutes(ctx));
  app.use('/api/obs', auth, obsRoutes(ctx));
  app.use('/api/youtube', auth, youtubeRoutes(ctx));
  app.use('/api/restream', auth, restreamRoutes(ctx));
  app.use('/api/terminal', auth, terminalRoutes(ctx, { panel: panelLimiter, terminal: terminalLimiter }));
  app.upgrade = terminalSocket(ctx);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Revalidate every time (cheap 304s): after an update a browser must never
  // mix old JS with new HTML, which a 1-hour cache did.
  app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));
  app.get('/vendor/xterm/:file', (req, res, next) => {
    const file = VENDOR[req.params.file];
    if (!file) return next();
    res.sendFile(path.join(MODULES, file), { maxAge: '1d' });
  });
  app.get('/{*any}', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // Errors: known ones keep their status and message; anything else is logged
  // (redacted) and the client gets a generic message.
  app.use((err, req, res, _next) => {
    let status = err.status ?? err.statusCode ?? 500;
    if (err.type === 'entity.parse.failed') status = 400;
    if (err.type === 'entity.too.large') status = 413;
    if (status >= 500) ctx.logs.push('error', `${req.method} ${req.path}: ${err.stack ?? err.message}`);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server — see the logs' : err.message });
  });

  return app;
}
