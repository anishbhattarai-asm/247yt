import { Router } from 'express';

export function streamRoutes(ctx) {
  const r = Router();
  const { supervisor, playlist } = ctx;

  r.get('/status', async (req, res) => {
    const s = supervisor.status();
    const cfg = ctx.getConfig();
    res.json({
      ...s,
      mode: cfg.mode,
      order: cfg.playlist.order,
      // During OBS, "next" is the file OBS interrupted.
      next: s.onAir?.live ? (ctx.library.get(ctx.pipeline.afterLive?.id)?.title ?? playlist.peek(null))
        : s.onAir ? playlist.peek(s.onAir.id) : null,
      playable: playlist.problem() ?? null,
      streamKeySet: Boolean(cfg.youtube.streamKey),
      needsStreamKey: !cfg.youtube.streamKey && !process.env.STREAM_DEST,
      panelUrl: ctx.tunnel.status().url, // only the live one — old URLs stop working
      tunnel: ctx.tunnel.status(),
      health: ctx.health.status(),
      normalizer: ctx.normalizer.status(),
      system: await ctx.stats.snapshot(),
      discord: { configured: Boolean(cfg.notifications.discordWebhookUrl), ...ctx.notifier.stats },
      obs: ctx.ingest.status(),
      youtube: ctx.youtube.status(),
      restream: ctx.restream.status(),
    });
  });

  r.post('/start', async (req, res) => {
    if (!ctx.getConfig().youtube.streamKey && !process.env.STREAM_DEST) {
      return res.status(409).json({ error: 'Set your YouTube stream key first' });
    }
    res.json(await supervisor.start());
  });

  r.post('/stop', async (req, res) => {
    res.json(await supervisor.stop('stopped from the panel'));
  });

  r.post('/skip', (req, res) => {
    if (ctx.pipeline.status().feeding?.id === 'obs') {
      return res.status(409).json({ error: 'OBS is live. The playlist comes back when OBS stops streaming.' });
    }
    if (!supervisor.skip()) return res.status(409).json({ error: 'Nothing is playing' });
    res.json({ ok: true });
  });

  // Clean pusher restart now (normally automatic, weekly at a quiet hour).
  r.post('/restart', (req, res) => {
    if (!supervisor.restartNow()) return res.status(409).json({ error: 'Not streaming' });
    res.json({ ok: true });
  });

  r.get('/logs', (req, res) => {
    res.json(ctx.logs.since(Number(req.query.since) || 0));
  });

  return r;
}
