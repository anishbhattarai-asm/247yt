// Builds and wires every component. Used by server.js and by the tests.

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Health } from './core/health.js';
import { Importer } from './core/importer.js';
import { Ingest } from './core/ingest.js';
import { Library } from './core/library.js';
import { LogBuffer, makeRedactor } from './core/logbuffer.js';
import { Normalizer } from './core/normalizer.js';
import { Notifier } from './core/notifier.js';
import { Pipeline } from './core/pipeline.js';
import { Restream } from './core/restream.js';
import { Playlist } from './core/playlist.js';
import { Settings } from './core/settings.js';
import { Stats } from './core/stats.js';
import { JsonStore } from './core/store.js';
import { Supervisor } from './core/supervisor.js';
import { Tunnel } from './core/tunnel.js';
import { YouTube } from './core/youtube.js';

// dest(session) overrides the YouTube destination (tests write .flv files).
// STREAM_DEST=<file with %d> or <rtmp url> does the same from the environment.
export async function createContext({ dataDir, mediaDir, dest = null, stallTimeout = 30, echoLogs = true, obsBind = '0.0.0.0', youtubeOptions = {} } = {}) {
  await mkdir(dataDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });

  const settings = await new Settings(dataDir).load();
  const getConfig = () => settings.get();
  const redact = makeRedactor(() => {
    const c = getConfig();
    return [c.youtube.streamKey, c.youtube.clientSecret, c.youtube.refreshToken, c.notifications.discordWebhookUrl,
      c.healthcheck.url, c.auth.sessionSecret, c.obs.passphrase, ...c.restream.destinations.map((d) => d.key)];
  });
  const logs = new LogBuffer({ redact, echo: echoLogs });

  const state = new JsonStore(path.join(dataDir, 'state.json'), {
    desired: false, resume: null, panelUrl: null, lastAnnouncedUrl: null, egress: null,
  });
  await state.load();

  const library = new Library({ dataDir, mediaDir });
  const requeue = await library.load();

  const normalizer = new Normalizer({
    getProfile: () => getConfig().profile,
    minFreeDiskBytes: getConfig().limits.minFreeDiskBytes,
  });
  const playlist = new Playlist(library, getConfig);
  const envDest = process.env.STREAM_DEST;
  const destFor = dest ?? (envDest
    ? (session) => ({ url: envDest.includes('%d') ? envDest.replace('%d', session) : envDest, format: 'flv' })
    : () => {
      const c = getConfig();
      return { url: `${c.youtube.rtmpUrl.replace(/\/$/, '')}/${c.youtube.streamKey}`, format: 'flv' };
    });
  const destLabel = dest || envDest ? 'test output' : 'YouTube';

  const restream = new Restream({ getConfig, log: logs.for('multistream') });
  const pipeline = new Pipeline({
    playlist,
    getDest: destFor,
    tap: (buf) => restream.feed(buf),
    log: logs.for('stream'),
    onQuarantine: (id, error) => library.setQuarantined(id, true, error),
  });
  const supervisor = new Supervisor({
    pipeline,
    state,
    getConfig,
    stallTimeout,
    log: logs.for('supervisor'),
    preflight: () => (dest || envDest || getConfig().youtube.streamKey ? null : 'Set your YouTube stream key first.'),
  });
  const notifier = new Notifier({ getConfig, redact, log: logs.for('discord') });
  const stats = new Stats({ mediaDir });
  const health = new Health({ getConfig, supervisor, stats, notifier, state, log: logs.for('health') });
  const tunnel = new Tunnel({ getConfig, port: getConfig().server.port, state, log: logs.for('tunnel') });
  const importer = new Importer({ library, normalizer, getConfig, log: logs.for('import') });
  const ingest = new Ingest({ getConfig, bind: obsBind, log: logs.for('obs') });
  const youtube = new YouTube({
    getConfig, settings, log: logs.for('youtube'), ...youtubeOptions,
    isStreaming: () => supervisor.desired && supervisor.phase === 'live',
    pauseStream: (reason) => supervisor.hold(reason),
    resumeStream: () => supervisor.release(),
  });

  // normalizer -> library
  const normLog = logs.for('normalize');
  normalizer.on('progress', async ({ id, mode }) => {
    if (library.get(id)?.status === 'queued') {
      await library.update(id, { status: 'normalizing' });
      normLog(`${library.get(id)?.title}: ${mode === 'remux' ? 'already in profile, remuxing' : 'encoding'}`);
    }
  });
  normalizer.on('done', async ({ id, kind, file, duration, bytes, mode, seconds }) => {
    if (!library.get(id)) return rm(file, { force: true }); // deleted meanwhile
    await library.update(id, { status: 'ready', kind, file, duration, bytes, incoming: null, progress: null, eta: null, error: null });
    normLog(`${library.get(id).title}: ready (${mode}, ${seconds.toFixed(0)} s)`);
    supervisor.poke();
  });
  normalizer.on('failed', async ({ id, error }) => {
    const item = library.get(id);
    if (!item) return;
    if (item.incoming) await rm(library.abs(item.incoming), { force: true });
    await library.update(id, { status: 'failed', error, incoming: null, progress: null, eta: null });
    normLog(`${item.title}: failed — ${error}`);
  });
  for (const id of requeue) {
    const item = library.get(id);
    normalizer.enqueue({ id, kind: item.kind, input: library.abs(item.incoming), outputDir: library.outputDir });
  }

  // supervisor / tunnel -> Discord
  supervisor.on('started', () => notifier.started({ dest: destLabel }));
  supervisor.on('stopped', (e) => notifier.stopped(e));
  supervisor.on('dropped', (e) => notifier.dropped(e));
  supervisor.on('cantConnect', (e) => notifier.cantConnect(e));
  supervisor.on('online', (e) => notifier.online(e));
  supervisor.on('frozen', (e) => notifier.frozen(e));
  supervisor.on('failing', (e) => notifier.failing(e));
  supervisor.on('skipped', (e) => notifier.skipped(e));
  tunnel.on('url', (e) => notifier.panelUrl(e));

  // OBS takeover (ingest.js): OBS -> panel -> YouTube, one connection
  ingest.on('connected', ({ info }) => {
    if (!supervisor.desired) {
      return ingest.reject('The 24/7 stream is stopped in the panel. Press Start in the panel first, then go live in OBS.');
    }
    pipeline.takeover(ingest.segment());
    supervisor.poke(); // nothing in the playlist? OBS can still go out
    notifier.obsLive({ info });
  });
  ingest.on('ended', (e) => {
    pipeline.endLive(); // before the live feed ends, so OBS isn't replayed
    notifier.obsEnded(e);
  });
  ingest.on('rejected', (e) => notifier.obsRejected(e));
  // Stopped from the panel while OBS was on air: tell OBS, don't let it
  // think it's live.
  // YouTube account (optional, youtube.js) -> Discord
  youtube.on('health', (e) => notifier.ytHealth(e));
  youtube.on('broadcastEnded', (e) => notifier.ytBroadcastEnded(e));
  youtube.on('authLost', (e) => notifier.ytAuthLost(e));

  // multistream (restream.js): follows the main stream
  restream.on('down', (e) => notifier.restreamDown(e));
  restream.on('up', (e) => notifier.restreamUp(e));
  pipeline.on('session-end', ({ intent }) => {
    if (intent === 'planned') restream.restartAll(); // fresh timestamps with the weekly reconnect
  });

  supervisor.on('stopped', () => {
    restream.stopAll();
    pipeline.endLive();
    if (['connected', 'live'].includes(ingest.state)) ingest.reject('The stream was stopped in the panel.');
  });
  const supLog = logs.for('supervisor');
  supervisor.on('waiting', ({ problem }) => supLog(`waiting: ${problem}`));

  return {
    settings, getConfig, redact, logs, state, library, normalizer, playlist, pipeline,
    supervisor, notifier, stats, health, tunnel, importer, ingest, youtube, restream,
    async start() {
      await supervisor.boot();
      health.start();
      tunnel.start();
      ingest.start();
      youtube.start();
    },
    // Service stop: flush the stream but keep `desired` for the next boot.
    async shutdown() {
      tunnel.close();
      ingest.close();
      youtube.close();
      restream.close();
      health.close();
      await supervisor.shutdown();
      // Alerts may be retrying through a network outage; don't hold shutdown.
      await Promise.race([notifier.flush(), new Promise((r) => setTimeout(r, 5000))]);
    },
  };
}
