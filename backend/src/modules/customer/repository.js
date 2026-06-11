/** DB access for customer-side elder profiles (care_elder_profiles, care_audit_logs). */
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

const LIST_COLUMNS = 'id,full_name,nickname,birth_date,gender,mobility,primary_hospital,photo_url,created_at,updated_at';

async function listEldersByOwner(ownerUserId) {
  return unwrap(
    await db()
      .from('care_elder_profiles')
      .select(LIST_COLUMNS)
      .eq('owner_user_id', ownerUserId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
  );
}

async function findElderById(id, ownerUserId) {
  return unwrap(
    await db()
      .from('care_elder_profiles')
      .select('*')
      .eq('id', id)
      .eq('owner_user_id', ownerUserId)
      .is('deleted_at', null)
      .maybeSingle()
  );
}

async function insertElder(row) {
  return unwrap(await db().from('care_elder_profiles').insert(row).select('*').single());
}

async function updateElder(id, ownerUserId, patch) {
  return unwrap(
    await db()
      .from('care_elder_profiles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('owner_user_id', ownerUserId)
      .is('deleted_at', null)
      .select('*')
      .maybeSingle()
  );
}

async function softDeleteElder(id, ownerUserId) {
  return unwrap(
    await db()
      .from('care_elder_profiles')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('owner_user_id', ownerUserId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
  );
}

/** PDPA: log every read/write of elder health data. Never include health values in payload. */
async function writeAuditLog({ actorUserId, action, entityType, entityId, payload = {} }) {
  const { error } = await db().from('care_audit_logs').insert({
    actor_user_id: actorUserId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    payload
  });
  if (error) {
    // audit failure must not break the request, but must be visible in server logs
    console.error('care_audit_logs insert failed:', error.message);
  }
}

module.exports = {
  listEldersByOwner,
  findElderById,
  insertElder,
  updateElder,
  softDeleteElder,
  writeAuditLog
};
