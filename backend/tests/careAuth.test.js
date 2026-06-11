const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hashPassword,
  verifyPassword,
  signAccessToken,
  verifyAccessToken,
  encryptSensitive,
  decryptSensitive
} = require('../src/modules/shared/crypto');
const { normalizePhone } = require('../src/modules/shared/phone');
const { createAuthService } = require('../src/modules/auth/service');
const { MockSmsProvider } = require('../src/modules/notification/smsProvider');

function createFakeAuthRepository() {
  const users = [];
  const otps = [];
  const refreshTokens = [];
  let nextId = 1;
  const id = () => `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`;
  return {
    users,
    otps,
    refreshTokens,
    async findUserByPhone(phone) {
      return users.find((user) => user.phone === phone) || null;
    },
    async findUserById(userId) {
      return users.find((user) => user.id === userId) || null;
    },
    async createUser({ phone, role, passwordHash, email }) {
      const user = {
        id: id(),
        phone,
        role,
        email,
        password_hash: passwordHash,
        status: 'active',
        line_user_id: null
      };
      users.push(user);
      return user;
    },
    async countRecentOtps(phone, purpose, sinceIso) {
      return otps.filter(
        (otp) => otp.phone === phone && otp.purpose === purpose && otp.created_at >= sinceIso
      ).length;
    },
    async createOtp({ phone, purpose, codeHash, expiresAt }) {
      const otp = {
        id: id(),
        phone,
        purpose,
        code_hash: codeHash,
        expires_at: expiresAt,
        attempts: 0,
        consumed_at: null,
        created_at: new Date().toISOString()
      };
      otps.push(otp);
      return { id: otp.id };
    },
    async findActiveOtp(phone, purpose) {
      const now = new Date().toISOString();
      return (
        [...otps]
          .reverse()
          .find(
            (otp) =>
              otp.phone === phone && otp.purpose === purpose && !otp.consumed_at && otp.expires_at > now
          ) || null
      );
    },
    async bumpOtpAttempts(otpId, attempts) {
      const otp = otps.find((row) => row.id === otpId);
      otp.attempts = attempts;
      return { id: otpId };
    },
    async consumeOtp(otpId) {
      const otp = otps.find((row) => row.id === otpId);
      if (!otp || otp.consumed_at) return null;
      otp.consumed_at = new Date().toISOString();
      return { id: otpId };
    },
    async storeRefreshToken({ userId, tokenHash, expiresAt }) {
      const token = { id: id(), user_id: userId, token_hash: tokenHash, expires_at: expiresAt, revoked_at: null };
      refreshTokens.push(token);
      return { id: token.id };
    },
    async findRefreshToken(tokenHashValue) {
      return refreshTokens.find((token) => token.token_hash === tokenHashValue) || null;
    },
    async revokeRefreshToken(tokenId) {
      const token = refreshTokens.find((row) => row.id === tokenId);
      token.revoked_at = new Date().toISOString();
      return { id: tokenId };
    }
  };
}

function buildService() {
  const repository = createFakeAuthRepository();
  const sms = new MockSmsProvider();
  const service = createAuthService({ repository, smsProvider: sms });
  return { repository, sms, service };
}

test('password hash/verify roundtrip', () => {
  const stored = hashPassword('s3cret-pass');
  assert.ok(stored.startsWith('pbkdf2_sha256$'));
  assert.equal(verifyPassword('s3cret-pass', stored), true);
  assert.equal(verifyPassword('wrong-pass', stored), false);
});

test('access token sign/verify carries sub+role and rejects tampering', () => {
  const { token } = signAccessToken({ id: 'u1', role: 'customer', phone: '+66812345678' });
  const payload = verifyAccessToken(token);
  assert.equal(payload.sub, 'u1');
  assert.equal(payload.role, 'customer');
  assert.throws(() => verifyAccessToken(`${token}x`), /กรุณาเข้าสู่ระบบใหม่/);
});

test('expired access token is rejected', () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const { token } = signAccessToken({ id: 'u1', role: 'customer', phone: '+66812345678' }, past);
  assert.throws(() => verifyAccessToken(token), (err) => err.code === 'TOKEN_EXPIRED');
});

test('sensitive encryption roundtrip never returns plaintext format', () => {
  const encrypted = encryptSensitive('1234567890123');
  assert.equal(encrypted.includes('1234567890123'), false);
  assert.equal(decryptSensitive(encrypted), '1234567890123');
});

test('thai phone numbers normalize to E.164', () => {
  assert.equal(normalizePhone('0812345678'), '+66812345678');
  assert.equal(normalizePhone('66812345678'), '+66812345678');
  assert.equal(normalizePhone('+66812345678'), '+66812345678');
  assert.equal(normalizePhone('081-234-5678'), '+66812345678');
  assert.throws(() => normalizePhone('12345'), (err) => err.code === 'PHONE_INVALID');
});

