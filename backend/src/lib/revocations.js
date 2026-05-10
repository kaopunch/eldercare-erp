const { sessionSignature } = require('./session');

const TOKEN_REVOCATION_TABLE = 'app_session_revocations';
const USER_REVOCATION_TABLE = 'app_user_session_revocations';

const memoryTokenRevocations = new Map();
const memoryUserRevocations = new Map();

function nowIso() {
  return new Date().toISOString();
}

function isMissingRevocationSchema(error) {
  return ['42P01', 'PGRST205', 'PGRST204'].includes(error?.code)
    || /app_session_revocations|app_user_session_revocations|schema cache|does not exist/i.test(error?.message || '');
}

function safeDateMs(value) {
  const ms = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function issuedAtMs(claims = {}) {
  const iat = Number(claims.iat || 0);
  return Number.isFinite(iat) ? iat * 1000 : 0;
}

function pruneMemoryRevocations() {
  const now = Date.now();
  for (const [signature, row] of memoryTokenRevocations.entries()) {
    if (row.expires_at && safeDateMs(row.expires_at) <= now) {
      memoryTokenRevocations.delete(signature);
    }
  }
}

function isRevokedByMemory(token, claims = {}) {
  pruneMemoryRevocations();
  const signature = sessionSignature(token);
  if (signature && memoryTokenRevocations.has(signature)) return true;

  const revokedAfter = memoryUserRevocations.get(claims.sub);
  return Boolean(revokedAfter && issuedAtMs(claims) <= safeDateMs(revokedAfter.revoked_after));
}

async function isTokenRevoked(sb, token, claims = {}) {
  if (isRevokedByMemory(token, claims)) return true;

  const signature = sessionSignature(token);
  if (signature) {
    const { data, error } = await sb.from(TOKEN_REVOCATION_TABLE)
      .select('token_signature,expires_at')
      .eq('token_signature', signature)
      .maybeSingle();
    if (error) {
      if (!isMissingRevocationSchema(error)) throw error;
    } else if (data && (!data.expires_at || safeDateMs(data.expires_at) > Date.now())) {
      return true;
    }
  }

  if (claims.sub) {
    const { data, error } = await sb.from(USER_REVOCATION_TABLE)
      .select('user_id,revoked_after')
      .eq('user_id', claims.sub)
      .maybeSingle();
    if (error) {
      if (!isMissingRevocationSchema(error)) throw error;
    } else if (data?.revoked_after && issuedAtMs(claims) <= safeDateMs(data.revoked_after)) {
      return true;
    }
  }

  return false;
}

async function revokeToken(sb, {
  token,
  userId = null,
  revokedBy = null,
  reason = 'logout',
  expiresAt = null
} = {}) {
  const signature = sessionSignature(token);
  if (!signature) return { persistent: false, revoked: false };

  const row = {
    token_signature: signature,
    user_id: userId,
    revoked_by: revokedBy,
    reason,
    revoked_at: nowIso(),
    expires_at: expiresAt
  };
  memoryTokenRevocations.set(signature, row);

  const { error } = await sb.from(TOKEN_REVOCATION_TABLE)
    .upsert(row, { onConflict: 'token_signature' });
  if (error && !isMissingRevocationSchema(error)) throw error;

  return {
    persistent: !isMissingRevocationSchema(error),
    revoked: true,
    revoked_at: row.revoked_at
  };
}

async function revokeUserSessions(sb, {
  userId,
  revokedBy = null,
  reason = 'admin_revoke_sessions'
} = {}) {
  if (!userId) {
    const error = new Error('user id is required');
    error.statusCode = 422;
    error.code = 'USER_ID_REQUIRED';
    throw error;
  }

  const row = {
    user_id: userId,
    revoked_by: revokedBy,
    reason,
    revoked_after: nowIso(),
    updated_at: nowIso()
  };
  memoryUserRevocations.set(userId, row);

  const { error } = await sb.from(USER_REVOCATION_TABLE)
    .upsert(row, { onConflict: 'user_id' });
  if (error && !isMissingRevocationSchema(error)) throw error;

  return {
    persistent: !isMissingRevocationSchema(error),
    revoked: true,
    revoked_after: row.revoked_after
  };
}

function safeTokenRow(row) {
  return {
    token_signature_tail: String(row.token_signature || '').slice(-10),
    user_id: row.user_id || null,
    revoked_by: row.revoked_by || null,
    reason: row.reason || null,
    revoked_at: row.revoked_at || null,
    expires_at: row.expires_at || null
  };
}

async function listSessionRevocations(sb, limit = 50) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const memoryTokenRows = [...memoryTokenRevocations.values()].map(safeTokenRow);
  const memoryUserRows = [...memoryUserRevocations.values()];
  let persistent = true;
  let tokenRows = [];
  let userRows = [];

  const tokenResult = await sb.from(TOKEN_REVOCATION_TABLE)
    .select('token_signature,user_id,revoked_by,reason,revoked_at,expires_at')
    .order('revoked_at', { ascending: false })
    .limit(normalizedLimit);
  if (tokenResult.error) {
    if (!isMissingRevocationSchema(tokenResult.error)) throw tokenResult.error;
    persistent = false;
  } else {
    tokenRows = (tokenResult.data || []).map(safeTokenRow);
  }

  const userResult = await sb.from(USER_REVOCATION_TABLE)
    .select('user_id,revoked_by,reason,revoked_after,updated_at')
    .order('updated_at', { ascending: false })
    .limit(normalizedLimit);
  if (userResult.error) {
    if (!isMissingRevocationSchema(userResult.error)) throw userResult.error;
    persistent = false;
  } else {
    userRows = userResult.data || [];
  }

  return {
    persistent,
    token_revocations: tokenRows.length ? tokenRows : memoryTokenRows,
    user_session_revocations: userRows.length ? userRows : memoryUserRows
  };
}

module.exports = {
  isMissingRevocationSchema,
  isTokenRevoked,
  listSessionRevocations,
  revokeToken,
  revokeUserSessions
};
