// "Connect YouTube" (optional): the panel talks to the YouTube Data API on
// the owner's behalf. Sign-in is Google's device flow (the panel shows a code,
// the owner enters it at google.com/device) because the panel's own address,
// a quick tunnel, changes on every restart, which a redirect sign-in can't
// handle. It needs the owner's own Google Cloud OAuth client of type "TVs and
// Limited Input devices" (SETUP-GUIDE step 5b).
//
// Once connected:
//   health     YouTube's own verdict on our stream (what Studio shows), polled
//              every minute while streaming; Discord when it turns Poor
//   broadcast  which broadcast our key feeds, its watch link, and a warning
//              with a one-click fix when Auto-stop is on
//   setup      one click: a scheduled broadcast with Auto-start ON and
//              Auto-stop OFF, bound to our stream key (a new reusable key if
//              there is none), key saved in the panel
//   recover    if YouTube ends the broadcast while we stream, a new one with
//              the same title and privacy is bound to the same key
//   go live    a new broadcast is started by the panel itself. Found on the
//              real API: Auto-start only fires when the stream goes inactive
//              -> active (a 24/7 stream already is, so it sat "ready"), and
//              manual transitions are refused (invalidTransition) while
//              Auto-start is on. So the panel pauses its stream until YouTube
//              sees it inactive (~10 s), resumes, and YouTube starts it.
// Quota: 2–3 of the 10,000 free daily units per check; setup costs ~150.
//
// Events: connected {channel}   health {status, previous, issues}
//         broadcastEnded {title, replacement, error}   authLost {error}

import { EventEmitter } from 'node:events';

const OAUTH = 'https://oauth2.googleapis.com';
const API = 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube';
const RECREATE_COOLDOWN = 30 * 60_000;

// API health values -> the words Studio uses.
export const HEALTH_LABEL = { good: 'Excellent', ok: 'OK', bad: 'Poor', noData: 'No data' };

const watchUrl = (id) => `https://youtu.be/${id}`;
const studioUrl = (id) => `https://studio.youtube.com/video/${id}/livestreaming`;

function apiError(status, body) {
  const e = body?.error;
  const reason = e?.errors?.[0]?.reason ?? e?.status ?? 'error';
  return Object.assign(new Error(`YouTube API ${status} ${reason}: ${e?.message ?? 'no detail'}`), { status, reason });
}

export class YouTube extends EventEmitter {
  // settings: Settings (to save tokens). isStreaming(): poll faster while on air.
  // pauseStream(reason) / resumeStream(): go off air briefly (supervisor.hold/release).
  constructor({
    getConfig, settings, isStreaming = () => false, log = () => {}, oauthBase = OAUTH, apiBase = API,
    pollSeconds = 60, idlePollSeconds = 300, pauseStream = () => false, resumeStream = () => {},
  }) {
    super();
    this.pauseStream = pauseStream;
    this.resumeStream = resumeStream;
    this.getConfig = getConfig;
    this.settings = settings;
    this.isStreaming = isStreaming;
    this.log = log;
    this.oauthBase = oauthBase;
    this.apiBase = apiBase;
    this.pollSeconds = pollSeconds;
    this.idlePollSeconds = idlePollSeconds;
    this.access = null; // { token, expiresAt }
    this.pending = null; // device flow in progress
    this.stream = null;
    this.broadcast = null;
    this.checkedAt = 0;
    this.lastError = null;
    this.badCount = 0;
    this.alertedBad = false;
    this.lastRecreateAt = 0;
    this.sleepScale = 1; // tests shrink waits
  }

  start() {
    this.timer = setInterval(() => this.#tick(), 15_000);
    this.timer.unref?.();
    this.#tick();
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.pollTimer);
  }

