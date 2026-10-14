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

  // Every password or setup-code check goes through the limiter: wrong
  // guesses lock the client out, counted from the moment they arrive.
  // Returns the reserved attempt, or null after answering 429.
  const begin = (req, res) => {
    const attempt = limiter.begin(clientIp(req));
    if (attempt.allowed) return attempt;
    res.set('Retry-After', String(attempt.retryAfter));
    res.status(429).json({ error: `Too many attempts. Try again in ${attempt.retryAfter} s.` });
    return null;
  };

  // Sessions only end when their cookie is next checked; a terminal checks
  // it once, when it opens. So whenever everyone is signed out, close open
  // terminals and cancel unused terminal tickets too.
  const endTerminalSessions = () => {
    ctx.terminal.closeAll();
    ctx.terminal.tickets.clear();
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
    const attempt = begin(req, res);
    if (!attempt) return;
    try {
      const ip = clientIp(req);
      await ctx.settings.refresh(); // pick up a password set from the CLI
      const cfg = ctx.getConfig();
      if (!cfg.auth.passwordHash) {
        return res.status(409).json({ error: 'No password set yet. Enter the setup code, or on the server run: npm run set-password' });
      }
      if (!(await verifyPassword(req.body?.password, cfg.auth.passwordHash))) {
        attempt.fail();
        log(`failed login from ${ip}`);
        return res.status(401).json({ error: 'Wrong password' });
      }
      attempt.succeed();
      setSession(req, res, cfg);
      log(`signed in from ${ip}`);
      res.json({ ok: true });
    } finally {
      attempt.release();
    }
  });

  // First visit: the setup code (from the install) lets you choose the
  // password in the browser. Works only while no password is set.
  r.post('/setup', async (req, res) => {
    const attempt = begin(req, res);
    if (!attempt) return;
    try {
      const ip = clientIp(req);
      await ctx.settings.refresh();
      const { auth } = ctx.getConfig();
      if (auth.passwordHash) return res.status(409).json({ error: 'This panel already has a password. Sign in with it.' });
      if (!auth.setupCode) return res.status(409).json({ error: 'No setup code on this server. On the server run: npm run set-password' });
      const { code, password, timeZone } = req.body ?? {};
      if (!setupCodeMatches(code, auth.setupCode)) {
        attempt.fail();
        log(`wrong setup code from ${ip}`);
        return res.status(401).json({ error: 'Wrong setup code' });
      }
      const hash = await hashPassword(password); // 400 if too short
      attempt.succeed();
      await ctx.settings.setPasswordHash(hash); // also clears the setup code
      // The weekly reconnect then runs at a quiet hour where the owner lives.
      if (timeZone && !ctx.getConfig().restart.timeZone) {
        await ctx.settings.patch({ restart: { timeZone } }).catch(() => {});
      }
      setSession(req, res, ctx.getConfig());
      log(`panel set up from ${ip}: password chosen`);
      res.json({ ok: true });
    } finally {
      attempt.release();
    }
  });

  r.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Signing out only forgets this browser's cookie; a copied cookie would
  // keep working until it expires. This ends every session but this one.
  r.post('/logout-others', requireAuth(ctx.getConfig), async (req, res) => {
    await ctx.settings.rotateSessionSecret();
    endTerminalSessions(); // a terminal opened from a signed-out browser must not stay open
    setSession(req, res, ctx.getConfig());
    log(`signed out every other browser (from ${clientIp(req)})`);
    res.json({ ok: true });
  });

  // Also limited: a borrowed or copied session must not be a way to guess
  // the panel password at full speed.
  r.post('/password', requireAuth(ctx.getConfig), async (req, res) => {
    const attempt = begin(req, res);
    if (!attempt) return;
    try {
      const { current, next } = req.body ?? {};
      if (!(await verifyPassword(current, ctx.getConfig().auth.passwordHash))) {
        attempt.fail();
        log(`wrong current password (password change) from ${clientIp(req)}`);
        return res.status(401).json({ error: 'Current password is wrong' });
      }
      attempt.succeed();
      await ctx.settings.setPasswordHash(await hashPassword(next));
      endTerminalSessions();
      setSession(req, res, ctx.getConfig()); // new secret: everyone else is signed out
      log('password changed');
      res.json({ ok: true });
    } finally {
      attempt.release();
    }
  });

  return r;
}
