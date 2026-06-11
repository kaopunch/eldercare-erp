/** DB access for care platform auth (care_users, care_otp_codes, care_refresh_tokens). */
const { getSupabase } = require('../../db/supabase');
const { AppError } = require('../shared/appError');

function db() {
  return getSupabase();
}

function unwrap({ data, error }) {
  if (error) {
    throw new AppError('DB_ERROR', 'เกิดข้อผิดพลาดภายในระบบ', 500, { hint: error.message });
  }
  return data;
}

async function findUserByPhone(phone) {
  return unwrap(await db().from('care_users').select('*').eq('phone', phone).maybeSingle());
}

async function findUserById(id) {
  return unwrap(await db().from('care_users').select('*').eq('id', id).maybeSingle());
}

async function createUser({ phone, role, passwordHash, email = null }) {
  return unwrap(
    await db()
      .from('care_users')
      .insert({
        phone,
        role,
        email,
        password_hash: passwordHash,
        status: 'active'
      })
      .select('*')
      .single()
  );
}

async function countRecentOtps(phone, purpose, sinceIso) {
  const { count, error } = await db()
    .from('care_otp_codes')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phone)
    .eq('purpose', purpose)
    .gte('created_at', sinceIso);
  if (error) throw new AppError('DB_ERROR', 'เกิดข้อผิดพลาดภายในระบบ', 500, { hint: error.message });
  return count || 0;
}

async function createOtp({ phone, purpose, codeHash, expiresAt }) {
  return unwrap(
    await db()
      .from('care_otp_codes')
      .insert({ phone, purpose, code_hash: codeHash, expires_at: expiresAt })
      .select('id')
      .single()
  );
}

async function findActiveOtp(phone, purpose) {
  return unwrap(
    await db()
      .from('care_otp_codes')
      .select('*')
      .eq('phone', phone)
      .eq('purpose', purpose)
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

async function bumpOtpAttempts(id, attempts) {
  return unwrap(await db().from('care_otp_codes').update({ attempts }).eq('id', id).select('id').single());
}

async function consumeOtp(id) {
  return unwrap(
    await db()
      .from('care_otp_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', id)
      .is('consumed_at', null)
      .select('id')
      .maybeSingle()
  );
}

async function storeRefreshToken({ userId, tokenHash, expiresAt }) {
  return unwrap(
    await db()
      .from('care_refresh_tokens')
      .insert({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt })
      .select('id')
      .single()
  );
}

async function findRefreshToken(tokenHashValue) {
  return unwrap(
    await db()
      .from('care_refresh_tokens')
      .select('*')
      .eq('token_hash', tokenHashValue)
      .maybeSingle()
  );
}

async function revokeRefreshToken(id) {
  return unwrap(
    await db()
      .from('care_refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
      .single()
  );
}

module.exports = {
  findUserByPhone,
  findUserById,
  createUser,
  countRecentOtps,
  createOtp,
  findActiveOtp,
  bumpOtpAttempts,
  consumeOtp,
  storeRefreshToken,
  findRefreshToken,
  revokeRefreshToken
};
