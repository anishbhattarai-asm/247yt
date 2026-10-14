// Settings: config.json schema, defaults, validation, masking, env overrides.
//
// config.json (mode 600) is the single home for settings AND secrets. The API
// never returns a secret — only whether it is set. Environment variables can
// override secrets and a few deploy knobs without touching the file (handy for
// dev and tests); overrides are applied to the *effective* config only and are
// never written back.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { JsonStore } from './store.js';

export const DEFAULTS = {
  version: 1,
  server: { host: '127.0.0.1', port: 3000 },
  auth: { passwordHash: null, sessionSecret: null, sessionHours: 168 },
  // clientId/clientSecret: the owner's Google Cloud OAuth client for the
  // optional "Connect YouTube" (youtube.js); refreshToken, channel and
  // broadcastId are written by the panel itself, never by a patch.
  youtube: {
    streamKey: '', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
    clientId: '', clientSecret: '', refreshToken: '', tokenClientId: '', channel: null, broadcastId: null, autoRecreate: true,
  },
  mode: 'video', // 'video' | 'lofi'
  playlist: { order: 'sequential' }, // 'sequential' | 'shuffle' | 'repeat-one'
  lofi: { backgroundId: null },
  // Locked once the library has media: every file must match it exactly, or
  // `-c copy` breaks at the first join.
  profile: {
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrate: '3000k',
    audioBitrate: '128k',
    sampleRate: 44100,
    preset: 'veryfast',
  },
  // FFmpeg's FLV timestamps wrap at ~24.8 days, so the pusher restarts cleanly
  // every few days at a quiet hour (invisible to viewers — verified on YouTube).
  restart: { everyDays: 7, at: '04:00' },
  notifications: {
    discordWebhookUrl: '',
    events: {
      start: true, stopped: true, dropped: true, online: true, frozen: true,
      skipped: true, failing: true, panelUrl: true, lowDisk: true, highCpu: true, obs: true, youtube: true, restream: true,
    },
  },
  healthcheck: { url: '', intervalMinutes: 5 },
  tunnel: { enabled: true, cloudflaredPath: 'cloudflared' },
  // OBS takeover: OBS streams to the panel over SRT (encrypted, passphrase),
  // the panel cuts over cleanly and returns to the playlist when OBS stops.
  // publicHost: what OBS connects to; empty = this server's detected public IP.
  obs: { enabled: false, port: 9710, passphrase: null, publicHost: '' },
  // Multistream (restream.js): [{ id, name, platform, url, key, enabled }].
  // Keys are secrets; changed only through /api/restream, never a patch.
  restream: { destinations: [] },
  limits: {
    // A sanity cap; the real limit is free disk (file + converted copy).
    maxUploadBytes: 100 * 1024 ** 3,
    minFreeDiskBytes: 5 * 1024 ** 3,
  },
};

// Paths (dot notation) holding secrets.
export const SECRETS = [
  'auth.passwordHash',
  'auth.sessionSecret',
  'youtube.streamKey',
  'youtube.clientSecret',
  'youtube.refreshToken',
  'notifications.discordWebhookUrl',
  'healthcheck.url',
  'obs.passphrase',
];

const ENV = {
  STREAM_KEY: 'youtube.streamKey',
  RTMP_URL: 'youtube.rtmpUrl',
  DISCORD_WEBHOOK_URL: 'notifications.discordWebhookUrl',
  HEALTHCHECK_URL: 'healthcheck.url',
  PORT: 'server.port',
  HOST: 'server.host',
  CLOUDFLARED: 'tunnel.cloudflaredPath',
};

export class Settings {
  constructor(dataDir) {
    this.store = new JsonStore(path.join(dataDir, 'config.json'), DEFAULTS);
  }

