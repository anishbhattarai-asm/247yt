import { Router } from 'express';
import { obsUrl } from '../core/ingest.js';

// This server's public IP, for the address OBS connects to. Behind Oracle's
// NAT the machine only knows its private IP, so ask Cloudflare (already in
// use for the tunnel). Cached; null if it can't be found.
let detected = { ip: null, at: 0 };
async function publicIp() {
  if (Date.now() - detected.at < 600_000) return detected.ip;
  try {
    const res = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) });
    const ip = /^ip=(.+)$/m.exec(await res.text())?.[1]?.trim() ?? null;
    detected = { ip, at: Date.now() };
  } catch {
    detected = { ip: null, at: Date.now() - 540_000 }; // retry in a minute
  }
  return detected.ip;
}

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
