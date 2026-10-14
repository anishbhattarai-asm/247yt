import { verifyToken } from '../core/auth.js';

export const COOKIE = 'sp_session';

export function readCookie(req, name) {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function isAuthenticated(req, getConfig) {
  return verifyToken(readCookie(req, COOKIE), getConfig().auth.sessionSecret);
}

export function requireAuth(getConfig) {
  return (req, res, next) => {
    if (isAuthenticated(req, getConfig)) return next();
    res.status(401).json({ error: 'Not signed in' });
  };
}