  #cfg() {
    return this.getConfig().youtube;
  }

  get configured() {
    const c = this.#cfg();
    return Boolean(c.clientId && c.clientSecret);
  }

  // A sign-in belongs to the client it was made with (saved next to it, so a
  // client set from the command line is handled too).
  get connected() {
    const c = this.#cfg();
    return this.configured && Boolean(c.refreshToken) && c.tokenClientId === c.clientId;
  }

  status() {
    const c = this.#cfg();
    const p = this.pending;
    return {
      configured: this.configured,
      connected: this.connected,
      channel: c.channel,
      autoRecreate: c.autoRecreate,
      pending: p ? { userCode: p.userCode, verificationUrl: p.verificationUrl, expiresAt: p.expiresAt } : null,
      stream: this.stream,
      broadcast: this.broadcast,
      checkedAt: this.checkedAt || null,
      lastError: this.lastError,
    };
  }

  // Settings changed: a different OAuth client can't use the old sign-in.
  async apply() {
    const c = this.#cfg();
    if (c.refreshToken && c.tokenClientId !== c.clientId) await this.disconnect({ revoke: false });
  }

  // sign-in

  async startConnect() {
    if (!this.configured) throw Object.assign(new Error('Save the Client ID and secret first.'), { status: 409 });
    clearTimeout(this.pollTimer);
    const r = await this.#oauth('device/code', { client_id: this.#cfg().clientId, scope: SCOPE });
    if (!r.device_code) {
      throw Object.assign(new Error(`Google refused: ${r.error_description ?? r.error ?? 'no code'}. Check the Client ID (type must be "TVs and Limited Input devices").`), { status: 400 });
    }
    this.pending = {
      deviceCode: r.device_code,
      userCode: r.user_code,
      verificationUrl: r.verification_url ?? r.verification_uri ?? 'https://www.google.com/device',
      expiresAt: Date.now() + (r.expires_in ?? 1800) * 1000,
      interval: r.interval ?? 5,
    };
    this.lastError = null;
    this.log(`sign-in started: enter ${r.user_code} at ${this.pending.verificationUrl}`);
    this.#pollDevice(this.pending);
    return this.status();
  }

  cancelConnect() {
    clearTimeout(this.pollTimer);
    this.pending = null;
    return this.status();
  }

  #pollDevice(p) {
    this.pollTimer = setTimeout(async () => {
      if (this.pending !== p) return;
      if (Date.now() > p.expiresAt) {
        this.pending = null;
        this.lastError = 'The code expired. Press Connect again.';
        return;
      }
      try {
        const c = this.#cfg();
        const r = await this.#oauth('token', {
          client_id: c.clientId, client_secret: c.clientSecret, device_code: p.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (this.pending !== p) return;
        if (r.access_token) return await this.#onSignedIn(r);
        if (r.error === 'slow_down') p.interval += 5;
        else if (r.error !== 'authorization_pending') {
          this.pending = null;
          this.lastError = r.error === 'access_denied' ? 'Access was denied on the Google page.' : `Google: ${r.error_description ?? r.error}`;
          return;
        }
      } catch (err) {
        this.log(`sign-in poll: ${err.message}`); // network blip: keep trying
      }
      this.#pollDevice(p);
    }, p.interval * 1000);
    this.pollTimer.unref?.();
  }

  async #onSignedIn(r) {
    this.pending = null;
    if (!r.refresh_token) {
      this.lastError = 'Google did not return a long-term sign-in. Press Connect again.';
      return;
    }
    this.access = { token: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
    await this.settings.setInternal((d) => {
      d.youtube.refreshToken = r.refresh_token;
      d.youtube.tokenClientId = d.youtube.clientId;
    });
    let channel = null;
    try {
      const ch = await this.#api('GET', 'channels', { part: 'snippet', mine: 'true' });
      const c = ch.items?.[0];
      channel = c ? { id: c.id, title: c.snippet?.title ?? c.id } : null;
    } catch (err) {
      this.lastError = err.message;
    }
    await this.settings.setInternal((d) => {
      d.youtube.channel = channel;
    });
    this.log(`connected to YouTube${channel ? `: ${channel.title}` : ''}`);
    this.emit('connected', { channel });
    await this.check().catch(() => {});
  }

  async disconnect({ revoke = true } = {}) {
    clearTimeout(this.pollTimer);
    this.pending = null;
    const token = this.#cfg().refreshToken;
    if (revoke && token) {
      await fetch(`${this.oauthBase}/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }), signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    await this.settings.setInternal((d) => {
      d.youtube.refreshToken = '';
      d.youtube.tokenClientId = '';
      d.youtube.channel = null;
      d.youtube.broadcastId = null;
    });
    this.access = null;
    this.stream = null;
    this.broadcast = null;
    this.checkedAt = 0;
    this.log('disconnected from YouTube');
    return this.status();
  }

  // checks

  #tick() {
    if (!this.connected || this.busy) return;
    const every = (this.isStreaming() ? this.pollSeconds : this.idlePollSeconds) * 1000;
    if (Date.now() - this.checkedAt >= every) this.check().catch(() => {});
  }

  // Our stream (by key), YouTube's health for it, and the broadcast it feeds.
  async check() {
    if (!this.connected) return this.status();
    this.busy = true;
    try {
      const key = this.#cfg().streamKey;
      const s = key ? await this.#findStream(key) : null;
      this.stream = s && {
        id: s.id,
        title: s.snippet?.title ?? null,
        status: s.status?.streamStatus ?? null,
        health: s.status?.healthStatus?.status ?? null,
        issues: (s.status?.healthStatus?.configurationIssues ?? [])
          .map(({ type, severity, reason, description }) => ({ type, severity, reason, description })),
      };
      const previous = this.broadcast;
      const b = s ? await this.#boundBroadcast(s.id) : null;
      this.broadcast = b && this.#summary(b);
      if (b && b.id !== this.#cfg().broadcastId) {
        await this.settings.setInternal((d) => {
          d.youtube.broadcastId = b.id;
        });
      }
      this.checkedAt = Date.now();
      this.lastError = null;
      this.#onHealth();
      if (!b && s) await this.#maybeEnded(previous, s);
    } catch (err) {
      this.lastError = err.message;
      this.checkedAt = Date.now(); // don't hammer the API after an error
      this.log(`check failed: ${err.message}`);
    } finally {
      this.busy = false;
    }
    return this.status();
  }

  async #findStream(key) {
    let pageToken;
    for (let i = 0; i < 4; i++) {
      const r = await this.#api('GET', 'liveStreams', { part: 'id,snippet,cdn,status', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) });
      const s = r.items?.find((x) => x.cdn?.ingestionInfo?.streamName === key);
      if (s || !r.nextPageToken) return s ?? null;
      pageToken = r.nextPageToken;
    }
    return null;
  }

  async #boundBroadcast(streamId) {
    for (const broadcastStatus of ['active', 'upcoming']) {
      const r = await this.#api('GET', 'liveBroadcasts', { part: 'id,snippet,status,contentDetails', broadcastStatus, broadcastType: 'all', maxResults: '50' });
      const b = r.items?.find((x) => x.contentDetails?.boundStreamId === streamId);
      if (b) return b;
    }
    return null;
  }

  #summary(b) {
    return {
      id: b.id,
      title: b.snippet?.title ?? '',
      privacy: b.status?.privacyStatus ?? null,
      lifeCycle: b.status?.lifeCycleStatus ?? null,
      autoStart: b.contentDetails?.enableAutoStart ?? null,
      autoStop: b.contentDetails?.enableAutoStop ?? null,
      watchUrl: watchUrl(b.id),
      studioUrl: studioUrl(b.id),
    };
  }

  // Poor twice in a row (not a one-off blip) alerts once; recovery alerts once.
  #onHealth() {
    const status = this.stream?.health ?? null;
    if (status === 'bad') this.badCount++;
    else this.badCount = 0;
    if (this.badCount === 2 && !this.alertedBad) {
      this.alertedBad = true;
      this.emit('health', { status, previous: null, issues: this.stream.issues });
    } else if (this.alertedBad && (status === 'good' || status === 'ok')) {
      this.alertedBad = false;
      this.emit('health', { status, previous: 'bad', issues: this.stream.issues });
    }
  }

  // Nothing feeds from our key any more: if the broadcast we fed has ended
  // (YouTube or someone ended it) and we're streaming, start a new one.
  async #maybeEnded(previous, stream) {
    const lastId = previous?.id ?? this.#cfg().broadcastId;
    if (!lastId) return;
    const r = await this.#api('GET', 'liveBroadcasts', { part: 'id,snippet,status,contentDetails', id: lastId });
    const old = r.items?.[0];
    if (old && !['complete', 'revoked'].includes(old.status?.lifeCycleStatus)) return; // unbound, not ended
    await this.settings.setInternal((d) => {
      d.youtube.broadcastId = null;
    });
    const title = old?.snippet?.title ?? previous?.title ?? 'Live';
    let replacement = null;
    let error = null;
    if (this.isStreaming() && this.#cfg().autoRecreate && Date.now() - this.lastRecreateAt > RECREATE_COOLDOWN) {
      this.lastRecreateAt = Date.now();
      try {
        const b = await this.#createBroadcast({
          title, description: old?.snippet?.description ?? '', privacy: old?.status?.privacyStatus ?? 'unlisted', streamId: stream.id,
        });
        replacement = this.#summary(b);
        this.broadcast = replacement;
        this.#startInBackground(b.id);
      } catch (err) {
        error = err.message;
      }
    }
    this.log(`broadcast ended: ${title}${replacement ? ` — new one: ${replacement.watchUrl}` : ''}${error ? ` — ${error}` : ''}`);
    this.emit('broadcastEnded', { title, replacement, error });
  }

  // actions

  // A scheduled broadcast (Auto-start ON, Auto-stop OFF) bound to our key; a
  // new reusable key if YouTube doesn't know ours. Returns { broadcast, keyChanged }.
  async setup({ title = 'Live 24/7', privacy = 'unlisted', description = '' } = {}) {
    if (!this.connected) throw Object.assign(new Error('Connect YouTube first.'), { status: 409 });
    if (!['public', 'unlisted', 'private'].includes(privacy)) throw Object.assign(new Error('privacy must be public, unlisted or private'), { status: 400 });
    const t = String(title).trim().slice(0, 100);
    if (!t) throw Object.assign(new Error('A title is required.'), { status: 400 });
    const key = this.#cfg().streamKey;
    let s = key ? await this.#findStream(key) : null;
    let keyChanged = false;
    if (!s) {
      s = await this.#api('POST', 'liveStreams', { part: 'snippet,cdn,contentDetails,status' }, {
        snippet: { title: 'Stream Panel' },
        cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
        contentDetails: { isReusable: true },
      });
      const info = s.cdn?.ingestionInfo ?? {};
      if (!info.streamName) throw new Error('YouTube created a stream but returned no key.');
      await this.settings.setInternal((d) => {
        d.youtube.streamKey = info.streamName;
        if (info.ingestionAddress) d.youtube.rtmpUrl = info.ingestionAddress;
      });
      keyChanged = true;
    }
    const b = await this.#createBroadcast({ title: t, description, privacy, streamId: s.id });
    this.broadcast = this.#summary(b);
    this.log(`created broadcast "${t}" (${privacy})${keyChanged ? ' with a new stream key' : ''}: ${this.broadcast.watchUrl}`);
    this.checkedAt = 0;
    // Already streaming into this key: Auto-start won't fire, start it here.
    if (!keyChanged && s.status?.streamStatus === 'active') this.#startInBackground(b.id);
    return { broadcast: this.broadcast, keyChanged };
  }

  // Put a ready broadcast on air now.
  async goLive(id = this.broadcast?.id) {
    if (!id) throw Object.assign(new Error('No broadcast to start.'), { status: 409 });
    const get = async () => (await this.#api('GET', 'liveBroadcasts', { part: 'id,status,contentDetails', id })).items?.[0] ?? null;
    const b = await get();
    const state = b?.status?.lifeCycleStatus ?? null;
    if (state === 'live' || state === 'liveStarting') return state;
    if (!['ready', 'created', 'testing', 'testStarting'].includes(state)) {
      throw Object.assign(new Error(`The broadcast is "${state}", so it can't be started now.`), { status: 409 });
    }
    if (b.contentDetails?.enableAutoStart && (state === 'ready' || state === 'created')) return this.#bounce(id, b.contentDetails.boundStreamId, get);
    return this.#transition(id, state, get);
  }

  // Auto-start broadcast: off air until YouTube sees the stream inactive, then
  // back on; YouTube starts the broadcast itself (measured: ~10 s, then ~14 s).
  async #bounce(id, streamId, get) {
    const streamStatus = async () => (await this.#api('GET', 'liveStreams', { part: 'id,status', id: streamId })).items?.[0]?.status?.streamStatus;
    if (!this.pauseStream('Starting the YouTube broadcast (a short pause, no viewers yet)')) {
      throw Object.assign(new Error('The panel is not streaming, so YouTube will start the broadcast when the stream starts.'), { status: 409 });
    }
    try {
      for (let i = 0; i < 20; i++) {
        await this.#sleep(3000);
        if ((await streamStatus()) !== 'active') break;
      }
    } finally {
      this.resumeStream();
    }
    for (let i = 0; i < 20; i++) {
      await this.#sleep(3000);
      const state = (await get())?.status?.lifeCycleStatus;
      if (state === 'live' || state === 'liveStarting') return this.#started(id, state);
    }
    throw new Error('YouTube did not start the broadcast after the stream came back. Start it in Studio.');
  }

  // No Auto-start: ask for it. With the monitor stream on (the default)
  // YouTube may want ready -> testing -> live.
  async #transition(id, state, get) {
    const step = (to) => this.#api('POST', 'liveBroadcasts/transition', { broadcastStatus: to, id, part: 'id,status' });
    if (state === 'ready' || state === 'created') {
      try {
        await step('live');
        return this.#started(id, 'liveStarting');
      } catch (err) {
        if (err.reason === 'redundantTransition') return this.#started(id, 'liveStarting');
        if (err.reason !== 'invalidTransition') throw err;
      }
      await step('testing');
      for (let i = 0; i < 20 && (state = (await get())?.status?.lifeCycleStatus) !== 'testing'; i++) await this.#sleep(3000);
    }
    if (state === 'testing' || state === 'testStarting') {
      await step('live');
      return this.#started(id, 'liveStarting');
    }
    throw Object.assign(new Error(`The broadcast is "${state}", so it can't be started now.`), { status: 409 });
  }

  #started(id, state) {
    if (this.broadcast?.id === id) this.broadcast = { ...this.broadcast, lifeCycle: state };
    this.log('broadcast started');
    this.checkedAt = 0;
    return state;
  }

  #startInBackground(id) {
    this.goLive(id).catch((err) => {
      this.lastError = `Couldn't start the broadcast: ${err.message}`;
      this.log(this.lastError);
    });
  }

  #sleep(ms) {
    return new Promise((r) => setTimeout(r, ms * this.sleepScale));
  }

  async #createBroadcast({ title, description = '', privacy, streamId }) {
    const b = await this.#api('POST', 'liveBroadcasts', { part: 'snippet,status,contentDetails' }, {
      snippet: { title, description, scheduledStartTime: new Date(Date.now() + 60_000).toISOString() },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: false, enableDvr: true, latencyPreference: 'normal' },
    });
    const bound = await this.#api('POST', 'liveBroadcasts/bind', { id: b.id, part: 'id,snippet,status,contentDetails', streamId });
    await this.settings.setInternal((d) => {
      d.youtube.broadcastId = b.id;
    });
    return { ...b, ...bound, contentDetails: { ...b.contentDetails, ...bound.contentDetails } };
  }

  // Turn Auto-stop off. An update wipes every contentDetails field it doesn't
  // send (YouTube's rule), so send back what's there with that one change.
  async fixAutoStop() {
    const id = this.broadcast?.id;
    if (!id) throw Object.assign(new Error('No broadcast to change.'), { status: 409 });
    const r = await this.#api('GET', 'liveBroadcasts', { part: 'id,contentDetails', id });
    const cd = r.items?.[0]?.contentDetails;
    if (!cd) throw new Error('YouTube no longer has that broadcast.');
    const keep = ['enableAutoStart', 'enableDvr', 'enableEmbed', 'enableClosedCaptions', 'closedCaptionsType', 'recordFromStart', 'latencyPreference', 'enableLowLatency', 'projection'];
    const contentDetails = {
      monitorStream: {
        enableMonitorStream: cd.monitorStream?.enableMonitorStream ?? true,
        broadcastStreamDelayMs: cd.monitorStream?.broadcastStreamDelayMs ?? 0,
      },
      enableAutoStop: false,
    };
    for (const k of keep) if (cd[k] !== undefined) contentDetails[k] = cd[k];
    const b = await this.#api('PUT', 'liveBroadcasts', { part: 'contentDetails' }, { id, contentDetails });
    this.broadcast = { ...this.broadcast, autoStop: b.contentDetails?.enableAutoStop ?? false };
    this.log('turned Auto-stop off for the broadcast');
    return this.status();
  }

  // transport

  async #oauth(path, params) {
    const res = await fetch(`${this.oauthBase}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
    return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  }

  async #token() {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    const c = this.#cfg();
    const r = await this.#oauth('token', {
      client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token',
    });
    if (!r.access_token) {
      if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(r.error)) {
        // Revoked, expired (an app left in "Testing" logs out after 7 days),
        // or the client was deleted: the owner must connect again.
        const error = r.error_description ?? r.error;
        await this.settings.setInternal((d) => {
          d.youtube.refreshToken = '';
        });
        this.access = null;
        this.emit('authLost', { error });
        throw new Error(`YouTube sign-in no longer valid (${error}). Connect again.`);
      }
      throw new Error(`Google token refresh failed: ${r.error_description ?? r.error}`);
    }
    this.access = { token: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  async #api(method, path, query = {}, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#token();
      const res = await fetch(`${this.apiBase}/${path}?${new URLSearchParams(query)}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if (res.status === 401 && attempt === 0) {
        this.access = null; // expired early: refresh once
        continue;
      }
      throw apiError(res.status, data);
    }
    throw new Error('unreachable');
  }
}
