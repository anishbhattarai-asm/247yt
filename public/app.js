// Stream Panel UI — vanilla JS, talks to the REST API on the same origin.
// All user-supplied text (titles, URLs, errors) goes in via textContent only.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  status: null,
  statusAt: 0,
  media: null,
  config: null,
  obs: null,
  tab: 'overview',
  kind: 'video',
  dragging: false,
  logSeq: 0,
  logLines: [],
  logPaused: false,
  logFilter: '',
  uploads: new Map(), // client-side upload rows: key -> { name, done, total, failed, cancelled, id }
};

// helpers

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, url, body, { raw } = {}) {
  const headers = { 'x-requested-with': 'stream-panel' };
  let payload;
  if (raw) {
    headers['content-type'] = 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    showLogin();
    throw new ApiError('Signed out', 401);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data;
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function icon(name, cls = 'i') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const pad = (n) => String(n).padStart(2, '0');
function clock(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  s = Math.max(0, Math.floor(s));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return hh ? `${hh}:${pad(mm)}:${pad(s % 60)}` : `${mm}:${pad(s % 60)}`;
}
function span(s) {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400 * 2) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}
function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}
// A button that opens another site in a new tab.
function extLink(label, href) {
  return h('a', { class: 'btn btn-small', href, target: '_blank', rel: 'noopener' }, label, icon('external', 'i i-sm'));
}
const GUIDE_URL = 'https://github.com/anishbhattarai-asm/247yt';
const LINKS = {
  studio: 'https://studio.youtube.com/channel/UC/livestreaming/manage',
  discordHelp: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
  healthchecks: 'https://healthchecks.io/',
};

const getPath = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) o = o[k] ??= {};
  o[parts.at(-1)] = value;
}

function toast(message, tone = 'ok') {
  const el = h('div', { class: `toast ${tone}`, role: tone === 'bad' ? 'alert' : 'status' },
    icon(tone === 'bad' ? 'alert' : 'check'), h('span', {}, message));
  $('#toasts').append(el);
  setTimeout(() => el.remove(), tone === 'bad' ? 6000 : 3500);
}

function confirmDialog(title, text, ok = 'OK') {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

async function act(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success);
    return r;
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'bad');
    return null;
  }
}

// auth

function showLogin(passwordSet = true, setupCodeRequired = false) {
  const setup = !passwordSet && setupCodeRequired;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form').hidden = setup;
  $('#setup-form').hidden = !setup;
  $('#login-hint').textContent = passwordSet || setup ? '' : 'No password yet. On the server run: npm run set-password';
  (setup ? $('#setup-code') : $('#login-password')).focus();
}

async function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  await Promise.all([loadConfig(), loadMedia(), loadStatus()]);
  scheduleLoops();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.textContent = '';
  try {
    await api('POST', '/api/auth/login', { password: $('#login-password').value });
    $('#login-password').value = '';
    showApp();
  } catch (e2) {
    err.textContent = e2.message;
  }
});

// First visit: setup code + new password. The browser's time zone goes along
// so the weekly reconnect happens at night where the owner lives.
$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#setup-error');
  err.textContent = '';
  const password = $('#setup-password').value;
  if (password !== $('#setup-password2').value) {
    err.textContent = 'The two passwords are not the same.';
    return;
  }
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {}
  try {
    await api('POST', '/api/auth/setup', { code: $('#setup-code').value, password, timeZone });
    $('#setup-form').reset();
    await showApp();
    toast('Password set. You are signed in.');
  } catch (e2) {
    err.textContent = e2.message;
    if (e2.status === 409) {
      const s = await api('GET', '/api/auth/session').catch(() => null);
      if (s?.passwordSet) showLogin(true);
    }
  }
});

$('#logout').addEventListener('click', async () => {
  closeTerminal();
  await api('POST', '/api/auth/logout').catch(() => {});
  showLogin();
});

// tabs