test('register sends OTP via SmsProvider and full registration flow works', async () => {
  const { sms, service } = buildService();
  const requested = await service.register({ phone: '0812345678', role: 'customer' });
  assert.equal(requested.phone, '+66812345678');
  assert.equal(sms.sent.length, 1);
  assert.match(sms.sent[0].message, /OTP/);
  assert.ok(requested.dev_otp, 'mock provider exposes dev_otp outside production');

  const session = await service.verifyOtpAndRegister({
    phone: '0812345678',
    code: requested.dev_otp,
    password: 'password123',
    role: 'customer'
  });
  assert.equal(session.user.role, 'customer');
  assert.equal(session.user.status, 'active');
  assert.ok(session.access_token);
  assert.ok(session.refresh_token);
  assert.equal(Object.hasOwn(session.user, 'password_hash'), false);
});

test('register rejects an already registered phone', async () => {
  const { service } = buildService();
  const requested = await service.register({ phone: '0812345678', role: 'customer' });
  await service.verifyOtpAndRegister({
    phone: '0812345678',
    code: requested.dev_otp,
    password: 'password123',
    role: 'customer'
  });
  await assert.rejects(
    service.register({ phone: '0812345678', role: 'customer' }),
    (err) => err.code === 'PHONE_ALREADY_REGISTERED'
  );
});

test('wrong OTP bumps attempts and locks after 5 tries', async () => {
  const { repository, service } = buildService();
  await service.register({ phone: '0812345678', role: 'customer' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      service.verifyOtpAndRegister({
        phone: '0812345678',
        code: '000000',
        password: 'password123',
        role: 'customer'
      }),
      (err) => err.code === 'OTP_INCORRECT'
    );
  }
  assert.equal(repository.otps[0].attempts, 5);
  await assert.rejects(
    service.verifyOtpAndRegister({
      phone: '0812345678',
      code: '000000',
      password: 'password123',
      role: 'customer'
    }),
    (err) => err.code === 'OTP_LOCKED'
  );
});

test('OTP requests are rate limited per phone', async () => {
  const { service } = buildService();
  await service.register({ phone: '0812345678', role: 'customer' });
  await service.register({ phone: '0812345678', role: 'customer' }).catch(() => {});
  await service.requestOtp({ phone: '0812345678', purpose: 'register' });
  await assert.rejects(
    service.requestOtp({ phone: '0812345678', purpose: 'register' }),
    (err) => err.code === 'OTP_RATE_LIMITED'
  );
});

test('login validates credentials and portal role', async () => {
  const { service } = buildService();
  const requested = await service.register({ phone: '0812345678', role: 'customer' });
  await service.verifyOtpAndRegister({
    phone: '0812345678',
    code: requested.dev_otp,
    password: 'password123',
    role: 'customer'
  });

  const session = await service.login({ phone: '0812345678', password: 'password123', role: 'customer' });
  assert.equal(session.user.phone, '+66812345678');

  await assert.rejects(
    service.login({ phone: '0812345678', password: 'wrong', role: 'customer' }),
    (err) => err.code === 'LOGIN_FAILED'
  );
  await assert.rejects(
    service.login({ phone: '0812345678', password: 'password123', role: 'caregiver' }),
    (err) => err.code === 'ROLE_MISMATCH'
  );
});

test('refresh rotates the token: old refresh token becomes unusable', async () => {
  const { service } = buildService();
  const requested = await service.register({ phone: '0812345678', role: 'caregiver' });
  const session = await service.verifyOtpAndRegister({
    phone: '0812345678',
    code: requested.dev_otp,
    password: 'password123',
    role: 'caregiver'
  });

  const renewed = await service.refresh({ refreshToken: session.refresh_token });
  assert.ok(renewed.access_token);
  assert.notEqual(renewed.refresh_token, session.refresh_token);

  await assert.rejects(
    service.refresh({ refreshToken: session.refresh_token }),
    (err) => err.code === 'REFRESH_INVALID'
  );
});

test('logout is idempotent', async () => {
  const { service } = buildService();
  const requested = await service.register({ phone: '0812345678', role: 'customer' });
  const session = await service.verifyOtpAndRegister({
    phone: '0812345678',
    code: requested.dev_otp,
    password: 'password123',
    role: 'customer'
  });
  assert.deepEqual(await service.logout({ refreshToken: session.refresh_token }), { ok: true });
  assert.deepEqual(await service.logout({ refreshToken: session.refresh_token }), { ok: true });
});
