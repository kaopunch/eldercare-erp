const crypto = require('crypto');

const SESSION_VERSION = 1;
const HASH_ALGORITHM = 'sha256';
const PIN_HASH_PREFIX = 'pbkdf2_sha256';
const PIN_HASH_ITERATIONS = 180000;
const PIN_HASH_KEY_LENGTH = 32;

function authMode() {
  return process.env.ELDERCARE_AUTH_MODE || (process.env.NODE_ENV === 'production' ? 'pin' : 'demo');
}

function demoAuthAllowed() {
  if (process.env.ELDERCARE_DEMO_AUTH === 'true') return true;
  if (process.env.ELDERCARE_DEMO_AUTH === 'false') return false;
  return process.env.NODE_ENV !== 'production' && authMode() !== 'pin';
}

function pinAuthRequired() {
  return authMode() === 'pin';
}

function sessionHours() {
  const value = Number(process.env.ELDERCARE_SESSION_HOURS || 12);
  return Number.isFinite(value) && value > 0 ? value : 12;
}

function sessionSecret() {
  const secret = process.env.ELDERCARE_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret && process.env.NODE_ENV === 'production') {
    const error = new Error('ELDERCARE_SESSION_SECRET is required in production');
    error.statusCode = 500;
    error.code = 'SESSION_SECRET_MISSING';
    throw error;
  }
  return secret || 'eldercare-development-session-secret';
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value) {
  return crypto.createHmac(HASH_ALGORITHM, sessionSecret()).update(value).digest('base64url');
}

function createSessionToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + sessionHours() * 60 * 60;
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT', v: SESSION_VERSION }));
  const payload = base64Url(JSON.stringify({
    sub: user.id,
    role: user.role,
    company_id: user.company_id || null,
    branch_id: user.branch_id || null,
    must_rotate_pin: user.must_rotate_pin === true,
    iat: now,
    exp
  }));
  const body = `${header}.${payload}`;
  return {
    token: `${body}.${sign(body)}`,
    expires_at: new Date(exp * 1000).toISOString()
  };
}

function verifySessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    const error = new Error('invalid session token');
    error.statusCode = 401;
    error.code = 'SESSION_INVALID';
    throw error;
  }
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    const error = new Error('invalid session signature');
    error.statusCode = 401;
    error.code = 'SESSION_INVALID';
    throw error;
  }

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || !claims.role || Number(claims.exp || 0) <= now) {
    const error = new Error('session expired or incomplete');
    error.statusCode = 401;
    error.code = 'SESSION_EXPIRED';
    throw error;
  }
  return claims;
}

function bearerToken(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match
    ? match[1]
    : req.get('x-eldercare-session') || req.query?.session_token || req.query?.token || null;
}

function sessionSignature(token) {
  const parts = String(token || '').split('.');
  return parts.length === 3 ? parts[2] : null;
}

function hashPin(pin) {
  const normalized = String(pin || '').trim();
  if (normalized.length < 4) {
    const error = new Error('PIN must be at least 4 characters');
    error.statusCode = 422;
    error.code = 'PIN_TOO_SHORT';
    throw error;
  }
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(normalized, salt, PIN_HASH_ITERATIONS, PIN_HASH_KEY_LENGTH, HASH_ALGORITHM).toString('base64url');
  return `${PIN_HASH_PREFIX}$${PIN_HASH_ITERATIONS}$${salt}$${hash}`;
}

function verifyPin(pin, storedHash) {
  const normalized = String(pin || '').trim();
  const [prefix, iterations, salt, hash] = String(storedHash || '').split('$');
  if (prefix !== PIN_HASH_PREFIX || !iterations || !salt || !hash) return false;
  const actual = crypto.pbkdf2Sync(normalized, salt, Number(iterations), PIN_HASH_KEY_LENGTH, HASH_ALGORITHM).toString('base64url');
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(hash);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

module.exports = {
  authMode,
  bearerToken,
  createSessionToken,
  demoAuthAllowed,
  hashPin,
  pinAuthRequired,
  sessionSignature,
  sessionHours,
  verifyPin,
  verifySessionToken
};