function selectTab(tab) {
  state.tab = tab;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const s of $$('.tab')) s.hidden = s.id !== `tab-${tab}`;
  if (tab === 'logs') loadLogs();
  if (tab === 'terminal') loadTerminal().catch(() => {});
  if (tab === 'library') loadMedia();
  if (tab === 'settings') {
    renderConfig();
    loadObs().catch(() => {});
  }
  history.replaceState(null, '', `#${tab}`);
}
for (const b of $$('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));

// polling

let timers = {};
function loop(name, fn, interval) {
  clearTimeout(timers[name]);
  const run = async () => {
    if (!$('#app').hidden && document.visibilityState === 'visible') await fn().catch(() => {});
    timers[name] = setTimeout(run, typeof interval === 'function' ? interval() : interval);
  };
  timers[name] = setTimeout(run, typeof interval === 'function' ? interval() : interval);
}
function scheduleLoops() {
  loop('status', loadStatus, 2000);
  loop('media', loadMedia, () => (busyMedia() ? 1500 : 6000));
  loop('logs', () => (state.tab === 'logs' && !state.logPaused ? loadLogs() : Promise.resolve()), 2000);
  loop('tick', async () => renderNowTick(), 1000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#app').hidden) loadStatus().catch(() => {});
});
const busyMedia = () => state.media?.items.some((i) => ['downloading', 'uploading', 'queued', 'normalizing'].includes(i.status)) || state.uploads.size > 0;

// status / overview

async function loadStatus() {
  state.status = await api('GET', '/api/stream/status');
  state.statusAt = Date.now();
  renderStatus();
}

const PHASES = {
  live: ['LIVE', 'live', 'On air'],
  starting: ['Starting', 'info', 'Starting'],
  reconnecting: ['Reconnecting', 'warn', 'Reconnecting'],
  waiting: ['Waiting', 'warn', 'Waiting'],
  stopping: ['Stopping', 'info', 'Stopping'],
  stopped: ['Off air', 'idle', 'Off air'],
};

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const [label, tone, eyebrow] = PHASES[s.phase] ?? PHASES.stopped;
  const pill = $('#top-status');
  pill.dataset.tone = tone;
  $('.pill-text', pill).textContent = label;
  $('#now-label').textContent = eyebrow;

  // Banner: the one thing to fix, if any.
  let problem = null;
  if (s.needsStreamKey) problem = 'Add your YouTube stream key in Settings before starting.';
  else if (s.phase === 'waiting' && s.problem) problem = s.problem;
  else if (s.phase === 'reconnecting' && (s.hint || s.lastError)) problem = s.hint ? `${s.hint} (FFmpeg: ${s.lastError})` : `FFmpeg: ${s.lastError}`;
  else if (!s.desired && s.playable) problem = s.playable;
  const banner = $('#banner');
  banner.hidden = !problem;
  banner.replaceChildren(icon('alert'), h('span', {}, problem ?? ''));

  // Now playing
  const air = s.onAir;
  const obsLive = Boolean(air?.live);
  $('#now-title').textContent = air?.title ?? (s.desired ? 'Getting ready…' : 'Nothing playing');
  let sub = '';
  if (obsLive && s.phase === 'live') sub = 'Live from OBS. The playlist carries on when OBS stops streaming.';
  else if (s.phase === 'reconnecting' && s.nextRetryAt) sub = `Off air since ${new Date(s.downSince).toLocaleTimeString()} · retrying in ${Math.max(0, Math.round((s.nextRetryAt - Date.now()) / 1000))} s`;
  else if (s.phase === 'reconnecting') sub = 'Reconnecting to YouTube…';
  else if (!s.desired) sub = 'Press Start to go live.';
  $('#now-sub').textContent = sub;
  $('#next-title').textContent = s.next ?? '—';

  $('#btn-start').hidden = s.desired;
  $('#btn-stop').hidden = !s.desired;
  $('#btn-skip').disabled = s.phase !== 'live' || obsLive;
  $('#btn-restart').disabled = s.phase !== 'live';

  // Stream stats
  $('#st-uptime').textContent = s.sessionStartedAt ? span((Date.now() - s.sessionStartedAt) / 1000) : '—';
  $('#st-mode').textContent = s.mode === 'lofi' ? 'Lofi' : 'Video';
  $('#st-order').textContent = { sequential: 'In order', shuffle: 'Shuffle', 'repeat-one': 'Repeat one' }[s.order] ?? s.order;
  $('#st-boundaries').textContent = s.running ? String(s.boundaries) : '—';
  // Behind real time (0 when on schedule; the stream runs slightly ahead).
  $('#st-lag').textContent = s.running && Number.isFinite(s.lag) ? `${Math.max(0, s.lag * 1000).toFixed(0)} ms` : '—';
  const eg = s.health?.egress;
  $('#st-egress').textContent = eg ? `${eg.gb.toFixed(1)} GB sent` : '—';

  // Server
  const sys = s.system;
  $('#sys-cpu').textContent = `${sys.cpuPercent}% of ${sys.cores} cores`;
  $('#sys-mem').textContent = `${Math.round(100 * (1 - sys.memory.freeBytes / sys.memory.totalBytes))}% of ${bytes(sys.memory.totalBytes)} · panel ${bytes(sys.memory.processBytes)}`;
  if (sys.disk) {
    const freePct = (100 * sys.disk.freeBytes) / sys.disk.totalBytes;
    const bar = $('#sys-disk-bar');
    bar.style.width = `${freePct.toFixed(1)}%`;
    bar.style.background = freePct < 10 ? 'var(--accent)' : freePct < 25 ? 'var(--warn)' : 'var(--ok)';
    $('#sys-disk').textContent = `${bytes(sys.disk.freeBytes)} of ${bytes(sys.disk.totalBytes)}`;
  }
  $('#sys-up').textContent = span(sys.uptimeSeconds);
  const n = s.normalizer;
  $('#sys-norm').textContent = n.current ? `1 file${n.queued.length ? ` + ${n.queued.length} queued` : ''}` : 'idle';

  // Access & alerts
  $('#acc-url').textContent = s.panelUrl ?? (s.tunnel.enabled ? (s.tunnel.error ?? 'starting tunnel…') : 'tunnel off (local only)');
  $('#copy-url').hidden = !s.panelUrl;
  const f = s.finder;
  $('#acc-finder-row').hidden = !f?.port;
  if (f?.port) $('#acc-finder').textContent = f.url ?? (f.error ? `Error: ${f.error}` : 'finding this server\'s address…');
  $('#copy-finder').hidden = !f?.url;
  const d = s.discord;
  setStatusText($('#acc-discord'), !d.configured ? ['Not set up', 'muted'] : d.lastError && d.failed ? [`Error: ${d.lastError}`, 'bad'] : [`On · ${d.sent} sent`, 'ok']);
  const hc = s.health.healthcheck;
  setStatusText($('#acc-health'), !hc.configured ? ['Not set up', 'muted']
    : hc.at ? [`${hc.ok ? 'OK' : 'Reporting a problem'} · ${span((Date.now() - hc.at) / 1000)} ago`, hc.ok ? 'ok' : 'warn'] : ['Waiting for first ping', 'muted']);
  setStatusText($('#acc-obs'), obsStatus(s.obs));
  setStatusText($('#acc-yt'), ytOverview(s.youtube));
  renderYouTube(s.youtube);
  setStatusText($('#st-also'), rsOverview(s.restream ?? []));
  renderRestream(s.restream ?? []);

  renderGuide(s);
  renderNowTick();
  if (state.tab === 'library') markOnAir();
}

// Getting started: what's left to do, each with a button to the right place.
// Hidden for good once everything is done or "Hide" is pressed (per browser).
const GUIDE_HIDDEN = 'stream-panel.guide-hidden';
const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const recall = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

function goToField(name) {
  selectTab('settings');
  const el = $(`#tab-settings [name="${name}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus({ preventScroll: true });
}
const goBtn = (label, name) => h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => goToField(name) }, label);

function guideSteps(s) {
  return [
    {
      done: !s.needsStreamKey,
      title: 'Add your YouTube stream key',
      text: 'In YouTube Studio: Create, Go live, Manage, Schedule stream (Streaming software). Turn Auto-stop off and copy its key. Or connect your channel under Settings and the panel makes the broadcast for you.',
      actions: [extLink('Open YouTube Studio', LINKS.studio), goBtn('Paste it in Settings', 'youtube.streamKey')],
    },
    {
      done: !s.playable,
      title: 'Add videos, or a background and music',
      text: 'Paste a Google Drive or Dropbox link (the server downloads it itself) or drop files. Each file is converted once.',
      actions: [h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => selectTab('library') }, 'Open Library')],
    },
    {
      done: s.discord.configured,
      optional: true,
      title: 'Get alerts in Discord',
      text: 'Stream started, dropped or back, YouTube health, and the panel\'s new link whenever it changes.',
      actions: [extLink('How to make a webhook', LINKS.discordHelp), goBtn('Paste it in Settings', 'notifications.discordWebhookUrl')],
    },
    {
      done: s.health.healthcheck.configured,
      optional: true,
      title: 'Hear about it if the whole server goes down',
      text: 'A free Healthchecks.io check (period 5 min, grace 10 min) with its Discord integration.',
      actions: [extLink('Open Healthchecks.io', LINKS.healthchecks), goBtn('Paste it in Settings', 'healthcheck.url')],
    },
    {
      done: s.desired,
      title: 'Press Start',
      text: 'The stream runs on the server: you can close this page, or your computer.',
      actions: [],
    },
  ];
}

let guideKey = '';
function renderGuide(s) {
  const card = $('#guide');
  const steps = guideSteps(s);
  if (steps.every((x) => x.done)) remember(GUIDE_HIDDEN, '1');
  if (recall(GUIDE_HIDDEN) === '1') {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const key = steps.map((x) => (x.done ? 1 : 0)).join('');
  if (key === guideKey) return;
  guideKey = key;
  $('#guide-steps').replaceChildren(...steps.map((st, i) => h('li', { class: `step${st.done ? ' done' : ''}` },
    h('span', { class: 'step-mark', 'aria-label': st.done ? 'Done' : `Step ${i + 1}` }, st.done ? icon('check') : String(i + 1)),
    h('div', { class: 'step-body' },
      h('div', { class: 'step-title' }, st.title, st.optional ? h('span', { class: 'tag' }, 'optional') : null),
      st.done ? null : h('p', { class: 'muted small' }, st.text),
      st.done || !st.actions.length ? null : h('div', { class: 'btn-row' }, ...st.actions)))));
}

$('#guide-hide').addEventListener('click', () => {
  remember(GUIDE_HIDDEN, '1');
  $('#guide').hidden = true;
});

function obsStatus(o) {
  if (!o?.enabled) return ['Off', 'muted'];
  if (o.state === 'live' && o.keyint > 4) {
    return [`Live for ${span((Date.now() - o.since) / 1000)} · keyframes every ${Math.round(o.keyint)} s: set Keyframe Interval to 2 in OBS`, 'warn'];
  }
  if (o.state === 'live') return [`Live for ${span((Date.now() - o.since) / 1000)}`, 'ok'];
  if (o.state === 'connected') return ['OBS connected, taking over…', 'ok'];
  if (o.lastError) return [`Waiting · last refused: ${o.lastError}`, 'warn'];
  return o.state === 'listening' ? [`Waiting for OBS (UDP ${o.port})`, 'muted'] : ['Starting…', 'muted'];
}

function setStatusText(el, [text, cls]) {
  el.textContent = text;
  el.className = cls;
}

// Smooth position between polls.
function renderNowTick() {
  const s = state.status;
  if (!s) return;
  const air = s.onAir;
  const item = air && state.media?.items.find((i) => i.id === air.id);
  let pos = air?.position ?? 0;
  if (air && s.phase === 'live') pos += (Date.now() - state.statusAt) / 1000;
  const dur = item?.duration ?? null;
  if (dur) pos = Math.min(pos, dur);
  $('#now-pos').textContent = air ? clock(pos) : '';
  $('#now-dur').textContent = dur ? clock(dur) : '';
  $('#now-bar').style.width = air && dur ? `${(100 * pos) / dur}%` : '0%';
}

$('#btn-start').addEventListener('click', () => act(async () => {
  await api('POST', '/api/stream/start');
  await loadStatus();
}, 'Starting the stream'));

$('#btn-stop').addEventListener('click', async () => {
  if (!(await confirmDialog('Stop the stream?', 'Viewers will see the stream end. In YouTube Studio the broadcast stays open (Auto-stop is off) until you end it there.', 'Stop'))) return;
  await act(async () => {
    await api('POST', '/api/stream/stop');
    await loadStatus();
  }, 'Stream stopped');
});

$('#btn-skip').addEventListener('click', () => act(async () => {
  await api('POST', '/api/stream/skip');
  setTimeout(() => loadStatus().catch(() => {}), 2500);
}, 'Skipping to the next file'));

$('#btn-restart').addEventListener('click', async () => {
  if (!(await confirmDialog('Restart the connection?', 'A clean reconnect to YouTube. It happens automatically every few days; viewers see at most a second of buffering.', 'Restart'))) return;
  act(() => api('POST', '/api/stream/restart'), 'Reconnecting');
});

$('#copy-url').addEventListener('click', async () => {
  const url = state.status?.panelUrl;
  if (url) await act(() => navigator.clipboard.writeText(url), 'Link copied');
});
$('#copy-finder').addEventListener('click', async () => {
  const url = state.status?.finder?.url;
  if (url) await act(() => navigator.clipboard.writeText(url), 'Stable link copied');
});

// library

const KIND = {
  video: { icon: 'film', label: 'videos', hint: 'Videos play in order (or shuffled) in Video mode. Every file is converted once to the stream format.' },
  audio: { icon: 'music', label: 'tracks', hint: 'Audio tracks for Lofi mode, played over your background. Volume is evened out automatically.' },
  background: { icon: 'image', label: 'backgrounds', hint: 'An image or GIF shown during Lofi mode. Pick which one in Settings or with "Use".' },
};

async function loadMedia() {
  if (state.dragging) return;
  state.media = await api('GET', '/api/media');
  renderMedia();
  if (state.tab === 'settings') renderBackgroundSelect();
}

for (const b of $$('#kind-tabs button')) {
  b.addEventListener('click', () => {
    state.kind = b.dataset.kind;
    for (const x of $$('#kind-tabs button')) x.setAttribute('aria-selected', String(x === b));
    renderMedia();
  });
}

function statusBadge(item) {
  const t = item.transfer;
  const pct = (v) => `${Math.round(v * 100)}%`;
  switch (item.status) {
    case 'downloading':
      return [h('span', { class: 'badge busy' }, t?.total ? `Downloading ${pct(t.received / t.total)}` : `Downloading ${bytes(t?.received ?? 0)}`), t?.total ? t.received / t.total : null];
    case 'uploading':
      return [h('span', { class: 'badge busy' }, 'Uploading'), t?.total ? t.received / t.total : null];
    case 'queued':
      return [h('span', { class: 'badge' }, item.queuePosition ? `Waiting to convert (#${item.queuePosition})` : 'Waiting to convert'), null];
    case 'normalizing': {
      const eta = Number.isFinite(item.eta) ? ` · ${span(item.eta)} left` : '';
      return [h('span', { class: 'badge busy' }, item.progress != null ? `Converting ${pct(item.progress)}${eta}` : 'Converting'), item.progress];
    }
    case 'failed':
      return [h('span', { class: 'badge bad' }, 'Failed'), null];
    default:
      return item.quarantined ? [h('span', { class: 'badge warn' }, 'Skipped: would not play'), null] : [null, null];
  }
}

function renderMedia() {
  const m = state.media;
  if (!m) return;
  for (const k of Object.keys(KIND)) $(`[data-count="${k}"]`).textContent = m.items.filter((i) => i.kind === k).length;
  $('#lib-total').textContent = m.totalBytes ? `${bytes(m.totalBytes)} of media` : '';
  $('#kind-hint').textContent = KIND[state.kind].hint;

  const items = m.items.filter((i) => i.kind === state.kind || (i.kind === 'auto' && state.kind === 'video'));
  const list = $('#media-list');
  list.replaceChildren(...items.map(mediaRow));
  $('#media-empty').hidden = items.length > 0;
  $('#media-empty').textContent = `No ${KIND[state.kind].label} yet — import a link or upload files above.`;
  renderUploads();
  markOnAir();
}

function mediaRow(item) {
  const [badge, progress] = statusBadge(item);
  const isBg = item.kind === 'background';
  const inUse = isBg && state.media.backgroundId === item.id;
  const meta = h('div', { class: 'meta' },
    badge,
    item.status === 'ready' && item.duration && !isBg ? h('span', {}, clock(item.duration)) : null,
    item.status === 'ready' && item.bytes ? h('span', {}, bytes(item.bytes)) : null,
    inUse ? h('span', { class: 'badge ok' }, 'In use') : null,
    h('span', { class: 'badge live air-badge', hidden: true }, 'ON AIR'),
  );
  const actions = h('div', { class: 'actions' },
    isBg && item.status === 'ready' && !inUse ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => useBackground(item) }, 'Use') : null,
    item.quarantined ? h('button', { class: 'btn btn-small', onclick: () => retry(item) }, 'Retry') : null,
    h('button', { class: 'icon-btn', title: 'Rename', 'aria-label': `Rename ${item.title}`, onclick: (e) => rename(item, e.currentTarget.closest('li')) }, icon('edit')),
    h('button', { class: 'icon-btn', title: 'Delete', 'aria-label': `Delete ${item.title}`, onclick: () => remove(item) }, icon('trash')),
  );
  const handle = h('button', { class: 'handle', title: 'Drag to reorder (or use arrow keys)', 'aria-label': `Move ${item.title}` }, icon('grip'));
  const li = h('li', { class: 'media', dataset: { id: item.id } },
    handle,
    h('span', { class: 'kind-icon' }, icon(KIND[item.kind]?.icon ?? 'film')),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, item.title),
      meta,
      item.status === 'failed' && item.error ? h('div', { class: 'error' }, item.error) : null,
      progress != null ? h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: `width:${Math.round(progress * 100)}%` })) : null,
    ),
    actions,
  );
  enableDrag(li, handle);
  return li;
}

