// This server's public IP, for addresses shown to the owner (OBS server,
// stable link). Behind Oracle's NAT the machine only knows its private IP,
// so ask Cloudflare (already in use for the tunnel). Cached; null if it
// can't be found.

let detected = { ip: null, at: 0 };

export async function publicIp() {
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

// The last answer without waiting (null until the first lookup finishes).
export function cachedPublicIp() {
  if (Date.now() - detected.at >= 600_000) publicIp().catch(() => {});
  return detected.ip;
}
