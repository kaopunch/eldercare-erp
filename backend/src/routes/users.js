const express = require('express');
const { z } = require('zod');
const { getSupabase } = require('../db/supabase');
const { INTERNAL_ROLES } = require('../middleware/auth');
const { hashPin } = require('../lib/session');
const { listSessionRevocations, revokeUserSessions } = require('../lib/revocations');

const router = express.Router();

const ROLE_VALUES = Array.from(INTERNAL_ROLES);
const STATUS_VALUES = ['active', 'inactive', 'suspended'];

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function emptyToUndefined(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

const NullableUuid = z.preprocess(emptyToNull, z.string().uuid().nullable());
const NullableText = z.preprocess(emptyToNull, z.string().nullable());
const NullableEmail = z.preprocess(emptyToNull, z.string().email().nullable());
const PinSchema = z.preprocess(emptyToUndefined, z.string().regex(/^\d{4,12}$/, 'PIN must be 4-12 digits').optional());

const UserCreateSchema = z.object({
  company_id: NullableUuid.optional(),
  branch_id: NullableUuid.optional(),
  full_name: z.string().trim().min(2),
  phone: NullableText.optional(),
  email: NullableEmail.optional(),
  role: z.enum(ROLE_VALUES),
  status: z.enum(STATUS_VALUES).default('active'),
  pin: PinSchema,
  must_rotate_pin: z.boolean().optional().default(true)
});

const UserUpdateSchema = z.object({
  company_id: NullableUuid.optional(),
  branch_id: NullableUuid.optional(),
  full_name: z.string().trim().min(2).optional(),
  phone: NullableText.optional(),
  email: NullableEmail.optional(),
  role: z.enum(ROLE_VALUES).optional(),
  status: z.enum(STATUS_VALUES).optional()
}).refine((value) => Object.keys(value).length > 0, 'at least one field is required');

const PinUpdateSchema = z.object({
  pin: z.string().regex(/^\d{4,12}$/, 'PIN must be 4-12 digits'),
  must_rotate_pin: z.boolean().optional().default(true)
});

const SessionRevokeSchema = z.object({
  reason: z.string().trim().max(200).optional().default('admin_manual_revoke')
});

const SECURITY_AUDIT_ACTIONS = [
  'auth.login',
  'auth.logout',
  'auth.pin_changed',
  'auth.sessions_revoked',
  'user.created',
  'user.updated',
  'user.pin_reset',
  'user.unlocked'
];

function publicUser(user, credential = null) {
  const lockedUntilMs = credential?.locked_until ? new Date(credential.locked_until).getTime() : 0;
  return {
    id: user.id,
    company_id: user.company_id || null,
    branch_id: user.branch_id || null,
    company_name: user.companies?.name || null,
    branch_name: user.branches?.name || null,
    full_name: user.full_name,
    phone: user.phone || null,
    email: user.email || null,
    role: user.role,
    status: user.status || 'active',
    created_at: user.created_at || null,
    pin_configured: Boolean(credential),
    login_enabled: Boolean(credential) && user.status === 'active',
    must_rotate_pin: Boolean(credential?.must_rotate_pin),
    failed_attempts: Number(credential?.failed_attempts || 0),
    locked_until: credential?.locked_until || null,
    locked: Boolean(lockedUntilMs && lockedUntilMs > Date.now()),
    pin_updated_at: credential?.pin_updated_at || null,
    last_login_at: credential?.last_login_at || null
  };
}

function credentialMap(rows = []) {
  return new Map(rows.map((row) => [row.user_id, row]));
}

async function listUsers(sb) {
  const { data: users, error: userError } = await sb.from('app_users')
    .select('id,company_id,branch_id,full_name,phone,email,role,status,created_at,companies(name),branches(name)')
    .order('role', { ascending: true })
    .order('full_name', { ascending: true });
  if (userError) throw userError;

  const userIds = (users || []).map((user) => user.id);
  let credentials = new Map();
  if (userIds.length) {
    const { data, error } = await sb.from('app_user_credentials')
      .select('user_id,must_rotate_pin,failed_attempts,locked_until,pin_updated_at,last_login_at')
      .in('user_id', userIds);
    if (error) throw error;
    credentials = credentialMap(data || []);
  }

  return (users || []).map((user) => publicUser(user, credentials.get(user.id)));
}

async function findPublicUser(sb, userId) {
  const { data: user, error: userError } = await sb.from('app_users')
    .select('id,company_id,branch_id,full_name,phone,email,role,status,created_at,companies(name),branches(name)')
    .eq('id', userId)
    .single();
  if (userError) throw userError;

  const { data: credential, error: credentialError } = await sb.from('app_user_credentials')
    .select('user_id,must_rotate_pin,failed_attempts,locked_until,pin_updated_at,last_login_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (credentialError) throw credentialError;

  return publicUser(user, credential || null);
}

async function auditUserAction(sb, req, action, user, payload = {}) {
  await sb.from('audit_logs').insert({
    company_id: user.company_id || req.actor?.company_id || null,
    actor_user_id: req.actor?.id || null,
    action,
    entity_type: 'app_user',
    entity_id: user.id,
    payload: {
      target_email: user.email || null,
      target_role: user.role,
      ...payload
    }
  });
}

function normalizeSupabaseError(error) {
  if (error?.code === '23505') {
    error.statusCode = 409;
    error.code = 'USER_DUPLICATE';
    error.message = 'email already exists';
  }
  return error;
}

function parseLimit(value, fallback = 80) {
  const limit = Number(value || fallback);
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.round(limit), 1), 200);
}