function markOnAir() {
  const id = state.status?.onAir?.id;
  for (const li of $$('#media-list .media')) {
    const on = li.dataset.id === id && state.status?.phase === 'live';
    li.classList.toggle('on-air', on);
    const b = $('.air-badge', li);
    if (b) b.hidden = !on;
  }
}

async function useBackground(item) {
  await act(async () => {
    await api('PUT', '/api/config', { lofi: { backgroundId: item.id } });
    await Promise.all([loadMedia(), loadConfig()]);
  }, `"${item.title}" is now the lofi background`);
}

async function retry(item) {
  await act(async () => {
    await api('PATCH', `/api/media/${item.id}`, { quarantined: false });
    await loadMedia();
  }, 'Back in the playlist');
}

async function remove(item) {
  if (!(await confirmDialog(`Delete "${item.title}"?`, 'The converted file is removed from the server. This cannot be undone.', 'Delete'))) return;
  await act(async () => {
    await api('DELETE', `/api/media/${item.id}`);
    await loadMedia();
  }, 'Deleted');
}

function rename(item, li) {
  const title = $('.title', li);
  const input = h('input', { class: 'rename', value: item.title, 'aria-label': 'New title', maxlength: '200' });
  title.replaceWith(input);
  input.focus();
  input.select();
  state.dragging = true; // hold off re-renders while typing
  const done = async (save) => {
    state.dragging = false;
    if (save && input.value.trim() && input.value.trim() !== item.title) {
      await act(() => api('PATCH', `/api/media/${item.id}`, { title: input.value.trim() }), 'Renamed');
    }
    loadMedia();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true), { once: true });
}

