// Terminal tab API. The terminal has its own password (like sudo), separate
// from the panel's, so a leaked panel password alone never opens a shell:
//
// - the first terminal password is set with the panel password (Discord is
//   told); after that, changing it or turning the terminal off takes the
//   current terminal password (or the server's command line);
// - every session takes the terminal password again: POST /ticket returns a
//   one-time ticket that the WebSocket (/api/terminal/ws) must present.
// Wrong terminal passwords lock the client out like wrong sign-ins, and
// answer 403 (to the panel, 401 means "signed out").

import { Router } from 'express';
import { WebSocketServer } from 'ws';
import { hashPassword, terminalPasswordProblem, verifyPassword } from '../core/auth.js';
import { isAuthenticated } from '../middleware/requireAuth.js';
import { clientIp } from '../middleware/security.js';

// limiters: { panel: sign-in's limiter, terminal: the terminal password's }.
export function terminalRoutes(ctx, limiters) {
  const r = Router();
  const log = ctx.logs.for('terminal');

  // Checks a password through a limiter: wrong ones lock the client out,
  // counted from the moment they arrive. Answers the request itself (429,
  // 403) and returns false when the check didn't pass.
  async function checked(lim, req, res, password, hash, what) {
    const ip = clientIp(req);
    const attempt = lim.begin(ip);
    if (!attempt.allowed) {
      res.set('Retry-After', String(attempt.retryAfter));
      res.status(429).json({ error: `Too many attempts. Try again in ${attempt.retryAfter} s.` });
      return false;
    }
    try {
      if (!(await verifyPassword(password, hash))) {
        attempt.fail();
        log(`wrong ${what} from ${ip}`);
        res.status(403).json({ error: `Wrong ${what}` });
        return false;
      }
      attempt.succeed();
      return true;
    } finally {
      attempt.release();
    }
  }

  async function checkTerminal(req, res, password) {
    await ctx.settings.refresh(); // pick up a change made from the command line
    const hash = ctx.getConfig().auth.terminalHash;
    if (!hash) {
      res.status(409).json({ error: 'The terminal is off: set a terminal password first.' });
      return false;
    }
    return checked(limiters.terminal, req, res, password, hash, 'terminal password');
  }

  r.get('/', (req, res) => res.json(ctx.terminal.status()));

  // Set (first time: with the panel password, which shares sign-in's
  // lockout) or change (with the current terminal password).
  r.post('/password', async (req, res) => {
    const { panelPassword, current, next } = req.body ?? {};
    const ip = clientIp(req);
    await ctx.settings.refresh();
    const { auth } = ctx.getConfig();
    const first = !auth.terminalHash;
    if (first) {
      if (!(await checked(limiters.panel, req, res, panelPassword, auth.passwordHash, 'panel password'))) return;
    } else if (!(await checkTerminal(req, res, current))) {
      return;
    }
    const weak = terminalPasswordProblem(next);
    if (weak) return res.status(400).json({ error: weak });
    if (await verifyPassword(next, auth.passwordHash)) {
      return res.status(400).json({ error: 'Use a different password from the panel\'s: that is the point of it.' });
    }
    await ctx.settings.setTerminalHash(await hashPassword(next));
    log(`terminal password ${first ? 'set' : 'changed'} from ${ip}`);
    ctx.notifier.terminalPassword({ ip, change: first ? 'set' : 'changed' });
    res.json(ctx.terminal.status());
  });

  r.post('/off', async (req, res) => {
    if (!(await checkTerminal(req, res, req.body?.current))) return;
    await ctx.settings.setTerminalHash(null);
    ctx.terminal.closeAll();
    log(`terminal turned off from ${clientIp(req)}`);
    ctx.notifier.terminalPassword({ ip: clientIp(req), change: 'off' });
    res.json(ctx.terminal.status());
  });

  r.post('/ticket', async (req, res) => {
    if (!(await checkTerminal(req, res, req.body?.password))) return;
    if (!ctx.terminal.available()) {
      return res.status(503).json({ error: 'The terminal service is not installed on this server. Run once over SSH: bash deploy/update.sh' });
    }
    res.json({ ticket: ctx.terminal.issueTicket() });
  });

  return r;
}

// HTTP upgrade handler for /api/terminal/ws (server.on('upgrade')).
export function terminalSocket(ctx) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const reject = (socket, status, text) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  return (req, socket, head) => {
    const path = new URL(req.url, 'http://panel').pathname;
    if (path !== '/api/terminal/ws') return reject(socket, 404, 'Not Found');
    // Not an Express request: give the helpers the bits they read.
    const r = { get: (h) => req.headers[h.toLowerCase()], socket: req.socket };
    if (!isAuthenticated(r, ctx.getConfig)) return reject(socket, 401, 'Unauthorized');
    // Only the panel's own page may connect (the ticket is the real lock).
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try {
        host = new URL(origin).host;
      } catch {}
      if (![req.headers.host, req.headers['x-forwarded-host']].includes(host)) return reject(socket, 403, 'Forbidden');
    }
    if (!ctx.terminal.enabled()) return reject(socket, 409, 'Conflict');
    wss.handleUpgrade(req, socket, head, (ws) => relay(ctx, ws, clientIp(r)));
  };
}

// Browser messages are JSON text: {t:'ticket', v, c, r} first, then
// {t:'d', v: keystrokes} and {t:'r', c: cols, r: rows}. The shell's output
// goes back as binary frames; {t:'ready'|'exit'|'idle'|'error'} as text.
function relay(ctx, ws, ip) {
  let session = null;
  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const noTicket = setTimeout(() => ws.close(4001, 'No ticket'), 10_000);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (session) {
      if (msg.t === 'd' && typeof msg.v === 'string') session.write(msg.v);
      else if (msg.t === 'r') session.resize(msg.c, msg.r);
      return;
    }
    if (msg.t !== 'ticket' || !ctx.terminal.takeTicket(msg.v)) {
      send({ t: 'error', v: 'This terminal link has expired. Enter the terminal password again.' });
      return ws.close(4003, 'Bad ticket');
    }
    clearTimeout(noTicket);
    try {
      session = ctx.terminal.open({ ip });
    } catch (err) {
      send({ t: 'error', v: err.message });
      return ws.close(4029, 'Busy');
    }
    session.on('data', (buf) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(buf, { binary: true });
      // A slow browser (or `cat` of a huge file): stop reading the shell
      // until the backlog drains, instead of buffering without limit.
      if (ws.bufferedAmount > 4 * 1024 * 1024) session.pause();
    });
    session.on('exit', (code) => send({ t: 'exit', v: code }));
    session.on('idle', () => send({ t: 'idle', v: ctx.getConfig().terminal.idleMinutes }));
    session.on('error', (err) => send({ t: 'error', v: err.message }));
    session.on('close', () => ws.close(1000, 'Closed'));
    session.resize(msg.c, msg.r);
    send({ t: 'ready' });
  });
  const drain = setInterval(() => {
    if (session?.paused && ws.bufferedAmount < 1024 * 1024) session.resume();
  }, 100);
  ws.on('close', () => {
    clearTimeout(noTicket);
    clearInterval(drain);
    session?.close();
  });
}
