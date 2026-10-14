// Security middleware.
//
// CSRF: every state-changing /api request must carry `X-Requested-With:
// stream-panel`. A cross-site page can't add a custom header without a CORS
// preflight, and the panel never answers preflights — so forged requests from
// other sites fail even though the session lives in a cookie (which is also
// SameSite=Strict).

export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
}

export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'stream-panel') {
    return res.status(403).json({ error: 'Missing X-Requested-With header' });
  }
  next();
}

// The real client IP. Behind cloudflared every request comes from 127.0.0.1,
// so trust Cloudflare's header — but only when the request really came from
// the local tunnel, never from a direct connection.
export function clientIp(req) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  return (local && req.get('cf-connecting-ip')) || req.socket.remoteAddress || 'unknown';
}

// Secure cookie when the browser reached us over HTTPS (the tunnel).
export function isHttps(req) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  return req.secure || (local && req.get('x-forwarded-proto') === 'https');
}
