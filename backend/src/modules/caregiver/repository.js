/** DB + storage access for caregiver onboarding (care_caregiver_profiles, care-documents bucket). */
const { getSupabase } = require('../../db/supabase');
const { AppError } = require('../shared/appError');

const BUCKET = process.env.CARE_DOCUMENTS_BUCKET || 'care-documents';
const SIGNED_URL_TTL_SECONDS = 15 * 60; // spec NFR: signed URL ≤ 15 minutes

function db() {
  return getSupabase();
}

function unwrap({ data, error }) {
  if (error) {
    throw new AppError('DB_ERROR', 'เกิดข้อผิดพลาดภายในระบบ', 500, { hint: error.message });
  }
  return data;
}

async function findProfileByUserId(userId) {
  return unwrap(
    await db().from('care_caregiver_profiles').select('*').eq('user_id', userId).maybeSingle()
  );
}

async function upsertProfile(userId, row) {
  return unwrap(
    await db()
      .from('care_caregiver_profiles')
      .upsert({ ...row, user_id: userId, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .select('*')
      .single()
  );
}

async function updateProfile(userId, patch) {
  return unwrap(
    await db()
      .from('care_caregiver_profiles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .select('*')
      .maybeSingle()
  );
}

async function uploadDocument(objectPath, buffer, contentType) {
  const { error } = await db().storage.from(BUCKET).upload(objectPath, buffer, {
    contentType,
    upsert: false
  });
  if (error) {
    throw new AppError('UPLOAD_FAILED', 'อัปโหลดเอกสารไม่สำเร็จ กรุณาลองใหม่', 500, { hint: error.message });
  }
  return `storage://${BUCKET}/${objectPath}`;
}

async function signedUrlFor(fileRef) {
  const match = String(fileRef || '').match(/^storage:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const { data, error } = await db().storage.from(match[1]).createSignedUrl(match[2], SIGNED_URL_TTL_SECONDS);
  if (error) return null;
  return data?.signedUrl || null;
}

module.exports = {
  BUCKET,
  SIGNED_URL_TTL_SECONDS,
  findProfileByUserId,
  upsertProfile,
  updateProfile,
  uploadDocument,
  signedUrlFor
};
