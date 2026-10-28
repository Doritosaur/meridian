// Minimal in-memory fixed-window rate limiter (single-process; resets on restart).
// Deliberately not Redis-backed so bot traffic never costs Upstash commands.

export function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  // Returns { allowed, retryAfterSec }
  return function check(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    return {
      allowed: entry.count <= max,
      retryAfterSec: Math.ceil((entry.resetAt - now) / 1000)
    };
  };
}

export function expressRateLimit(options) {
  const check = createLimiter(options);
  return (req, res, next) => {
    const { allowed, retryAfterSec } = check(req.ip);
    if (!allowed) {
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ success: false, error: 'Too many requests' });
    }
    next();
  };
}

// Socket.IO client address, honouring X-Forwarded-For only when TRUST_PROXY is set.
export function socketIp(socket, trustProxy) {
  if (trustProxy) {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
  }
  return socket.handshake.address;
}
