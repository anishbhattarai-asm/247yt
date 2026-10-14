import { Router } from 'express';
import { obsUrl } from '../core/ingest.js';
import { publicIp } from '../core/publicip.js';

export function obsRoutes(ctx) {
  const r = Router();

  // Everything OBS needs. The passphrase is shown here (signed-in only), as
  // the panel is where the owner copies it from.
  const view = async () => {
    const cfg = ctx.getConfig();
    const { obs, profile: p } = cfg;
    const host = obs.publicHost || (await publicIp());
    return {
      ...ctx.ingest.status(),
      host,
      hostDetected: !obs.publicHost,
      publicHost: obs.publicHost,
      url: host ? obsUrl({ host, port: obs.port, passphrase: obs.passphrase }) : null,
      // What OBS must send (video is copied, so it has to match the stream).
      required: {
        resolution: `${p.width}x${p.height}`,
        fps: p.fps,
        encoder: 'x264 or any H.264 encoder',
        rateControl: 'CBR',
        bitrateKbps: Number(String(p.videoBitrate).replace(/k$/, '')),
        keyframeSeconds: 2,
      },
    };
  };

  r.get('/', async (req, res) => res.json(await view()));

  // Lock out anyone who has the old URL (OBS must be given the new one).
  r.post('/passphrase', async (req, res) => {
    await ctx.settings.newObsPassphrase();
    ctx.ingest.apply();
    ctx.logs.push('config', 'new OBS passphrase');
    res.json(await view());
  });

  return r;
}