  async load() {
    const raw = await this.store.load();
    const merged = deepMerge(structuredClone(DEFAULTS), raw);
    // The old 20 GB cap refused single 40-50 GB videos; lift it if unchanged.
    if (merged.limits.maxUploadBytes === 20 * 1024 ** 3) merged.limits.maxUploadBytes = DEFAULTS.limits.maxUploadBytes;
    const needsSecret = !merged.auth.sessionSecret || !merged.obs.passphrase;
    merged.auth.sessionSecret ||= randomBytes(32).toString('base64url');
    merged.obs.passphrase ||= newObsPassphrase();
    if (needsSecret || JSON.stringify(merged) !== JSON.stringify(raw)) {
      await this.store.update(() => merged);
    }
    return this;
  }

  // Pick up edits made outside this process (e.g. `npm run set-password`).
  async refresh() {
    await this.store.reloadIfChanged();
  }

  // Persisted config plus env overrides. Use this everywhere at runtime.
  // Edits made from the server's command line apply immediately.
  get() {
    this.store.reloadIfChangedSync();
    const cfg = structuredClone(this.store.data);
    for (const [name, key] of Object.entries(ENV)) {
      const v = process.env[name];
      if (v === undefined || v === '') continue;
      setPath(cfg, key, key === 'server.port' ? Number(v) : v);
    }
    if (process.env.TUNNEL !== undefined) cfg.tunnel.enabled = process.env.TUNNEL === '1';
    return cfg;
  }

  // Which secrets come from the environment (the UI should say so).
  envOverrides() {
    return Object.entries(ENV).filter(([n]) => process.env[n]).map(([, k]) => k);
  }

  // Safe for the API: secrets become { set: true|false }.
  public() {
    const cfg = this.get();
    const out = structuredClone(cfg);
    for (const key of SECRETS) setPath(out, key, { set: Boolean(getPath(cfg, key)) });
    out.auth = { passwordSet: Boolean(cfg.auth.passwordHash), sessionHours: cfg.auth.sessionHours };
    out.restream.destinations = cfg.restream.destinations.map(({ key, ...d }) => ({ ...d, key: { set: Boolean(key) } }));
    out.envOverrides = this.envOverrides();
    return out;
  }

  // Validate a partial patch from the API and apply it. Throws ValidationError.
  async patch(patch, { profileLocked = false } = {}) {
    const clean = validatePatch(patch, { profileLocked });
    return this.store.update((draft) => deepMerge(draft, clean));
  }

  // Values the panel sets itself (not user input, so no patch validation).
  async setInternal(fn) {
    await this.store.update(fn);
  }

  async newObsPassphrase() {
    await this.store.update((d) => {
      d.obs.passphrase = newObsPassphrase();
    });
  }

  async setPasswordHash(hash) {
    await this.store.update((d) => {
      d.auth.passwordHash = hash;
      // Rotating the secret signs everyone out — right after a password change.
      d.auth.sessionSecret = randomBytes(32).toString('base64url');
    });
  }
}

// SRT wants 10–79 characters; URL-safe so it can sit in OBS's server URL.
const newObsPassphrase = () => randomBytes(18).toString('base64url');

// validation

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (msg) => {
  throw new ValidationError(msg);
};

function str(v, name, { pattern, max = 2048, allowEmpty = false } = {}) {
  if (typeof v !== 'string') fail(`${name} must be a string`);
  const s = v.trim();
  if (!s && allowEmpty) return '';
  if (!s) fail(`${name} must not be empty`);
  if (s.length > max) fail(`${name} is too long`);
  if (pattern && !pattern.test(s)) fail(`${name} has an invalid format`);
  return s;
}

function int(v, name, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) fail(`${name} must be an integer ${min}–${max}`);
  return v;
}

function oneOf(v, name, options) {
  if (!options.includes(v)) fail(`${name} must be one of: ${options.join(', ')}`);
  return v;
}

function bool(v, name) {
  if (typeof v !== 'boolean') fail(`${name} must be true or false`);
  return v;
}

const BITRATE = /^\d{2,6}k$/;
const DISCORD = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

