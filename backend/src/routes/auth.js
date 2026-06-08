const express = require('express');
const { getSupabase } = require('../db/supabase');
const { findUser, normalizeRole, resolveActor } = require('../middleware/auth');
const {
  authMode,
  bearerToken,
  createSessionToken,
  demoAuthAllowed,
  hashPassword,
  pinAuthRequired,
  sessionHours,
  verifyPassword,
  verifySessionToken
} = require('../lib/session');
const { revokeToken } = require('../lib/revocations');

const router = express.Router();

const DEMO_ROLES = [
  'owner',
  'super_admin',
  'admin',
  'branch_admin',
  'dispatcher',
  'coordinator',
  'finance',
  'driver',
  'care_assistant',
  'hospital_companion',
  'home_companion',
  'trainer',
  'family_viewer'
];
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function publicUser(user) {
  return {
    id: user.id || null,
    company_id: user.company_id || null,
    branch_id: user.branch_id || null,
    full_name: user.full_name,
    phone: user.phone || null,
    email: user.email || null,
    role: user.role,
    status: user.status || 'active',
    demo: Boolean(user.demo),
    password_configured: Boolean(user.pin_configured),
    pin_configured: Boolean(user.pin_configured),
    login_enabled: user.login_enabled !== false,
    must_rotate_pin: Boolean(user.must_rotate_pin)
  };
}

function publicSession(user, session = {}) {
  return {
    ...publicUser(user),
    token: session.token || user.token || null,
    expires_at: session.expires_at || user.expires_at || null,
    must_rotate_pin: Boolean(user.must_rotate_pin || session.must_rotate_pin)
  };
}

function demoUsers() {
  return DEMO_ROLES.map((role) => publicUser({
    id: null,
    full_name: `${role} demo`,
    role,
    status: 'active',
    demo: true,
    login_enabled: true
  }));
}

function authConfig() {
  return {
    mode: authMode(),
    demo_allowed: demoAuthAllowed(),
    password_required: pinAuthRequired(),
    pin_required: pinAuthRequired(),
    session_hours: sessionHours(),
    max_failed_attempts: MAX_FAILED_ATTEMPTS,
    lock_minutes: LOCK_MINUTES
  };
}

function isMissingCredentialSchema(error) {
  return ['42P01', 'PGRST205', 'PGRST204'].includes(error?.code)
    || /app_user_credentials|schema cache|does not exist/i.test(error?.message || '');
}