// Drag to reorder with a handle — pointer events work for mouse and touch.
function enableDrag(li, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    state.dragging = true;
    li.classList.add('dragging');
    const list = li.parentElement;
    const move = (ev) => {
      const siblings = [...list.children].filter((x) => x !== li);
      const after = siblings.find((x) => {
        const r = x.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      if (after) list.insertBefore(li, after);
      else list.append(li);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      li.classList.remove('dragging');
      state.dragging = false;
      saveOrder(list);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const sib = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling;
    if (!sib) return;
    if (e.key === 'ArrowUp') sib.before(li);
    else sib.after(li);
    handle.focus();
    saveOrder(li.parentElement);
  });
}

async function saveOrder(list) {
  const order = [...list.children].map((li) => li.dataset.id);
  const before = state.media.items.filter((i) => order.includes(i.id)).map((i) => i.id);
  if (order.join() === before.join()) return;
  await act(async () => {
    state.media = { ...state.media, ...(await api('PUT', '/api/media/order', { order })) };
    renderMedia();
  }, 'Order saved — applies at the next file change');
}

// Import from a link
$('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#import-url').value.trim();
  const ok = await act(() => api('POST', '/api/media/import', { url, kind: state.kind }), 'Downloading on the server…');
  if (ok) {
    $('#import-url').value = '';
    loadMedia();
  }
});

// Upload files in chunks
const dz = $('#dropzone');
$('#file-input').addEventListener('change', (e) => {
  queueUploads([...e.target.files]);
  e.target.value = '';
});
dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('over');
});
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  queueUploads([...e.dataTransfer.files]);
});

let uploadChain = Promise.resolve();
function queueUploads(files) {
  for (const file of files) {
    const key = `${Date.now()}-${Math.random()}`;
    state.uploads.set(key, { name: file.name, done: 0, total: file.size, failed: null, cancelled: false, id: null });
    renderUploads();
    uploadChain = uploadChain.then(() => uploadFile(key, file, state.kind));
  }
}

async function uploadFile(key, file, kind) {
  const u = state.uploads.get(key);
  try {
    const { id, chunkSize, chunks } = await api('POST', '/api/media/uploads', { filename: file.name, size: file.size, kind });
    u.id = id;
    for (let i = 0; i < chunks; i++) {
      if (u.cancelled) throw new Error('cancelled');
      const blob = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize));
      for (let attempt = 1; ; attempt++) {
        try {
          await api('PUT', `/api/media/uploads/${id}/chunks/${i}`, undefined, { raw: blob });
          break;
        } catch (err) {
          if (attempt >= 4 || err.status === 400 || err.status === 404) throw err;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
      u.done = Math.min(file.size, (i + 1) * chunkSize);
      renderUploads();
    }
    await api('POST', `/api/media/uploads/${id}/complete`);
    state.uploads.delete(key);
    toast(`Uploaded "${file.name}" — converting`);
  } catch (err) {
    if (u.cancelled) {
      state.uploads.delete(key);
      if (u.id) await api('DELETE', `/api/media/${u.id}`).catch(() => {});
    } else {
      u.failed = err.message;
    }
  }
  renderUploads();
  loadMedia().catch(() => {});
}

function renderUploads() {
  const box = $('#uploads');
  box.replaceChildren(...[...state.uploads].map(([key, u]) => h('div', { class: `upload${u.failed ? ' failed' : ''}` },
    h('span', {}, u.failed ? `${u.name} — ${u.failed}` : `${u.name} · ${bytes(u.done)} of ${bytes(u.total)}`),
    h('button', {
      class: 'icon-btn small',
      title: u.failed ? 'Dismiss' : 'Cancel upload',
      'aria-label': u.failed ? 'Dismiss' : 'Cancel upload',
      onclick: () => {
        if (u.failed) state.uploads.delete(key);
        else u.cancelled = true;
        renderUploads();
      },
    }, icon('x')),
    u.failed ? null : h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: `width:${u.total ? (100 * u.done) / u.total : 0}%` })),
  )));
}

// settings

async function loadConfig() {
  state.config = await api('GET', '/api/config');
  if (state.tab === 'settings') renderConfig();
}

// Every IANA zone the browser knows, plus the saved one if it isn't listed.
function fillTimeZones(c) {
  const sel = $('#tz-select');
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {}
  const saved = c.restart.timeZone;
  if (saved && !zones.includes(saved)) zones = [saved, ...zones];
  sel.replaceChildren(h('option', { value: '' }, `The server's (${c.serverTimeZone ?? 'unknown'})`),
    ...zones.map((z) => h('option', { value: z }, z.replaceAll('_', ' '))));
}

function renderConfig() {
  const c = state.config;
  if (!c) return;
  fillTimeZones(c);
  for (const el of $$('#tab-settings [name]')) {
    const key = el.name;
    const value = getPath(c, key);
    if (el.type === 'password') {
      el.value = '';
      const env = c.envOverrides.includes(key);
      el.disabled = env;
      el.placeholder = env ? 'Set by the server environment' : el.placeholder;
      continue;
    }
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else if (value !== undefined && value !== null && typeof value !== 'object') el.value = String(value);
  }
  for (const badge of $$('#tab-settings .state[data-state]')) {
    const key = badge.dataset.state;
    const set = Boolean(getPath(c, key)?.set);
    const env = c.envOverrides.includes(key);
    badge.textContent = env ? 'From environment' : set ? 'Set' : 'Not set';
    badge.classList.toggle('set', set);
    $(`[data-clear="${key}"]`).hidden = !set || env;
  }
  for (const seg of $$('[data-radio]')) {
    const v = getPath(c, seg.dataset.radio);
    for (const b of $$('button', seg)) b.setAttribute('aria-selected', String(b.dataset.value === v));
  }
  $('[data-lofi-only]').hidden = c.mode !== 'lofi';
  $('#obs-details').hidden = !c.obs.enabled;
  renderBackgroundSelect();
  const prof = $('[data-form="profile"]');
  prof.classList.toggle('locked', c.profileLocked);
  for (const el of $$('input, select, button', prof)) el.disabled = c.profileLocked;
  $('#profile-note').textContent = c.profileLocked
    ? 'Locked: every file in the library was converted to this format, and the stream needs them all to match. Delete all media to change it.'
    : 'Every upload is converted to this format once. Choose before adding media — it locks after the first file.';
}