async function listSecurityAuditLogs(sb, limit) {
  const { data, error } = await sb.from('audit_logs')
    .select('*')
    .in('action', SECURITY_AUDIT_ACTIONS)
    .order('created_at', { ascending: false })
    .limit(parseLimit(limit));
  if (error) throw error;

  const actorIds = [...new Set((data || []).map((row) => row.actor_user_id).filter(Boolean))];
  const targetIds = [...new Set((data || []).map((row) => row.entity_type === 'app_user' ? row.entity_id : null).filter(Boolean))];
  const userIds = [...new Set([...actorIds, ...targetIds])];
  const users = userIds.length
    ? await sb.from('app_users').select('id,full_name,email,role,status').in('id', userIds)
    : { data: [], error: null };
  if (users.error) throw users.error;

  const usersById = (users.data || []).reduce((map, user) => {
    map[user.id] = user;
    return map;
  }, {});

  return (data || []).map((row) => ({
    ...row,
    actor: usersById[row.actor_user_id] || null,
    target_user: row.entity_type === 'app_user' ? usersById[row.entity_id] || null : null
  }));
}

router.get('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const users = await listUsers(sb);
    res.json({ ok: true, users, roles: ROLE_VALUES, statuses: STATUS_VALUES });
  } catch (e) { next(e); }
});