async function activeUsers(sb) {
  const { data, error } = await sb.from('app_users')
    .select('id,company_id,branch_id,full_name,phone,email,role,status')
    .eq('status', 'active')
    .order('role', { ascending: true })
    .order('full_name', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function findActiveUserByLogin(sb, login) {
  const raw = String(login || '').trim();
  const normalized = raw.toLowerCase();
  if (!normalized) return null;
  const users = await activeUsers(sb);
  const matches = users.filter((user) => {
    const email = String(user.email || '').trim().toLowerCase();
    const phone = String(user.phone || '').trim();
    const role = String(user.role || '').trim().toLowerCase();
    return email === normalized || phone === raw || role === normalized;
  });
  return matches.length === 1 ? matches[0] : null;
}

async function credentialMap(sb, userIds) {
  if (!userIds.length) return new Map();
  const { data, error } = await sb.from('app_user_credentials')
    .select('user_id,locked_until,must_rotate_pin')
    .in('user_id', userIds);
  if (error) {
    if (isMissingCredentialSchema(error)) return null;
    throw error;
  }
  return new Map((data || []).map((row) => [row.user_id, row]));
}

async function credentialForUser(sb, userId) {
  const { data, error } = await sb.from('app_user_credentials')
    .select('user_id,login_pin_hash,must_rotate_pin,failed_attempts,locked_until')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (isMissingCredentialSchema(error)) return undefined;
    throw error;
  }
  return data || null;
}

async function markLoginFailure(sb, credential) {
  if (!credential) return;
  const failedAttempts = Number(credential.failed_attempts || 0) + 1;
  const lockedUntil = failedAttempts >= MAX_FAILED_ATTEMPTS
    ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString()
    : credential.locked_until || null;
  await sb.from('app_user_credentials')
    .update({
      failed_attempts: failedAttempts,
      locked_until: lockedUntil,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', credential.user_id);
}

async function markLoginSuccess(sb, userId) {
  await sb.from('app_user_credentials')
    .update({
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId);
  await sb.from('audit_logs').insert({
    actor_user_id: userId,
    action: 'auth.login',
    entity_type: 'app_user',
    entity_id: userId,
    payload: { mode: authMode() }
  });
}

async function verifyCredentialLogin(sb, user, password) {
  const credential = await credentialForUser(sb, user.id);
  if (credential === undefined) {
    const error = new Error('Password login schema is missing. Run database/003_app_user_login.sql in Supabase SQL Editor.');
    error.statusCode = 500;
    error.code = 'AUTH_SCHEMA_MISSING';
    throw error;
  }

  if (!credential) {
    if (pinAuthRequired()) {
      const error = new Error('Password has not been configured for this user');
      error.statusCode = 403;
      error.code = 'PASSWORD_NOT_SET';
      throw error;
    }
    return;
  }

  if (credential.locked_until && new Date(credential.locked_until).getTime() > Date.now()) {
    const error = new Error('user login is temporarily locked');
    error.statusCode = 423;
    error.code = 'LOGIN_LOCKED';
    error.details = { locked_until: credential.locked_until };
    throw error;
  }

  if (!password || !verifyPassword(password, credential.login_pin_hash)) {
    await markLoginFailure(sb, credential);
    const error = new Error('invalid username or password');
    error.statusCode = 401;
    error.code = 'PASSWORD_INVALID';
    throw error;
  }

  await markLoginSuccess(sb, user.id);
  return credential;
}

function validatePasswordInput(password, field = 'password') {
  const value = String(password || '').trim();
  if (value.length < 4 || value.length > 128) {
    const error = new Error(`${field} must be 4-128 characters`);
    error.statusCode = 422;
    error.code = 'PASSWORD_FORMAT_INVALID';
    throw error;
  }
  return value;
}

router.get('/config', (_, res) => {
  res.json({ ok: true, config: authConfig() });
});

router.get('/users', async (_, res, next) => {
  try {
    const sb = getSupabase();
    const users = await activeUsers(sb);
    const credentials = await credentialMap(sb, users.map((user) => user.id));
    const withCredentialState = users.map((user) => {
      const credential = credentials?.get(user.id) || null;
      return publicUser({
        ...user,
        pin_configured: Boolean(credential),
        login_enabled: credentials === null ? !pinAuthRequired() : Boolean(credential) || !pinAuthRequired(),
        must_rotate_pin: Boolean(credential?.must_rotate_pin)
      });
    });
    const existingRoles = new Set(users.map((user) => user.role));
    const fallbackUsers = demoAuthAllowed()
      ? demoUsers().filter((user) => !existingRoles.has(user.role))
      : [];
    res.json({
      ok: true,
      users: [...withCredentialState, ...fallbackUsers],
      roles: DEMO_ROLES,
      config: authConfig()
    });
  } catch (e) { next(e); }
});

router.post('/session', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const loginName = req.body.username || req.body.user || req.body.email;
    const password = req.body.password || req.body.pin;
    if (req.body.user_id || loginName) {
      const user = req.body.user_id
        ? await findUser(sb, req.body.user_id)
        : await findActiveUserByLogin(sb, loginName);
      if (!user) {
        const err = new Error('valid login credentials are required');
        err.statusCode = 401;
        err.code = 'SESSION_INPUT_INVALID';
        throw err;
      }
      if (user.status !== 'active') {
        const err = new Error('user account is not active');
        err.statusCode = 403;
        err.code = 'USER_INACTIVE';
        throw err;
      }
      let credential = null;
      if (pinAuthRequired() || password) {
        credential = await verifyCredentialLogin(sb, user, password);
      }
      const sessionUser = {
        ...user,
        must_rotate_pin: Boolean(credential?.must_rotate_pin)
      };
      const session = createSessionToken(sessionUser);
      return res.json({ ok: true, session: publicSession(sessionUser, session) });
    }

    const role = normalizeRole(req.body.role);
    if (!role || !demoAuthAllowed()) {
      const err = new Error('valid login credentials are required');
      err.statusCode = 422;
      err.code = 'SESSION_INPUT_INVALID';
      throw err;
    }
    return res.json({
      ok: true,
      session: publicSession({
        id: null,
        full_name: `${role} demo`,
        role,
        status: 'active',
        demo: true
      })
    });
  } catch (e) { next(e); }
});

async function changePassword(req, res, next) {
  try {
    const sb = getSupabase();
    const actor = await resolveActor(req);
    if (!actor?.id) {
      const error = new Error('login session is required');
      error.statusCode = 401;
      error.code = 'AUTH_REQUIRED';
      throw error;
    }

    const currentPassword = validatePasswordInput(req.body.current_password || req.body.current_pin, 'current password');
    const newPassword = validatePasswordInput(req.body.new_password || req.body.new_pin, 'new password');
    const credential = await credentialForUser(sb, actor.id);
    if (!credential) {
      const error = new Error('Password has not been configured for this user');
      error.statusCode = 403;
      error.code = 'PASSWORD_NOT_SET';
      throw error;
    }

    if (credential.locked_until && new Date(credential.locked_until).getTime() > Date.now()) {
      const error = new Error('user login is temporarily locked');
      error.statusCode = 423;
      error.code = 'LOGIN_LOCKED';
      error.details = { locked_until: credential.locked_until };
      throw error;
    }

    if (!verifyPassword(currentPassword, credential.login_pin_hash)) {
      await markLoginFailure(sb, credential);
      const error = new Error('invalid current password');
      error.statusCode = 401;
      error.code = 'PASSWORD_INVALID';
      throw error;
    }

    if (verifyPassword(newPassword, credential.login_pin_hash)) {
      const error = new Error('new password must be different from current password');
      error.statusCode = 422;
      error.code = 'PASSWORD_REUSED';
      throw error;
    }

    const now = new Date().toISOString();
    const { error: updateError } = await sb.from('app_user_credentials')
      .update({
        login_pin_hash: hashPassword(newPassword),
        must_rotate_pin: false,
        failed_attempts: 0,
        locked_until: null,
        pin_updated_at: now,
        updated_at: now
      })
      .eq('user_id', actor.id);
    if (updateError) throw updateError;

    await sb.from('audit_logs').insert({
      company_id: actor.company_id || null,
      actor_user_id: actor.id,
      action: 'auth.password_changed',
      entity_type: 'app_user',
      entity_id: actor.id,
      payload: { self_service: true }
    });

    const user = await findUser(sb, actor.id);
    const sessionUser = { ...user, must_rotate_pin: false };
    const session = createSessionToken(sessionUser);
    res.json({ ok: true, session: publicSession(sessionUser, session) });
  } catch (e) { next(e); }
}

router.post('/password', changePassword);
router.post('/pin', changePassword);

router.post('/logout', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const token = bearerToken(req);
    if (!token) return res.json({ ok: true });

    let claims = null;
    let actor = null;
    try {
      claims = verifySessionToken(token);
      actor = await resolveActor(req);
    } catch (error) {
      if (['SESSION_INVALID', 'SESSION_EXPIRED', 'SESSION_REVOKED'].includes(error.code)) {
        return res.json({ ok: true });
      }
      throw error;
    }

    const expiresAt = claims?.exp ? new Date(Number(claims.exp) * 1000).toISOString() : null;
    const revoked = await revokeToken(sb, {
      token,
      userId: actor?.id || claims?.sub || null,
      revokedBy: actor?.id || null,
      reason: req.body.reason || 'self_logout',
      expiresAt
    });

    if (actor?.id) {
      await sb.from('audit_logs').insert({
        company_id: actor.company_id || null,
        actor_user_id: actor.id,
        action: 'auth.logout',
        entity_type: 'app_user',
        entity_id: actor.id,
        payload: {
          persistent_revocation: revoked.persistent,
          reason: req.body.reason || 'self_logout'
        }
      });
    }

    res.json({ ok: true, revoked });
  } catch (e) { next(e); }
});

router.get('/me', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ ok: true, session: actor ? publicSession(actor) : null });
  } catch (e) { next(e); }
});

module.exports = router;
