// Auth: one password for the whole panel.
//
// - Password stored as scrypt hash (Node built-in; no native deps on ARM).
// - Session = signed, expiring token in an HttpOnly SameSite=Strict cookie.
//   Changing the password rotates the signing secret, signing everyone out.
// - Login rate limit per client IP: after 5 failures, locked out for 1 min,
//   doubling up to 15 min.

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptP = promisify(scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
export const MIN_PASSWORD = 8;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw Object.assign(new Error(`Password must be at least ${MIN_PASSWORD} characters`), { status: 400 });
  }
  const salt = randomBytes(16);
  const key = await scryptP(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptP(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, expected);
}

export function issueToken(secret, hours) {
  const exp = Date.now() + hours * 3600_000;
  const body = `${exp}.${randomBytes(9).toString('base64url')}`;
  return `${body}.${sign(secret, body)}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || !secret) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const body = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(secret, body));
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return false;
  return Number(body.split('.')[0]) > Date.now();
}

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export class LoginLimiter {
  constructor({ maxFails = 5, baseLockMs = 60_000, maxLockMs = 15 * 60_000 } = {}) {
    this.maxFails = maxFails;
    this.baseLockMs = baseLockMs;
    this.maxLockMs = maxLockMs;
    this.clients = new Map(); // ip -> { fails, lockedUntil, locks }
  }

  check(ip, now = Date.now()) {
    const c = this.clients.get(ip);
    if (c && c.lockedUntil > now) return { allowed: false, retryAfter: Math.ceil((c.lockedUntil - now) / 1000) };
    return { allowed: true };
  }

  fail(ip, now = Date.now()) {
    const c = this.clients.get(ip) ?? { fails: 0, lockedUntil: 0, locks: 0 };
    c.fails++;
    if (c.fails >= this.maxFails) {
      c.lockedUntil = now + Math.min(this.maxLockMs, this.baseLockMs * 2 ** c.locks);
      c.locks++;
      c.fails = 0;
    }
    this.clients.set(ip, c);
    if (this.clients.size > 10_000) this.clients.delete(this.clients.keys().next().value);
  }

  succeed(ip) {
    this.clients.delete(ip);
  }
}