function renderBackgroundSelect() {
  const sel = $('[name="lofi.backgroundId"]');
  const bgs = (state.media?.items ?? []).filter((i) => i.kind === 'background' && i.status === 'ready');
  const current = state.config?.lofi.backgroundId ?? '';
  sel.replaceChildren(h('option', { value: '' }, bgs.length ? 'Choose a background…' : 'Add an image or GIF in Library first'),
    ...bgs.map((b) => h('option', { value: b.id, selected: b.id === current }, b.title)));
  sel.value = current;
}

async function saveConfig(patch, message = 'Saved') {
  const ok = await act(async () => {
    state.config = await api('PUT', '/api/config', patch);
    renderConfig();
    loadStatus().catch(() => {});
    if (patch.obs) loadObs().catch(() => {});
    if (patch.youtube) ytKey = '';
  }, message);
  return ok !== null;
}

for (const seg of $$('[data-radio]')) {
  for (const b of $$('button', seg)) {
    b.addEventListener('click', () => {
      const patch = {};
      setPath(patch, seg.dataset.radio, b.dataset.value);
      saveConfig(patch, 'Saved — applies at the next file change');
    });
  }
}
$('#btn-my-tz').addEventListener('click', () => {
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {}
  if (!tz) return toast('This browser does not say its time zone. Pick it from the list.', 'bad');
  saveConfig({ restart: { timeZone: tz } }, `Time zone set to ${tz.replaceAll('_', ' ')}`);
});

$('[name="lofi.backgroundId"]').addEventListener('change', (e) => {
  if (e.target.value) saveConfig({ lofi: { backgroundId: e.target.value } }, 'Background set');
});

function formPatch(form) {
  const patch = {};
  for (const el of $$('[name]', form)) {
    if (el.disabled || ['current', 'next'].includes(el.name)) continue;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'password') {
      if (!el.value.trim()) continue; // secrets: only send when typed
      v = el.value.trim();
    } else if (el.type === 'number' || el.name === 'profile.fps') v = Number(el.value);
    else v = el.value.trim();
    setPath(patch, el.name, v);
  }
  return patch;
}

for (const form of $$('#tab-settings form[data-form]')) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.dataset.form === 'access') return saveAccess(form);
    const patch = formPatch(form);
    if (Object.keys(patch).length) await saveConfig(patch);
  });
}

$('#btn-signout-others').addEventListener('click', async () => {
  if (!(await confirmDialog('Sign out all other browsers?', 'Every other phone or computer signed in to this panel has to sign in again. This one stays signed in.', 'Sign them out'))) return;
  act(() => api('POST', '/api/auth/logout-others'), 'Every other browser is signed out');
});

async function saveAccess(form) {
  const patch = formPatch(form);
  if (patch.tunnel?.enabled !== state.config.tunnel.enabled) await saveConfig(patch);
  const current = $('[name="current"]', form).value;
  const next = $('[name="next"]', form).value;
  if (current || next) {
    const ok = await act(() => api('POST', '/api/auth/password', { current, next }), 'Password changed — other browsers are signed out');
    if (ok) form.reset();
  }
}

for (const b of $$('[data-clear]')) {
  b.addEventListener('click', async () => {
    const label = b.closest('.field').querySelector('span').firstChild.textContent.trim();
    if (!(await confirmDialog(`Remove the ${label.toLowerCase()}?`, 'It is deleted from the server.', 'Remove'))) return;
    const patch = {};
    setPath(patch, b.dataset.clear, '');
    saveConfig(patch, 'Removed');
  });
}

// YouTube account

const YT_HEALTH = { good: ['Excellent', 'ok'], ok: ['OK', 'ok'], bad: ['Poor', 'bad'], noData: ['No data', 'muted'] };
const YT_LIFE = {
  live: 'Live', liveStarting: 'Starting', ready: 'Ready, starts with the stream', created: 'Created',
  testing: 'Testing', testStarting: 'Testing', complete: 'Ended', revoked: 'Removed',
};

function ytOverview(y) {
  if (!y?.connected) return [y?.pending ? 'Waiting for the Google code' : 'Not connected', 'muted'];
  const [label, tone] = YT_HEALTH[y.stream?.health] ?? ['Checking…', 'muted'];
  if (!y.broadcast) return [`${label} · no broadcast on this key`, 'warn'];
  return [`${label} · ${(YT_LIFE[y.broadcast.lifeCycle] ?? y.broadcast.lifeCycle).split(',')[0]}`, tone];
}

// Re-rendered only when what it shows changes, so typing isn't wiped.
let ytKey = '';
function renderYouTube(y) {
  if (!y) return;
  const key = JSON.stringify({ ...y, checkedAt: null, cfg: state.config?.youtube?.clientId });
  if (key !== ytKey) {
    ytKey = key;
    $('#yt-body').replaceChildren(...ytView(y).filter(Boolean));
  }
  const ago = $('#yt-checked');
  if (ago) ago.textContent = y.checkedAt ? `Checked ${span((Date.now() - y.checkedAt) / 1000)} ago` : 'Not checked yet';
}

