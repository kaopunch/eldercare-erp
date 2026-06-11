/**
 * Auth business logic for both portals (role = 'customer' | 'caregiver').
 * Flow per spec C1/G1:
 *   register(phone)            -> create OTP, send via SmsProvider
 *   verifyOtpAndRegister(...)  -> verify OTP, create user with password, issue tokens
 *   login(phone, password)     -> issue tokens
 *   refresh(refreshToken)      -> rotate refresh token, new access token
 *   logout(refreshToken)       -> revoke refresh token
 *
 * createAuthService(deps) allows injecting repository/sms for unit tests.
 */
const crypto = require('crypto');
const defaultRepository = require('./repository');
const { getSmsProvider } = require('../notification/smsProvider');
const { AppError } = require('../shared/appError');
const { normalizePhone } = require('../shared/phone');
const {
  hashPassword,
  verifyPassword,
  tokenHash,
  signAccessToken,
  newRefreshToken,
  refreshTokenExpiry
} = require('../shared/crypto');

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_WINDOW = 3;
const OTP_WINDOW_MINUTES = 10;
const PASSWORD_MIN_LENGTH = 8;

function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email || null,
    role: user.role,
    status: user.status,
    line_user_id: user.line_user_id || null
  };
}

function createAuthService({ repository = defaultRepository, smsProvider = null } = {}) {
  const sms = () => smsProvider || getSmsProvider();

  async function issueTokens(user) {
    const refreshToken = newRefreshToken();
    await repository.storeRefreshToken({
      userId: user.id,
      tokenHash: tokenHash(refreshToken),
      expiresAt: refreshTokenExpiry().toISOString()
    });
    const access = signAccessToken(user);
    return {
      user: publicUser(user),
      access_token: access.token,
      expires_in: access.expiresInSeconds,
      refresh_token: refreshToken
    };
  }

  /** Step 1 of registration: request OTP. Idempotent per phone (re-request allowed within rate limit). */
  async function register({ phone, role }) {
    const normalized = normalizePhone(phone);
    const existing = await repository.findUserByPhone(normalized);
    if (existing) {
      throw new AppError('PHONE_ALREADY_REGISTERED', 'เบอร์นี้สมัครไว้แล้ว กรุณาเข้าสู่ระบบ', 409);
    }
    return requestOtp({ phone: normalized, purpose: 'register', role });
  }

  /** OTP request shared by register + OTP login. */
  async function requestOtp({ phone, purpose, role }) {
    const normalized = normalizePhone(phone);
    const since = new Date(Date.now() - OTP_WINDOW_MINUTES * 60 * 1000).toISOString();
    const recent = await repository.countRecentOtps(normalized, purpose, since);
    if (recent >= OTP_MAX_PER_WINDOW) {
      throw new AppError('OTP_RATE_LIMITED', 'ขอรหัส OTP บ่อยเกินไป กรุณารอสักครู่', 429);
    }
    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
    await repository.createOtp({ phone: normalized, purpose, codeHash: tokenHash(code), expiresAt });
    await sms().sendSms(
      normalized,
      `รหัส OTP อุ่นใจ Care ของคุณคือ ${code} (หมดอายุใน ${OTP_TTL_MINUTES} นาที)`
    );
    const response = { phone: normalized, purpose, expires_in: OTP_TTL_MINUTES * 60, role: role || null };
    if (process.env.NODE_ENV !== 'production' && sms().name === 'mock') {
      response.dev_otp = code; // mock provider only — never present in production
    }
    return response;
  }

  async function assertOtpValid(phone, purpose, code) {
    const otp = await repository.findActiveOtp(phone, purpose);
    if (!otp) {
      throw new AppError('OTP_NOT_FOUND', 'ไม่พบรหัส OTP หรือรหัสหมดอายุ กรุณาขอรหัสใหม่', 400);
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new AppError('OTP_LOCKED', 'กรอกรหัสผิดหลายครั้งเกินไป กรุณาขอรหัสใหม่', 429);
    }
    if (tokenHash(String(code)) !== otp.code_hash) {
      await repository.bumpOtpAttempts(otp.id, otp.attempts + 1);
      throw new AppError('OTP_INCORRECT', 'รหัส OTP ไม่ถูกต้อง', 400);
    }
    const consumed = await repository.consumeOtp(otp.id);
    if (!consumed) {
      // already consumed concurrently — treat the repeat as success (idempotent)
      throw new AppError('OTP_NOT_FOUND', 'รหัสนี้ถูกใช้ไปแล้ว กรุณาขอรหัสใหม่', 400);
    }
  }

  /** Step 2 of registration: verify OTP, set password, create the account, log in. */
  async function verifyOtpAndRegister({ phone, code, password, role, email }) {
    const normalized = normalizePhone(phone);
    if (!['customer', 'caregiver'].includes(role)) {
      throw new AppError('ROLE_INVALID', 'ประเภทผู้ใช้ไม่ถูกต้อง', 422);
    }
    if (String(password || '').length < PASSWORD_MIN_LENGTH) {
      throw new AppError('PASSWORD_TOO_SHORT', `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`, 422);
    }
    const existing = await repository.findUserByPhone(normalized);
    if (existing) {
      throw new AppError('PHONE_ALREADY_REGISTERED', 'เบอร์นี้สมัครไว้แล้ว กรุณาเข้าสู่ระบบ', 409);
    }
    await assertOtpValid(normalized, 'register', code);
    const user = await repository.createUser({
      phone: normalized,
      role,
      passwordHash: hashPassword(password),
      email: email || null
    });
    return issueTokens(user);
  }

  async function login({ phone, password, role }) {
    const normalized = normalizePhone(phone);
    const user = await repository.findUserByPhone(normalized);
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      throw new AppError('LOGIN_FAILED', 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง', 401);
    }
    if (role && user.role !== role) {
      throw new AppError('ROLE_MISMATCH', 'บัญชีนี้ไม่ใช่บัญชีสำหรับพอร์ทัลนี้', 403);
    }
    if (user.status === 'suspended') {
      throw new AppError('ACCOUNT_SUSPENDED', 'บัญชีถูกระงับ กรุณาติดต่อทีมงาน', 403);
    }
    return issueTokens(user);
  }

  /** OTP login (spec C1: login เบอร์+รหัสผ่าน / OTP). */
  async function loginWithOtp({ phone, code, role }) {
    const normalized = normalizePhone(phone);
    const user = await repository.findUserByPhone(normalized);
    if (!user) {
      throw new AppError('LOGIN_FAILED', 'ไม่พบบัญชีสำหรับเบอร์นี้', 401);
    }
    if (role && user.role !== role) {
      throw new AppError('ROLE_MISMATCH', 'บัญชีนี้ไม่ใช่บัญชีสำหรับพอร์ทัลนี้', 403);
    }
    if (user.status === 'suspended') {
      throw new AppError('ACCOUNT_SUSPENDED', 'บัญชีถูกระงับ กรุณาติดต่อทีมงาน', 403);
    }
    await assertOtpValid(normalized, 'login', code);
    return issueTokens(user);
  }

  async function refresh({ refreshToken }) {
    const stored = await repository.findRefreshToken(tokenHash(String(refreshToken || '')));
    if (!stored || stored.revoked_at || new Date(stored.expires_at).getTime() < Date.now()) {
      throw new AppError('REFRESH_INVALID', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
    }
    const user = await repository.findUserById(stored.user_id);
    if (!user || user.status === 'suspended') {
      throw new AppError('REFRESH_INVALID', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
    }
    await repository.revokeRefreshToken(stored.id); // rotation: old token is single-use
    return issueTokens(user);
  }

  async function logout({ refreshToken }) {
    const stored = await repository.findRefreshToken(tokenHash(String(refreshToken || '')));
    if (stored && !stored.revoked_at) {
      await repository.revokeRefreshToken(stored.id);
    }
    return { ok: true }; // idempotent: logging out twice is fine
  }

  return { register, requestOtp, verifyOtpAndRegister, login, loginWithOtp, refresh, logout };
}

module.exports = { createAuthService };
