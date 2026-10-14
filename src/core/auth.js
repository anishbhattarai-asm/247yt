// Auth: one password for the whole panel.
//
// - Password stored as scrypt hash (Node built-in; no native deps on ARM).
// - Session = signed, expiring token in an HttpOnly SameSite=Strict cookie.
//   Changing the password rotates the signing secret, signing everyone out.
// - Login rate limit per client (IP, or IPv6 /64): after 5 failures, locked
//   out for 1 min, doubling up to 15 min (LoginLimiter).
// - At most a few password checks run at once (each takes ~16 MB and a CPU
//   core for a moment), so a flood of guesses can't starve the stream.

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isIPv6 } from 'node:net';
import { promisify } from 'node:util';

const scryptRaw = promisify(scrypt);
const MAX_CHECKS = 4; // at once; the rest wait their turn
const MAX_WAITING = 200; // beyond that: "busy, try again"
let checking = 0;
const waiting = [];
async function scryptP(...args) {
  if (checking < MAX_CHECKS) {
    checking++;
  } else {
    if (waiting.length >= MAX_WAITING) throw Object.assign(new Error('The panel is busy. Try again in a moment.'), { status: 503 });
    await new Promise((resolve) => waiting.push(resolve)); // a finished check hands its slot over
  }
  try {
    return await scryptRaw(...args);
  } finally {
    // Hand the slot straight to the next in line (keeping `checking` as it
    // is), so nothing can start in between and run a 5th check.
    const next = waiting.shift();
    if (next) next();
    else checking--;
  }
}

// For tests: how many checks are running and waiting right now.
export const passwordCheckLoad = () => ({ running: checking, waiting: waiting.length });
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
export const MIN_PASSWORD = 8;

// The terminal password guards a shell, so it has stricter rules than the
// panel's. Returns what is missing, or null when it is good enough.
export const TERMINAL_RULES = [
  ['at least 14 characters', (p) => p.length >= 14],
  ['a lowercase letter', (p) => /[a-z]/.test(p)],
  ['an uppercase letter', (p) => /[A-Z]/.test(p)],
  ['a digit', (p) => /[0-9]/.test(p)],
  ['a symbol (like ! # % - _ ?)', (p) => /[^A-Za-z0-9\s]/.test(p)],
];

export function terminalPasswordProblem(password) {
  if (typeof password !== 'string') return 'Type a terminal password';
  const missing = TERMINAL_RULES.filter(([, ok]) => !ok(password)).map(([rule]) => rule);
  return missing.length ? `The terminal password needs ${missing.join(', ')}.` : null;
}

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

// First-run setup code. Typed by a person, so case, spaces and dashes don't
// matter, and look-alikes count as the same (O/0, I/L/1).
const normalizeCode = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
const digest = (s) => createHash('sha256').update(s).digest();

export function setupCodeMatches(given, stored) {
  if (typeof given !== 'string' || typeof stored !== 'string' || !stored) return false;
  const a = normalizeCode(given);
  return a.length > 0 && timingSafeEqual(digest(a), digest(normalizeCode(stored)));
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

// Who a lockout applies to. IPv6 addresses are grouped by their /64 network:
// one connection usually gets a whole /64, so a new address costs nothing.
export function clientKey(ip) {
  const s = String(ip ?? 'unknown').split('%')[0];
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (v4) return v4[1];
  if (!isIPv6(s)) return s;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const parts = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${parts.slice(0, 4).map((p) => p.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Wrong passwords lock a client (address, or IPv6 /64) out: after 5, for
// 1 min, doubling up to 15 min. A guess counts from the moment it arrives
// (begin), not when its slow check finishes, so guesses sent all at once
// can't slip past the limit. Emits 'guessing' when wrong passwords keep
// coming from anywhere (default: 30 in an hour), at most once an hour.
export class LoginLimiter extends EventEmitter {
  constructor({ maxFails = 5, baseLockMs = 60_000, maxLockMs = 15 * 60_000, alertAfter = 30, alertWindowMs = 3600_000 } = {}) {
    super();
    this.maxFails = maxFails;
    this.baseLockMs = baseLockMs;
    this.maxLockMs = maxLockMs;
    this.alertAfter = alertAfter;
    this.alertWindowMs = alertWindowMs;
    this.clients = new Map(); // key -> { fails, pending, lockedUntil, locks }
    this.recent = new Map(); // minute -> { tries, keys } of wrong passwords, from anyone
    this.alertedAt = -Infinity; // never alerted yet
  }

  #entry(key) {
    let c = this.clients.get(key);
    if (!c) {
      c = { fails: 0, pending: 0, lockedUntil: 0, locks: 0 };
      this.clients.set(key, c);
      if (this.clients.size > 10_000) this.clients.delete(this.clients.keys().next().value);
    }
    return c;
  }

  check(ip, now = Date.now()) {
    const c = this.clients.get(clientKey(ip));
    if (c && c.lockedUntil > now) return { allowed: false, retryAfter: Math.ceil((c.lockedUntil - now) / 1000) };
    if (c && c.fails + c.pending >= this.maxFails) return { allowed: false, retryAfter: 1 }; // guesses still being checked
    return { allowed: true };
  }

  // Reserve one guess. Then call fail() or succeed() on the result; release()
  // (in a finally) frees it if neither happened, e.g. on an error.
  begin(ip, now = Date.now()) {
    const gate = this.check(ip, now);
    if (!gate.allowed) return gate;
    const c = this.#entry(clientKey(ip));
    c.pending++;
    let open = true;
    const close = () => {
      if (!open) return false;
      open = false;
      c.pending--;
      return true;
    };
    return {
      allowed: true,
      fail: () => close() && this.fail(ip),
      succeed: () => close() && this.succeed(ip),
      release: () => close(),
    };
  }

  fail(ip, now = Date.now()) {
    const key = clientKey(ip);
    const c = this.#entry(key);
    c.fails++;
    if (c.fails >= this.maxFails) {
      c.lockedUntil = now + Math.min(this.maxLockMs, this.baseLockMs * 2 ** c.locks);
      c.locks++;
      c.fails = 0;
    }
    // Counted per minute, so a flood costs a few small buckets, not a list
    // of every try. Distinct addresses are counted up to 1000 per minute.
    const minute = Math.floor(now / 60_000);
    let bucket = this.recent.get(minute);
    if (!bucket) {
      bucket = { tries: 0, keys: new Set() };
      this.recent.set(minute, bucket);
    }
    bucket.tries++;
    if (bucket.keys.size < 1000) bucket.keys.add(key);
    const oldest = minute - Math.ceil(this.alertWindowMs / 60_000);
    for (const m of this.recent.keys()) {
      if (m > oldest) break; // buckets are kept in time order
      this.recent.delete(m);
    }
    let tries = 0;
    const keys = new Set();
    for (const b of this.recent.values()) {
      tries += b.tries;
      for (const k of b.keys) if (keys.size < 1000) keys.add(k);
    }
    if (tries >= this.alertAfter && now - this.alertedAt >= this.alertWindowMs) {
      this.alertedAt = now;
      this.emit('guessing', { tries, addresses: keys.size, minutes: Math.round(this.alertWindowMs / 60_000) });
    }
  }

  succeed(ip) {
    const c = this.clients.get(clientKey(ip));
    if (!c) return;
    c.fails = 0;
    c.locks = 0;
    c.lockedUntil = 0;
    if (!c.pending) this.clients.delete(clientKey(ip));
  }
}