function ytView(y) {
  const err = y.lastError ? h('p', { class: 'bad small' }, y.lastError) : null;
  if (!y.configured) {
    return [
      h('p', { class: 'muted small' }, 'Optional. Connect your channel and the panel sets up the broadcast itself (Auto-start on, Auto-stop off), shows YouTube\'s own stream health here and in Discord, and starts a new broadcast if YouTube ever ends one.'),
      h('label', { class: 'field' }, h('span', {}, 'Client ID'),
        h('input', { name: 'youtube.clientId', autocomplete: 'off', placeholder: '….apps.googleusercontent.com', value: state.config?.youtube?.clientId ?? '' })),
      h('label', { class: 'field' }, h('span', {}, 'Client secret'),
        h('input', { name: 'youtube.clientSecret', type: 'password', autocomplete: 'off', placeholder: 'GOCSPX-…' })),
      h('div', { class: 'field' },
        h('span', {}, 'Make your own Google client (free, about 10 minutes)'),
        h('div', { class: 'btn-row' },
          extLink('1. Turn on the YouTube API', 'https://console.cloud.google.com/apis/library/youtube.googleapis.com'),
          extLink('2. Set up Google Auth', 'https://console.cloud.google.com/auth/overview'),
          extLink('3. Publish the app', 'https://console.cloud.google.com/auth/audience'),
          extLink('4. Create the client', 'https://console.cloud.google.com/auth/clients/create')),
        h('small', { class: 'muted' }, 'Sign in with the channel\'s Google account and create or pick a project at the top of each page. Client type: TVs and Limited Input devices. Every click is in ',
          h('a', { href: `${GUIDE_URL}#2-connect-youtube-optional`, target: '_blank', rel: 'noopener' }, 'the guide'), '.')),
      err,
      h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')),
    ];
  }
  if (y.pending) {
    const p = y.pending;
    return [
      h('div', { class: 'yt-code' },
        h('span', { class: 'muted small' }, 'On any phone or computer, open'),
        h('a', { href: p.verificationUrl, target: '_blank', rel: 'noopener' }, p.verificationUrl.replace(/^https?:\/\/(www\.)?/, '')),
        h('span', { class: 'muted small' }, 'and enter this code:'),
        h('div', { class: 'url-row' }, h('code', { class: 'code mono' }, p.userCode),
          h('button', { type: 'button', class: 'icon-btn small', title: 'Copy code', 'aria-label': 'Copy code', onclick: () => act(() => navigator.clipboard.writeText(p.userCode), 'Code copied') }, icon('copy')))),
      h('small', { class: 'muted' }, 'Sign in with the Google account that owns the channel. Google warns that the app isn\'t verified: it is your own app, so choose Advanced, then Go to Stream Panel, then Continue.'),
      h('small', { class: 'muted' }, `Waiting for approval… the code works for ${span((p.expiresAt - Date.now()) / 1000)}.`),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => act(async () => {
        await api('POST', '/api/youtube/connect/cancel');
        await loadStatus();
      }) }, 'Cancel')),
    ];
  }
  if (!y.connected) {
    return [
      h('p', { class: 'muted small' }, 'Ready to connect. You\'ll get a short code to enter at google.com/device, signed in to the channel\'s Google account.'),
      err,
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: removeYtClient }, 'Use a different client'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => act(async () => {
          await api('POST', '/api/youtube/connect');
          await loadStatus();
        }) }, icon('yt'), 'Connect YouTube')),
    ];
  }
  const [hl, ht] = YT_HEALTH[y.stream?.health] ?? ['Not checked yet', 'muted'];
  const b = y.broadcast;
  const body = [
    h('div', { class: 'split' },
      h('dl', { class: 'stats one-col' }, h('div', {}, h('dt', {}, 'Channel'), h('dd', {}, y.channel?.title ?? 'Connected'))),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: disconnectYt }, icon('logout'), 'Disconnect')),
    h('dl', { class: 'stats one-col' }, h('div', {}, h('dt', {}, 'YouTube health'), h('dd', { class: ht }, hl))),
  ];
  if (y.stream?.issues?.length) {
    body.push(h('ul', { class: 'issues small' }, ...y.stream.issues.map((i) => h('li', { class: i.severity === 'error' ? 'bad' : 'warn' },
      h('b', {}, i.reason ?? i.type), i.description ? ` ${i.description}` : ''))));
  }
  if (b) {
    body.push(h('dl', { class: 'stats one-col' }, h('div', {}, h('dt', {}, 'Broadcast'), h('dd', {}, b.title,
      h('div', { class: 'muted small' }, `${b.privacy} · ${YT_LIFE[b.lifeCycle] ?? b.lifeCycle}`)))));
    body.push(h('div', { class: 'btn-row' },
      h('a', { class: 'btn btn-small', href: b.watchUrl, target: '_blank', rel: 'noopener' }, icon('play'), 'Watch on YouTube', icon('external', 'i i-sm')),
      h('a', { class: 'btn btn-small', href: b.studioUrl, target: '_blank', rel: 'noopener' }, 'Open in Studio', icon('external', 'i i-sm'))));
    if (['ready', 'created'].includes(b.lifeCycle) && y.stream?.status === 'active') {
      body.push(h('div', { class: 'note small' }, icon('alert'), h('div', {},
        h('p', {}, 'Your stream is already reaching YouTube, so this broadcast won\'t start by itself (YouTube only auto-starts when a stream begins). Starting it pauses the stream for about 10 seconds; nobody is watching yet.'),
        h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => act(async () => {
          await api('POST', '/api/youtube/go-live');
          await loadStatus();
        }, 'Starting the broadcast, it takes a few seconds') }, 'Start broadcast now'))));
    }
    if (b.autoStop) {
      body.push(h('div', { class: 'note small' }, icon('alert'), h('div', {},
        h('p', {}, 'Auto-stop is on: YouTube ends this broadcast after about a minute without data, so any outage ends it for good.'),
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => act(async () => {
          await api('POST', '/api/youtube/fix-autostop');
          await loadStatus();
        }, 'Auto-stop turned off') }, 'Turn it off'))));
    }
  } else {
    const keyKnown = Boolean(y.stream);
    body.push(h('div', { class: 'note small' }, icon('alert'), h('span', {}, keyKnown
      ? 'No broadcast uses this stream key, so YouTube shows nothing. Create one:'
      : 'YouTube doesn\'t know the stream key saved here. Creating a broadcast also makes a new key and saves it.')));
    body.push(h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', {}, 'Title'), h('input', { id: 'yt-title', value: 'Live 24/7', maxlength: '100' })),
      h('label', { class: 'field' }, h('span', {}, 'Visibility'), h('select', { id: 'yt-privacy' },
        h('option', { value: 'unlisted' }, 'Unlisted'), h('option', { value: 'public' }, 'Public'), h('option', { value: 'private' }, 'Private')))));
    body.push(h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: createBroadcast }, icon('yt'), 'Create broadcast')));
  }
  body.push(h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: y.autoRecreate, onchange: (e) => saveConfig({ youtube: { autoRecreate: e.target.checked } }) }),
    h('span', {}, 'If YouTube ends the broadcast, start a new one automatically')));
  body.push(h('div', { class: 'split small muted' }, h('span', { id: 'yt-checked' }), h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => act(async () => {
    await api('POST', '/api/youtube/check');
    await loadStatus();
  }) }, icon('restart'), 'Check now')));
  if (err) body.push(err);
  return body;
}

async function createBroadcast() {
  const title = $('#yt-title').value.trim();
  const privacy = $('#yt-privacy').value;
  const r = await act(() => api('POST', '/api/youtube/setup', { title, privacy }));
  if (!r) return;
  toast(r.created.keyChanged ? 'Broadcast created with a new stream key — reconnecting' : 'Broadcast created');
  await Promise.all([loadStatus(), loadConfig()]);
}

async function disconnectYt() {
  if (!(await confirmDialog('Disconnect YouTube?', 'The panel stops checking YouTube. Streaming is not affected.', 'Disconnect'))) return;
  await act(async () => {
    await api('POST', '/api/youtube/disconnect');
    await loadStatus();
  }, 'Disconnected');
}

async function removeYtClient() {
  if (!(await confirmDialog('Use a different client?', 'The saved Client ID and secret are removed from the panel.', 'Remove'))) return;
  await saveConfig({ youtube: { clientId: '', clientSecret: '' } }, 'Removed');
}

// more platforms

const RS_STATE = {
  live: ['Live', 'ok'], connecting: ['Connecting', 'muted'], retrying: ['Retrying', 'warn'],
  waiting: ['Waiting for the stream', 'muted'], off: ['Off', 'muted'],
};
const RS_URL = {
  twitch: 'rtmp://live.twitch.tv/app',
  kick: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app',
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
  custom: '',
};
const RS_HELP = {
  twitch: 'Twitch: Creator Dashboard > Settings > Stream > Primary Stream key > Copy.',
  kick: 'Kick: Dashboard > Stream URL & Key (Kick emails a security code first). Copy only the Stream Key and keep the server URL above: Kick shows it without "/app", this form is the tested one.',
  facebook: 'Facebook: Live Producer > Streaming software > use a persistent stream key.',
  custom: 'Any RTMP or RTMPS server: paste its server URL and stream key.',
};

function rsOverview(list) {
  const on = list.filter((d) => d.enabled);
  if (!on.length) return ['—', 'muted'];
  const text = on.map((d) => `${d.name} ${(RS_STATE[d.state]?.[0] ?? d.state).toLowerCase()}`).join(' · ');
  return [text, on.every((d) => d.state === 'live') ? 'ok' : on.some((d) => d.state === 'retrying') ? 'warn' : 'muted'];
}

let rsKey = '';
function renderRestream(list) {
  const key = JSON.stringify(list);
  if (key === rsKey) return;
  rsKey = key;
  $('#rs-list').replaceChildren(...(list.length ? list.map(rsRow) : [h('p', { class: 'muted small' }, 'No other platforms yet.')]));
}

