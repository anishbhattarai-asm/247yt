import { Router } from 'express';

export function configRoutes(ctx) {
  const r = Router();

  const view = () => ({ ...ctx.settings.public(), profileLocked: !ctx.library.isEmpty() });

  r.get('/', (req, res) => res.json(view()));

  // Partial update. Secrets are write-only: send a new value or '' to clear.
  r.put('/', async (req, res) => {
    const before = ctx.getConfig();
    await ctx.settings.patch(req.body, { profileLocked: !ctx.library.isEmpty() });
    const after = ctx.getConfig();
    if (after.lofi.backgroundId) {
      const bg = ctx.library.get(after.lofi.backgroundId);
      if (!bg || bg.kind !== 'background') {
        await ctx.settings.patch({ lofi: { backgroundId: before.lofi.backgroundId } });
        throw Object.assign(new Error('That item is not a background'), { status: 400 });
      }
    }
    if (before.tunnel.enabled !== after.tunnel.enabled) {
      if (after.tunnel.enabled) ctx.tunnel.open();
      else ctx.tunnel.close();
    }
    ctx.supervisor.poke(); // mode / background / key may have made the stream startable
    ctx.ingest.apply(); // OBS input on/off or new port
    await ctx.youtube.apply(); // a new OAuth client drops the old sign-in
    ctx.logs.push('config', `updated: ${Object.keys(req.body ?? {}).join(', ')}`);
    res.json(view());
  });

  r.post('/test-notification', async (req, res) => {
    if (!ctx.getConfig().notifications.discordWebhookUrl) {
      return res.status(409).json({ error: 'Set a Discord webhook URL first' });
    }
    const before = { ...ctx.notifier.stats };
    ctx.notifier.test();
    await ctx.notifier.flush();
    const ok = ctx.notifier.stats.sent > before.sent;
    res.status(ok ? 200 : 502).json({ ok, error: ok ? null : ctx.notifier.stats.lastError });
  });

  return r;
}
