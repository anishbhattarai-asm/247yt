import { Router } from 'express';
import { hashPassword, issueToken, verifyPassword } from '../core/auth.js';
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

  r.get('/session', async (req, res) => {
    await ctx.settings.refresh();
    res.json({ authenticated: isAuthenticated(req, ctx.getConfig), passwordSet: Boolean(ctx.getConfig().auth.passwordHash) });
  });

  r.post('/login', async (req, res) => {
    const ip = clientIp(req);
    const gate = limiter.check(ip);
    if (!gate.allowed) {
      res.set('Retry-After', String(gate.retryAfter));
      return res.status(429).json({ error: `Too many attempts. Try again in ${gate.retryAfter} s.` });
    }
    await ctx.settings.refresh(); // pick up a password set from the CLI
    const cfg = ctx.getConfig();
    if (!cfg.auth.passwordHash) {
      return res.status(409).json({ error: 'No password set yet. On the server run: npm run set-password' });
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
