import { Router } from 'express';
import { hashPassword, issueToken, setupCodeMatches, verifyPassword } from '../core/auth.js';
import { COOKIE, isAuthenticated, requireAuth } from '../middleware/requireAuth.js';
import { clientIp, isHttps } from '../middleware/security.js';

function setSession(req, res, cfg) {
  res.cookie(COOKIE, issueToken(cfg.auth.sessionSecret, cfg.auth.sessionHours), {
    httpOnly: true,
    sameSite: 'strict',
    secure: isHttps(req),
    maxAge: cfg.auth.sessionHours * 3600_000,
    path: '/',
  });
}

export function authRoutes(ctx, limiter) {
  const r = Router();
  const log = ctx.logs.for('auth');

  // Shared by login and first-run setup: wrong guesses lock the client out.
  const gate = (req, res) => {
    const g = limiter.check(clientIp(req));
    if (g.allowed) return true;
    res.set('Retry-After', String(g.retryAfter));
    res.status(429).json({ error: `Too many attempts. Try again in ${g.retryAfter} s.` });
    return false;
  };

  r.get('/session', async (req, res) => {
    await ctx.settings.refresh();
    const { auth } = ctx.getConfig();
    res.json({
      authenticated: isAuthenticated(req, ctx.getConfig),
      passwordSet: Boolean(auth.passwordHash),
      setupCodeRequired: !auth.passwordHash && Boolean(auth.setupCode),
    });
  });

  r.post('/login', async (req, res) => {
    if (!gate(req, res)) return;
    const ip = clientIp(req);
    await ctx.settings.refresh(); // pick up a password set from the CLI
    const cfg = ctx.getConfig();
    if (!cfg.auth.passwordHash) {
      return res.status(409).json({ error: 'No password set yet. Enter the setup code, or on the server run: npm run set-password' });
    }
    if (!(await verifyPassword(req.body?.password, cfg.auth.passwordHash))) {
      limiter.fail(ip);
      log(`failed login from ${ip}`);
      return res.status(401).json({ error: 'Wrong password' });
    }
    limiter.succeed(ip);
    setSession(req, res, cfg);
    log(`signed in from ${ip}`);
    res.json({ ok: true });
  });

  // First visit: the setup code (from the install) lets you choose the
  // password in the browser. Works only while no password is set.
  r.post('/setup', async (req, res) => {
    if (!gate(req, res)) return;
    const ip = clientIp(req);
    await ctx.settings.refresh();
    const { auth } = ctx.getConfig();
    if (auth.passwordHash) return res.status(409).json({ error: 'This panel already has a password. Sign in with it.' });
    if (!auth.setupCode) return res.status(409).json({ error: 'No setup code on this server. On the server run: npm run set-password' });
    const { code, password, timeZone } = req.body ?? {};
    if (!setupCodeMatches(code, auth.setupCode)) {
      limiter.fail(ip);
      log(`wrong setup code from ${ip}`);
      return res.status(401).json({ error: 'Wrong setup code' });
    }
    const hash = await hashPassword(password); // 400 if too short
    limiter.succeed(ip);
    await ctx.settings.setPasswordHash(hash); // also clears the setup code
    // The weekly reconnect then runs at a quiet hour where the owner lives.
    if (timeZone && !ctx.getConfig().restart.timeZone) {
      await ctx.settings.patch({ restart: { timeZone } }).catch(() => {});
    }
    setSession(req, res, ctx.getConfig());
    log(`panel set up from ${ip}: password chosen`);
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  r.post('/password', requireAuth(ctx.getConfig), async (req, res) => {
    const { current, next } = req.body ?? {};
    if (!(await verifyPassword(current, ctx.getConfig().auth.passwordHash))) {
      return res.status(401).json({ error: 'Current password is wrong' });
    }
    await ctx.settings.setPasswordHash(await hashPassword(next));
    setSession(req, res, ctx.getConfig()); // new secret: everyone else is signed out
    log('password changed');
    res.json({ ok: true });
  });

  return r;
}
