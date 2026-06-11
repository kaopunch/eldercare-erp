/**
 * Crypto helpers for the care platform: password hashing (pbkdf2_sha256 — same
 * scheme/iterations as the ERP PIN hashing in lib/session.js), HS256 JWT for
 * portal access tokens, SHA-256 hashing for OTP/refresh tokens, and AES-256-GCM
 * for sensitive-at-rest fields (id card number).
 */
const crypto = require('crypto');
const { AppError } = require('./appError');

const PBKDF2_ITERATIONS = 180000;
const PBKDF2_KEY_LENGTH = 32;
const PASSWORD_PREFIX = 'pbkdf2_sha256';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // spec: access 15 min
const REFRESH_TOKEN_TTL_DAYS = 30; // spec: refresh 30 days

function requiredSecret(envKey, devFallback) {
  const value = process.env[envKey];
  if (!value) {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError('CONFIG_MISSING', 'ระบบยังตั้งค่าไม่ครบ กรุณาติดต่อทีมงาน', 500, { env: envKey });
    }
    return devFallback;
  }
  return value;
}

function jwtSecret() {
  return requiredSecret('CARE_JWT_SECRET', 'care-development-jwt-secret');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto
    .pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha256')
    .toString('base64url');
  return `${PASSWORD_PREFIX}$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const expected = Buffer.from(parts[3], 'base64url');
  const actual = crypto.pbkdf2Sync(String(password), parts[2], iterations, expected.length, 'sha256');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Deterministic hash for OTP codes and refresh tokens (never store plaintext). */
function tokenHash(value) {
  return crypto.createHmac('sha256', jwtSecret()).update(String(value)).digest('base64url');
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function signAccessToken(user, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: user.id,
    role: user.role,
    phone: user.phone,
    typ: 'care_access',
    iat: nowSeconds,
    exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS
  }));
  const body = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', jwtSecret()).update(body).digest('base64url');
  return { token: `${body}.${signature}`, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS };
}

function verifyAccessToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw new AppError('TOKEN_INVALID', 'กรุณาเข้าสู่ระบบใหม่', 401);
  }
  const body = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', jwtSecret()).update(body).digest('base64url');
  const actual = Buffer.from(parts[2]);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !crypto.timingSafeEqual(actual, expectedBuffer)) {
    throw new AppError('TOKEN_INVALID', 'กรุณาเข้าสู่ระบบใหม่', 401);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new AppError('TOKEN_INVALID', 'กรุณาเข้าสู่ระบบใหม่', 401);
  }
  if (payload.typ !== 'care_access' || !payload.sub) {
    throw new AppError('TOKEN_INVALID', 'กรุณาเข้าสู่ระบบใหม่', 401);
  }
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 < Date.now()) {
    throw new AppError('TOKEN_EXPIRED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  }
  return payload;
}

function newRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function refreshTokenExpiry(now = new Date()) {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function encryptionKey() {
  const raw = requiredSecret('CARE_ENCRYPTION_KEY', 'care-development-encryption-key');
  return crypto.createHash('sha256').update(raw).digest();
}

/** AES-256-GCM, output base64url(iv).base64url(tag).base64url(cipher) */
function encryptSensitive(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSensitive(stored) {
  const [iv, tag, data] = String(stored || '').split('.');
  if (!iv || !tag || !data) {
    throw new AppError('DECRYPT_FAILED', 'ข้อมูลไม่ถูกต้อง', 500);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_DAYS,
  hashPassword,
  verifyPassword,
  tokenHash,
  signAccessToken,
  verifyAccessToken,
  newRefreshToken,
  refreshTokenExpiry,
  encryptSensitive,
  decryptSensitive
};