// Each editable field: path -> validator. Anything else in a patch is rejected.
// A key pasted twice into a hidden field ("abcd-...abcd-...") is a classic.
function streamKey(v) {
  const s = str(v, 'Stream key', { pattern: /^[\w-]{4,128}$/, allowEmpty: true });
  const half = s.length / 2;
  const twice = (a, b) => a.length >= 4 && a === b;
  if (twice(s.slice(0, half), s.slice(half)) || (s[Math.floor(half)] === '-' && twice(s.slice(0, Math.floor(half)), s.slice(Math.floor(half) + 1)))) {
    fail('That stream key looks like it was pasted twice — paste it once.');
  }
  return s;
}

const FIELDS = {
  'youtube.streamKey': streamKey,
  'youtube.rtmpUrl': (v) => str(v, 'RTMP URL', { pattern: /^rtmps?:\/\/[^\s]+$/ }),
  'youtube.clientId': (v) => str(v, 'Client ID', { pattern: /^[\w.-]+\.apps\.googleusercontent\.com$/, allowEmpty: true }),
  'youtube.clientSecret': (v) => str(v, 'Client secret', { pattern: /^[\w-]{10,100}$/, allowEmpty: true }),
  'youtube.autoRecreate': (v) => bool(v, 'Start a new broadcast if YouTube ends one'),
  mode: (v) => oneOf(v, 'Mode', ['video', 'lofi']),
  'playlist.order': (v) => oneOf(v, 'Playlist order', ['sequential', 'shuffle', 'repeat-one']),
  'lofi.backgroundId': (v) => (v === null ? null : str(v, 'Background', { pattern: /^[\w-]{1,64}$/ })),
  'profile.width': (v) => int(v, 'Width', 320, 3840),
  'profile.height': (v) => int(v, 'Height', 240, 2160),
  'profile.fps': (v) => oneOf(v, 'FPS', [24, 25, 30, 50, 60]),
  'profile.videoBitrate': (v) => str(v, 'Video bitrate', { pattern: BITRATE }),
  'profile.audioBitrate': (v) => str(v, 'Audio bitrate', { pattern: BITRATE }),
  'profile.sampleRate': (v) => oneOf(v, 'Sample rate', [44100, 48000]),
  'profile.preset': (v) => oneOf(v, 'Preset', ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']),
  'restart.everyDays': (v) => int(v, 'Restart interval (days)', 1, 20),
  'restart.at': (v) => str(v, 'Restart time', { pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }),
  'notifications.discordWebhookUrl': (v) => str(v, 'Discord webhook', { pattern: DISCORD, allowEmpty: true }),
  'healthcheck.url': (v) => str(v, 'Healthcheck URL', { pattern: /^https:\/\/[^\s]+$/, allowEmpty: true }),
  'healthcheck.intervalMinutes': (v) => int(v, 'Healthcheck interval', 1, 60),
  'tunnel.enabled': (v) => bool(v, 'Tunnel'),
  'obs.enabled': (v) => bool(v, 'OBS input'),
  'obs.port': (v) => int(v, 'OBS port', 1024, 65535),
  'obs.publicHost': (v) => str(v, 'Server address for OBS', { pattern: /^[\w.:-]{1,253}$/, allowEmpty: true }),
};
for (const e of Object.keys(DEFAULTS.notifications.events)) {
  FIELDS[`notifications.events.${e}`] = (v) => bool(v, `Notify on ${e}`);
}

export function validatePatch(patch, { profileLocked = false } = {}) {
  if (!isObj(patch)) fail('Expected a JSON object');
  const out = {};
  for (const [key, value] of flatten(patch)) {
    const check = FIELDS[key];
    if (!check) fail(`${key} cannot be changed here`);
    if (key.startsWith('profile.') && profileLocked) {
      fail('The stream profile is locked while the library has media — every file must match it. Delete the media first.');
    }
    setPath(out, key, check(value));
  }
  return out;
}

// helpers

function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) out.push(...flatten(v, key));
    else out.push([key, v]);
  }
  return out;
}

export function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) {
    if (!isObj(o[k])) o[k] = {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = value;
}

export function deepMerge(target, source) {
  if (!isObj(source)) return target;
  for (const [k, v] of Object.entries(source)) {
    if (isObj(v) && isObj(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}