router.get('/security', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const users = await listUsers(sb);
    const [auditLogs, revocations] = await Promise.all([
      listSecurityAuditLogs(sb, req.query.limit),
      listSessionRevocations(sb, parseLimit(req.query.limit, 50))
    ]);

    const summary = users.reduce((memo, user) => {
      memo.total_users += 1;
      if (user.status === 'active') memo.active_users += 1;
      if (user.pin_configured) memo.pin_configured += 1;
      if (user.must_rotate_pin) memo.rotation_required += 1;
      if (user.locked) memo.locked_users += 1;
      memo.failed_attempts += Number(user.failed_attempts || 0);
      return memo;
    }, {
      total_users: 0,
      active_users: 0,
      pin_configured: 0,
      rotation_required: 0,
      locked_users: 0,
      failed_attempts: 0,
      audit_events: auditLogs.length,
      persistent_session_revocation: revocations.persistent
    });

    res.json({
      ok: true,
      summary,
      users,
      audit_logs: auditLogs,
      session_revocations: revocations
    });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = UserCreateSchema.parse(req.body);
    const sb = getSupabase();
    const { pin, must_rotate_pin, ...userInput } = input;
    const { data: user, error } = await sb.from('app_users')
      .insert(userInput)
      .select('id,company_id,branch_id,full_name,phone,email,role,status,created_at,companies(name),branches(name)')
      .single();
    if (error) throw normalizeSupabaseError(error);

    if (pin) {
      const { error: pinError } = await sb.from('app_user_credentials').upsert({
        user_id: user.id,
        login_pin_hash: hashPin(pin),
        must_rotate_pin,
        failed_attempts: 0,
        locked_until: null,
        pin_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      if (pinError) throw pinError;
    }

    await auditUserAction(sb, req, 'user.created', user, { pin_configured: Boolean(pin), must_rotate_pin: Boolean(pin && must_rotate_pin), status: user.status });
    const publicRecord = await findPublicUser(sb, user.id);
    res.status(201).json({ ok: true, user: publicRecord });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const input = UserUpdateSchema.parse(req.body);
    const sb = getSupabase();
    const before = await findPublicUser(sb, req.params.id);
    const { data: user, error } = await sb.from('app_users')
      .update(input)
      .eq('id', req.params.id)
      .select('id,company_id,branch_id,full_name,phone,email,role,status,created_at,companies(name),branches(name)')
      .single();
    if (error) throw normalizeSupabaseError(error);

    await auditUserAction(sb, req, 'user.updated', user, {
      before: {
        role: before.role,
        status: before.status,
        email: before.email
      },
      changed_fields: Object.keys(input)
    });
    const publicRecord = await findPublicUser(sb, user.id);
    res.json({ ok: true, user: publicRecord });
  } catch (e) { next(e); }
});

router.post('/:id/pin', async (req, res, next) => {
  try {
    const input = PinUpdateSchema.parse(req.body);
    const sb = getSupabase();
    const user = await findPublicUser(sb, req.params.id);
    const { error } = await sb.from('app_user_credentials').upsert({
      user_id: user.id,
      login_pin_hash: hashPin(input.pin),
      must_rotate_pin: input.must_rotate_pin,
      failed_attempts: 0,
      locked_until: null,
      pin_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;

    await auditUserAction(sb, req, 'user.pin_reset', user, { must_rotate_pin: input.must_rotate_pin });
    const publicRecord = await findPublicUser(sb, user.id);
    res.json({ ok: true, user: publicRecord });
  } catch (e) { next(e); }
});

router.post('/:id/unlock', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const user = await findPublicUser(sb, req.params.id);
    const { error } = await sb.from('app_user_credentials')
      .update({
        failed_attempts: 0,
        locked_until: null,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', user.id);
    if (error) throw error;

    await auditUserAction(sb, req, 'user.unlocked', user);
    const publicRecord = await findPublicUser(sb, user.id);
    res.json({ ok: true, user: publicRecord });
  } catch (e) { next(e); }
});

router.post('/:id/revoke-sessions', async (req, res, next) => {
  try {
    const input = SessionRevokeSchema.parse(req.body || {});
    const sb = getSupabase();
    const user = await findPublicUser(sb, req.params.id);
    const sessionRevocation = await revokeUserSessions(sb, {
      userId: user.id,
      revokedBy: req.actor?.id || null,
      reason: input.reason
    });

    await auditUserAction(sb, req, 'auth.sessions_revoked', user, {
      reason: input.reason,
      revoked_after: sessionRevocation.revoked_after,
      persistent_revocation: sessionRevocation.persistent
    });
    res.json({ ok: true, user, session_revocation: sessionRevocation });
  } catch (e) { next(e); }
});

module.exports = router;
