const DEFAULT_WINDOW_MS = 60 * 1000;
const SENSITIVE_QUERY_KEYS = /(token|secret|signature|pin|password|key|authorization)/i;

const rateBuckets = new Map();
let pruneCounter = 0;

function configuredCorsOrigins(env = process.env) {
  return String(env.ELDERCARE_CORS_ORIGINS || env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isProduction(env = process.env) {
  return env.NODE_ENV === 'production';
}

function isOriginAllowed(origin, env = process.env) {
  if (!origin) return true;

  const origins = configuredCorsOrigins(env);
  if (!origins.length) return !isProduction(env);

  return origins.includes(origin);
}

function createCorsOptions(env = process.env) {
  return {
    origin(origin, callback) {
      callback(null, isOriginAllowed(origin, env));
    },
    optionsSuccessStatus: 204
  };
}

function createSecurityHeaders(env = process.env) {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    if (isProduction(env) && env.ELDERCARE_ENABLE_HSTS !== 'false') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }

    next();
  };
}

function safeLogUrl(req) {
  const value = String(req.originalUrl || req.url || '');
  if (process.env.NODE_ENV === 'production') return value.split('?')[0] || '/';

  try {
    const parsed = new URL(value, 'http://eldercare.local');
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.test(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    const query = parsed.searchParams.toString();
    return `${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch (error) {
    return value.split('?')[0] || '/';
  }
}

function clientAddress(req) {
  return req.ip
    || String(req.get?.('x-forwarded-for') || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

function pruneExpiredBuckets(now) {
  pruneCounter += 1;
  if (pruneCounter % 100 !== 0) return;

  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

function createRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  max = 120,
  keyPrefix = 'global',
  message = 'Too many requests'
} = {}) {
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 120;
  const windowLength = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
    ? Number(windowMs)
    : DEFAULT_WINDOW_MS;

  return (req, res, next) => {
    if (process.env.ELDERCARE_RATE_LIMIT_DISABLED === 'true') return next();

    const now = Date.now();
    pruneExpiredBuckets(now);

    const key = `${keyPrefix}:${clientAddress(req)}`;
    const existing = rateBuckets.get(key);
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowLength };

    bucket.count += 1;
    rateBuckets.set(key, bucket);

    const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        ok: false,
        error: message,
        code: 'RATE_LIMITED'
      });
    }

    return next();
  };
}

module.exports = {
  configuredCorsOrigins,
  createCorsOptions,
  createRateLimiter,
  createSecurityHeaders,
  isOriginAllowed,
  safeLogUrl
};
