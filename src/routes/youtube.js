import { Router } from 'express';

// Optional YouTube account link (core/youtube.js).
export function youtubeRoutes(ctx) {
  const r = Router();
  const { youtube } = ctx;

  r.get('/', (req, res) => res.json(youtube.status()));

  // Starts Google's device sign-in: show the code, the owner enters it at
  // google.com/device. The panel polls Google until approved.
  r.post('/connect', async (req, res) => res.json(await youtube.startConnect()));
  r.post('/connect/cancel', (req, res) => res.json(youtube.cancelConnect()));
  r.post('/disconnect', async (req, res) => res.json(await youtube.disconnect()));

  r.post('/check', async (req, res) => res.json(await youtube.check()));

  // One-click broadcast. A new stream key reaches YouTube through a clean
  // reconnect (viewers don't notice).
  r.post('/setup', async (req, res) => {
    const { title, privacy, description } = req.body ?? {};
    const out = await youtube.setup({ title, privacy, description });
    if (out.keyChanged && ctx.supervisor.desired) {
      if (!ctx.supervisor.restartNow()) ctx.supervisor.poke();
    }
    ctx.logs.push('youtube', `broadcast created: ${out.broadcast.title}`);
    res.json({ ...youtube.status(), created: out });
  });

  r.post('/fix-autostop', async (req, res) => res.json(await youtube.fixAutoStop()));

  // Start the bound broadcast now (Auto-start never fires for a stream that
  // was already running when the broadcast was made).
  r.post('/go-live', async (req, res) => {
    await youtube.goLive();
    res.json(youtube.status());
  });

  return r;
}
