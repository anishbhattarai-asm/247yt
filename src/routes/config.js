import { Router } from 'express';

export function configRoutes(ctx) {
  const r = Router();

  const view = () => ({
    ...ctx.settings.public(),
    profileLocked: !ctx.library.isEmpty(),
    serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

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
    ctx.finder.apply(); // stable link port
    await ctx.youtube.apply(); // a new OAuth client drops the old sign-in
    ctx.logs.push('config', `updated: ${Object.keys(req.body ?? {}).join(', ')}`);
    res.json(view());
  });

  // Tests every alert channel that is set up (Discord, phone) and says which
  // worked.
  r.post('/test-notification', async (req, res) => {
    const n = ctx.getConfig().notifications;
    const channels = { discord: Boolean(n.discordWebhookUrl), ntfy: Boolean(n.ntfy.enabled && n.ntfy.topic) };
    if (!channels.discord && !channels.ntfy) {
      return res.status(409).json({ error: 'Set up Discord or phone notifications first' });
    }
    const before = { discord: ctx.notifier.stats.sent, ntfy: ctx.notifier.ntfyStats.sent };
    ctx.notifier.test();
    await ctx.notifier.flush();
    const result = (name, stats) => (channels[name]
      ? { ok: stats.sent > before[name], error: stats.sent > before[name] ? null : stats.lastError }
      : null);
    const discord = result('discord', ctx.notifier.stats);
    const ntfy = result('ntfy', ctx.notifier.ntfyStats);
    const ok = [discord, ntfy].every((c) => !c || c.ok);
    const failed = [discord && !discord.ok && `Discord: ${discord.error}`, ntfy && !ntfy.ok && `Phone: ${ntfy.error}`].filter(Boolean);
    res.status(ok ? 200 : 502).json({ ok, discord, ntfy, error: failed.join(' | ') || null });
  });

  // Phone notifications (ntfy). The topic is shown here (signed-in only),
  // since the owner subscribes to it in the app.
  const ntfyView = () => {
    const n = ctx.getConfig().notifications.ntfy;
    return {
      enabled: n.enabled,
      server: n.server,
      topic: n.topic,
      url: n.topic ? `${n.server}/${n.topic}` : null,
      sent: ctx.notifier.ntfyStats.sent,
      lastError: ctx.notifier.ntfyStats.lastError,
    };
  };

  r.get('/ntfy', (req, res) => res.json(ntfyView()));

  r.post('/ntfy', async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    if (enabled && !ctx.getConfig().notifications.ntfy.topic) await ctx.settings.newNtfyTopic();
    await ctx.settings.patch({ notifications: { ntfy: { enabled } } });
    ctx.logs.push('config', `phone notifications ${enabled ? 'on' : 'off'}`);
    res.json(ntfyView());
  });

  // If the topic leaked: a new one (phones must subscribe to it again).
  r.post('/ntfy/new-topic', async (req, res) => {
    await ctx.settings.newNtfyTopic();
    ctx.logs.push('config', 'new phone notification topic');
    res.json(ntfyView());
  });

  return r;
}
