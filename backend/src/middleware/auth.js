const { getSupabase } = require('../db/supabase');
const {
  bearerToken,
  demoAuthAllowed,
  verifySessionToken
} = require('../lib/session');
const { isTokenRevoked } = require('../lib/revocations');

const INTERNAL_ROLES = new Set([
  'owner',
  'super_admin',
  'admin',
  'branch_admin',
  'dispatcher',
  'coordinator',
  'driver',
  'care_assistant',
  'hospital_companion',
  'home_companion',
  'trainer',
  'finance',
  'family_viewer'
]);

function normalizeRole(role) {
  const value = String(role || '').trim();
  return INTERNAL_ROLES.has(value) ? value : null;
}

function hasRole(actor, allowedRoles = []) {
  if (!actor?.role) return false;
  if (allowedRoles.includes('*')) return true;
  if (['owner', 'super_admin', 'admin'].includes(actor.role)) return true;
  return allowedRoles.includes(actor.role);
}

async function findUser(sb, userId) {
  const { data, error } = await sb.from('app_users')
    .select('id,company_id,branch_id,full_name,phone,email,role,status')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

async function credentialState(sb, userId) {
  if (!userId) return null;
  const { data, error } = await sb.from('app_user_credentials')
    .select('must_rotate_pin')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function resolveActor(req) {
  const sb = getSupabase();
  const token = bearerToken(req);

  if (token) {
    const claims = verifySessionToken(token);
    if (await isTokenRevoked(sb, token, claims)) {
      const error = new Error('session has been revoked');
      error.statusCode = 401;
      error.code = 'SESSION_REVOKED';
      throw error;
    }
    const user = await findUser(sb, claims.sub);
    const credential = await credentialState(sb, user.id);
    if (user.status !== 'active') {
      const error = new Error('user account is not active');
      error.statusCode = 403;
      error.code = 'USER_INACTIVE';
      throw error;
    }
    if (claims.role !== user.role) {
      const error = new Error('session role does not match current user role');
      error.statusCode = 403;
      error.code = 'ROLE_MISMATCH';
      throw error;
    }
    return {
      ...user,
      must_rotate_pin: Boolean(credential?.must_rotate_pin || claims.must_rotate_pin)
    };
  }

  const userId = req.get('x-eldercare-user-id') || req.query.user_id || null;
  const role = normalizeRole(req.get('x-eldercare-role') || req.query.role);

  if (demoAuthAllowed()) {
    if (userId) {
      const user = await findUser(sb, userId);
      if (user.status !== 'active') {
        const error = new Error('user account is not active');
        error.statusCode = 403;
        error.code = 'USER_INACTIVE';
        throw error;
      }
      if (role && role !== user.role) {
        const error = new Error('session role does not match selected user');
        error.statusCode = 403;
        error.code = 'ROLE_MISMATCH';
        throw error;
      }
      return user;
    }

    if (role) {
      return {
        id: null,
        full_name: `${role} demo session`,
        role,
        status: 'active',
        company_id: null,
        branch_id: null,
        demo: true
      };
    }
  }

  return null;
}

async function attachActor(req, res, next) {
  try {
    const actor = await resolveActor(req);
    if (actor) {
      if (actor.must_rotate_pin && actor.id) {
        const error = new Error('PIN change is required before continuing');
        error.statusCode = 428;
        error.code = 'PIN_ROTATION_REQUIRED';
        error.details = { user_id: actor.id };
        throw error;
      }
      req.actor = actor;
      return next();
    }

    const error = new Error('login session is required');
    error.statusCode = 401;
    error.code = 'AUTH_REQUIRED';
    throw error;
  } catch (error) {
    next(error);
  }
}

function requireRoles(allowedRoles = []) {
  return (req, res, next) => {
    if (!hasRole(req.actor, allowedRoles)) {
      const error = new Error('current role is not allowed for this action');
      error.statusCode = 403;
      error.code = 'ROLE_FORBIDDEN';
      error.details = {
        role: req.actor?.role || null,
        allowed_roles: allowedRoles
      };
      return next(error);
    }
    return next();
  };
}

module.exports = {
  INTERNAL_ROLES,
  attachActor,
  credentialState,
  findUser,
  hasRole,
  normalizeRole,
  resolveActor,
  requireRoles
};
