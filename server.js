// Entry point. systemd keeps this process alive; it keeps everything else alive.
//
// Boot: load config -> start the panel -> start cloudflared (URL to Discord)
//       -> resume streaming if it was on -> heartbeat pings.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, listen } from './src/app.js';
import { createContext } from './src/context.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const mediaDir = path.resolve(ROOT, process.env.MEDIA_DIR || 'media');

const ctx = await createContext({ dataDir, mediaDir });
const { host, port } = ctx.getConfig().server;
const log = ctx.logs.for('server');

const server = listen(createApp(ctx), port, host, async () => {
  log(`panel on http://${host}:${port}`);
  if (!ctx.getConfig().auth.passwordHash) log('no password set yet — run: npm run set-password');
  await ctx.start();
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down (streaming resumes on next start if it was on)`);
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  server.close();
  await ctx.shutdown().catch((err) => log(`shutdown error: ${err.message}`));
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