function rsRow(d) {
  const [label, tone] = RS_STATE[d.state] ?? [d.state, 'muted'];
  return h('div', { class: 'rs-row' },
    h('div', { class: 'rs-main' },
      h('div', {}, h('b', {}, d.name), ' ', h('span', { class: `small ${tone}` }, label)),
      d.lastError && d.state !== 'live' ? h('div', { class: 'small bad wrap' }, d.lastError) : null),
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: d.enabled, onchange: (e) => act(async () => {
        await api('PATCH', `/api/restream/${d.id}`, { enabled: e.target.checked });
        rsKey = '';
        await loadStatus();
      }, e.target.checked ? `${d.name} on: it joins at the next keyframe` : `${d.name} off`) }),
      h('span', {}, 'On')),
    h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => removeRs(d) }, icon('trash'), 'Remove'));
}

async function removeRs(d) {
  if (!(await confirmDialog(`Remove ${d.name}?`, 'The panel stops streaming there and deletes its stream key.', 'Remove'))) return;
  await act(async () => {
    await api('DELETE', `/api/restream/${d.id}`);
    rsKey = '';
    await loadStatus();
  }, `${d.name} removed`);
}

const RS_KEY_PAGE = {
  twitch: ['Get your Twitch key', 'https://dashboard.twitch.tv/settings/stream'],
  kick: ['Get your Kick key', 'https://dashboard.kick.com/channel/stream'],
  facebook: ['Open Facebook Live Producer', 'https://www.facebook.com/live/producer'],
};

function rsPlatformChanged() {
  const p = $('#rs-platform').value;
  $('#rs-url').value = RS_URL[p];
  $('#rs-help').textContent = RS_HELP[p];
  const link = $('#rs-key-link');
  const page = RS_KEY_PAGE[p];
  link.parentElement.hidden = !page; // no empty row for "Other"
  if (page) {
    link.href = page[1];
    link.replaceChildren(page[0], icon('external', 'i i-sm'));
  }
}
$('#rs-platform').addEventListener('change', rsPlatformChanged);
rsPlatformChanged();

$('#rs-add').addEventListener('click', () => act(async () => {
  const platform = $('#rs-platform').value;
  await api('POST', '/api/restream', { platform, url: $('#rs-url').value.trim(), key: $('#rs-key').value.trim() });
  $('#rs-key').value = '';
  rsKey = '';
  await loadStatus();
}, 'Platform added: it joins at the next keyframe'));

// OBS

async function loadObs() {
  state.obs = await api('GET', '/api/obs');
  renderObs();
}

function renderObs() {
  const o = state.obs;
  if (!o) return;
  $('#obs-url').textContent = o.url ?? 'Set the server address under Advanced (it could not be detected)';
  $('#copy-obs').hidden = !o.url;
  const [text] = obsStatus(o);
  $('#obs-state').textContent = text;
  $('#obs-state').classList.toggle('set', o.state === 'live' || o.state === 'listening');
  const r = o.required;
  $('#obs-required').replaceChildren(...[
    `Video > Output (Scaled) Resolution: ${r.resolution}`,
    `Video > Common FPS Values: ${r.fps}`,
    `Output > Encoder: ${r.encoder}`,
    `Output > Rate Control: ${r.rateControl}, Bitrate: ${r.bitrateKbps} Kbps`,
    `Output > Keyframe Interval: ${r.keyframeSeconds} s`,
  ].map((t) => h('li', {}, icon('check'), h('span', {}, t))));
}

$('#copy-obs').addEventListener('click', async () => {
  if (state.obs?.url) await act(() => navigator.clipboard.writeText(state.obs.url), 'Copied — paste it into OBS as the Server');
});

$('#btn-obs-pass').addEventListener('click', async () => {
  if (!(await confirmDialog('Make a new OBS password?', 'The old server address stops working. Anyone using OBS needs the new one.', 'Make new'))) return;
  await act(async () => {
    state.obs = await api('POST', '/api/obs/passphrase');
    renderObs();
  }, 'New password set — copy the new address into OBS');
});

$('#btn-test-alert').addEventListener('click', () => act(() => api('POST', '/api/config/test-notification'), 'Test alert sent — check Discord'));

// terminal
//
// A real shell on the server (xterm.js in the browser, a WebSocket to the
// panel, a login shell behind it). It has its own password: setting it the
// first time takes the panel password, opening a session takes the terminal
// password every time.

const term = { status: null, lib: null, ws: null, x: null, fit: null, watch: null };

async function loadTerminal() {
  term.status = await api('GET', '/api/terminal');
  renderTerminal();
}

function renderTerminal() {
  const s = term.status;
  if (!s) return;
  const screen = Boolean(term.x);
  $('#term-unavailable').hidden = s.available;
  $('#term-setup').hidden = screen || s.enabled;
  $('#term-unlock').hidden = screen || !s.enabled;
  $('#term-live').hidden = !screen;
  $('#term-note').textContent = `Sudo works, like SSH. A session closes after ${s.idleMinutes} min without typing, or when you close it here. Discord hears about every session.`;
}

// xterm.js is only fetched the first time a terminal opens.
async function terminalLib() {
  if (term.lib) return term.lib;
  if (!$('link[data-xterm]')) document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/xterm/xterm.css', 'data-xterm': true }));
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('/vendor/xterm/xterm.mjs'), import('/vendor/xterm/addon-fit.mjs')]);
  term.lib = { Terminal, FitAddon };
  return term.lib;
}

function setTermState(text, tone) {
  $('#term-state').textContent = text;
  $('#term-pill').dataset.tone = tone;
}

const termSend = (msg) => term.ws?.readyState === WebSocket.OPEN && term.ws.send(JSON.stringify(msg));

async function openTerminal(ticket) {
  const { Terminal, FitAddon } = await terminalLib();
  const x = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "Cascadia Code", Menlo, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#0a0c10', foreground: '#c9d1dc', cursor: '#e5484d', selectionBackground: '#3b4a6680' },
  });
  const fit = new FitAddon();
  x.loadAddon(fit);
  term.x = x;
  term.fit = fit;
  renderTerminal(); // the screen must be visible before it can be measured
  x.open($('#term-screen'));
  fit.fit();
  setTermState('Connecting…', 'info');
  $('#term-close span').textContent = 'Close';

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal/ws`);
  ws.binaryType = 'arraybuffer';
  term.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'ticket', v: ticket, c: x.cols, r: x.rows }));
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return x.write(new Uint8Array(ev.data));
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.t === 'ready') {
      setTermState('Connected', 'ok');
      x.focus();
    } else if (m.t === 'exit') setTermState('The shell has ended', 'idle');
    else if (m.t === 'idle') setTermState(`Closed after ${m.v} min without typing`, 'idle');
    else if (m.t === 'error') {
      x.write(`\r\n\x1b[31m${m.v}\x1b[0m\r\n`);
      setTermState(m.v, 'warn');
    }
  };
  ws.onclose = () => {
    if (term.ws !== ws) return;
    term.ws = null;
    if ($('#term-pill').dataset.tone === 'ok') setTermState('Disconnected', 'idle');
    $('#term-close span').textContent = 'Back';
    x.write('\r\n\x1b[90m[session closed]\x1b[0m\r\n');
  };
  // Copy and paste like Windows Terminal. Ctrl+Shift+C (the browser's own
  // "inspect" shortcut otherwise) or Ctrl+C with text selected copies; Ctrl+C
  // with nothing selected still stops the running command. Ctrl+V and
  // Ctrl+Shift+V paste: the browser does it and the terminal receives it.
  x.attachCustomKeyEventHandler((e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return true;
    const key = e.key.toLowerCase();
    if (key === 'c' && (e.shiftKey || x.hasSelection())) {
      if (e.type === 'keydown') {
        e.preventDefault();
        if (x.hasSelection()) copyText(x.getSelection());
      }
      return false;
    }
    if (key === 'v') return false; // not ^V: let the browser's paste happen
    return true;
  });
  x.onData((d) => termSend({ t: 'd', v: d }));
  x.onResize(({ cols, rows }) => termSend({ t: 'r', c: cols, r: rows }));
  term.watch = new ResizeObserver(() => {
    try {
      fit.fit();
    } catch {}
  });
  term.watch.observe($('#term-screen'));
}

function closeTerminal() {
  term.ws?.close();
  term.ws = null;
  term.watch?.disconnect();
  term.x?.dispose();
  term.x = null;
  $('#term-screen').replaceChildren();
  renderTerminal();
}

$('#term-close').addEventListener('click', closeTerminal);

// The clipboard API needs HTTPS or localhost (the panel always is); the old
// way is the fallback.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) return toast('The browser did not allow copying. Select the text and use the right-click menu.', 'bad');
  }
  toast('Copied');
}

// Copy button: the selection, or the whole visible screen if nothing is
// selected (selecting is fiddly on a phone).
function terminalScreenText() {
  const buf = term.x.buffer.active;
  const lines = [];
  for (let i = buf.viewportY; i < buf.viewportY + term.x.rows; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n').replace(/\s+$/, '');
}
$('#term-copy').addEventListener('click', () => {
  if (term.x) copyText(term.x.hasSelection() ? term.x.getSelection() : terminalScreenText());
});
$('#term-paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.x?.paste(text);
  } catch {
    toast('The browser did not allow reading the clipboard. Press Ctrl+V in the terminal instead.', 'bad');
  }
  term.x?.focus();
});

const KEYS = { esc: '\x1b', tab: '\t', 'ctrl-c': '\x03', 'ctrl-d': '\x04', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
for (const b of $$('[data-key]')) {
  b.addEventListener('click', () => {
    termSend({ t: 'd', v: KEYS[b.dataset.key] });
    term.x?.focus();
  });
}
// Quick commands: data-run runs it, data-type only types it (you press Enter).
for (const b of $$('[data-run], [data-type]')) {
  b.addEventListener('click', () => {
    termSend({ t: 'd', v: b.dataset.run ? `${b.dataset.run}\r` : b.dataset.type });
    term.x?.focus();
  });
}

$('#term-open-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#term-open-error');
  err.textContent = '';
  try {
    const { ticket } = await api('POST', '/api/terminal/ticket', { password: $('#term-pass').value });
    $('#term-pass').value = '';
    await openTerminal(ticket);
  } catch (e2) {
    err.textContent = e2.message;
  }
});

// The terminal password rules (the server checks the same ones), ticked off
// as you type.
const TERMINAL_RULES = [
  ['At least 14 characters', (p) => p.length >= 14],
  ['A lowercase letter', (p) => /[a-z]/.test(p)],
  ['An uppercase letter', (p) => /[A-Z]/.test(p)],
  ['A digit', (p) => /[0-9]/.test(p)],
  ['A symbol, like ! # % - _ ?', (p) => /[^A-Za-z0-9\s]/.test(p)],
];
for (const list of $$('[data-rules-for]')) {
  const input = $(`#${list.dataset.rulesFor}`);
  const show = () => list.replaceChildren(...TERMINAL_RULES.map(([label, ok]) => {
    const met = ok(input.value);
    return h('li', { class: met ? 'ok' : 'muted' }, icon(met ? 'check' : 'x'), h('span', {}, label));
  }));
  input.addEventListener('input', show);
  input.form.addEventListener('reset', () => setTimeout(show)); // after the fields clear
  show();
}

$('#term-set-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#term-set-error');
  err.textContent = '';
  if ($('#term-new').value !== $('#term-new2').value) {
    err.textContent = 'The two terminal passwords are not the same.';
    return;
  }
  try {
    term.status = await api('POST', '/api/terminal/password', { panelPassword: $('#term-panel-pass').value, next: $('#term-new').value });
    e.target.reset();
    renderTerminal();
    toast('Terminal is on. Open it with the terminal password.');
  } catch (e2) {
    err.textContent = e2.message;
  }
});

$('#term-change-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#term-change-error');
  err.textContent = '';
  if (!$('#term-chg').value) {
    err.textContent = 'Type the new terminal password.';
    return;
  }
  if ($('#term-chg').value !== $('#term-chg2').value) {
    err.textContent = 'The two new passwords are not the same.';
    return;
  }
  try {
    term.status = await api('POST', '/api/terminal/password', { current: $('#term-cur').value, next: $('#term-chg').value });
    e.target.reset();
    renderTerminal();
    toast('Terminal password changed');
  } catch (e2) {
    err.textContent = e2.message;
  }
});

$('#term-off').addEventListener('click', async () => {
  const err = $('#term-change-error');
  err.textContent = '';
  if (!$('#term-cur').value) {
    err.textContent = 'Type the current terminal password to turn it off.';
    return;
  }
  if (!(await confirmDialog('Turn the terminal off?', 'The Terminal tab stops working until a new terminal password is set (which takes the panel password).', 'Turn off'))) return;
  try {
    term.status = await api('POST', '/api/terminal/off', { current: $('#term-cur').value });
    $('#term-change-form').reset();
    renderTerminal();
    toast('Terminal turned off');
  } catch (e2) {
    err.textContent = e2.message;
  }
});

// logs

async function loadLogs() {
  const { seq, lines } = await api('GET', `/api/stream/logs?since=${state.logSeq}`);
  state.logSeq = seq;
  if (!lines.length) return;
  state.logLines.push(...lines);
  if (state.logLines.length > 1500) state.logLines.splice(0, state.logLines.length - 1500);
  renderLogs();
}

function renderLogs() {
  const pre = $('#log');
  const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
  const f = state.logFilter;
  const lines = state.logLines.filter((l) => !f || (f === 'ffmpeg' ? l.text.startsWith('ffmpeg:') : l.source === f && !l.text.startsWith('ffmpeg:')));
  pre.replaceChildren(...lines.map((l) => h('div', {},
    h('span', { class: 't' }, new Date(l.t).toLocaleTimeString()), ' ',
    h('span', { class: 's' }, l.source.padEnd(10)), ' ',
    h('span', { class: /fail|error|stall|refused/i.test(l.text) ? 'e' : '' }, l.text))));
  if (nearBottom) pre.scrollTop = pre.scrollHeight;
}

for (const b of $$('#log-filter button')) {
  b.addEventListener('click', () => {
    state.logFilter = b.dataset.source;
    for (const x of $$('#log-filter button')) x.setAttribute('aria-selected', String(x === b));
    renderLogs();
  });
}
$('#log-pause').addEventListener('click', () => {
  state.logPaused = !state.logPaused;
  $('#log-pause span').textContent = state.logPaused ? 'Resume' : 'Pause';
  $('#log-pause use').setAttribute('href', state.logPaused ? '#i-play' : '#i-pause');
});

// boot

(async () => {
  const hash = location.hash.slice(1);
  try {
    const s = await api('GET', '/api/auth/session');
    if (!s.authenticated) return showLogin(s.passwordSet, s.setupCodeRequired);
    await showApp();
    if (['overview', 'library', 'settings', 'logs', 'terminal'].includes(hash)) selectTab(hash);
  } catch {
    showLogin();
  }
})();
