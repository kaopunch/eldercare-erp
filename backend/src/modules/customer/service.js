/**
 * Elder profile business logic (spec C2). PDPA rules:
 * - consent (version + timestamp) is required at creation
 * - every read/write of a full profile is written to care_audit_logs
 * - geography points are stored as WKT POINT(lng lat), returned as {lat, lng}
 */
const defaultRepository = require('./repository');
const { AppError } = require('../shared/appError');

const CONSENT_VERSION = '2026-06-11.1'; // bump when the consent text changes

const MOBILITY_VALUES = ['walk', 'cane', 'walker', 'wheelchair', 'bedridden'];

function toWktPoint(location) {
  if (!location) return null;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new AppError('LOCATION_INVALID', 'พิกัดบ้านไม่ถูกต้อง', 422);
  }
  return `SRID=4326;POINT(${lng} ${lat})`;
}

/** Coordinates are read from the denormalized home_lat/home_lng columns (009). */
function locationFromRow(row) {
  if (row.home_lat === null || row.home_lat === undefined) return null;
  return { lat: Number(row.home_lat), lng: Number(row.home_lng) };
}

function publicElder(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    nickname: row.nickname || null,
    birth_date: row.birth_date || null,
    gender: row.gender || null,
    blood_type: row.blood_type || null,
    weight_kg: row.weight_kg === null ? null : Number(row.weight_kg),
    height_cm: row.height_cm === null ? null : Number(row.height_cm),
    chronic_conditions: row.chronic_conditions || [],
    medications: row.medications || [],
    allergies: row.allergies || [],
    mobility: row.mobility || null,
    primary_hospital: row.primary_hospital || null,
    home_address: row.home_address || null,
    home_location: locationFromRow(row),
    special_notes: row.special_notes || null,
    photo_url: row.photo_url || null,
    consent_version: row.consent_version,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function validateMobility(mobility) {
  if (mobility !== undefined && mobility !== null && !MOBILITY_VALUES.includes(mobility)) {
    throw new AppError('MOBILITY_INVALID', 'ระดับการเคลื่อนไหวไม่ถูกต้อง', 422);
  }
}

function createElderService({ repository = defaultRepository } = {}) {
  async function listElders(ownerUserId) {
    const rows = await repository.listEldersByOwner(ownerUserId);
    return rows.map((row) => ({
      id: row.id,
      full_name: row.full_name,
      nickname: row.nickname || null,
      birth_date: row.birth_date || null,
      gender: row.gender || null,
      mobility: row.mobility || null,
      primary_hospital: row.primary_hospital || null,
      photo_url: row.photo_url || null
    }));
  }

  async function getElder(ownerUserId, elderId) {
    const row = await repository.findElderById(elderId, ownerUserId);
    if (!row) {
      throw new AppError('ELDER_NOT_FOUND', 'ไม่พบโปรไฟล์ผู้สูงวัย', 404);
    }
    await repository.writeAuditLog({
      actorUserId: ownerUserId,
      action: 'elder_profile.read',
      entityType: 'care_elder_profile',
      entityId: elderId
    });
    return publicElder(row);
  }

  async function createElder(ownerUserId, input) {
    if (input.consent_accepted !== true) {
      throw new AppError('CONSENT_REQUIRED', 'กรุณายอมรับข้อตกลงการเก็บข้อมูลสุขภาพ (PDPA) ก่อนบันทึก', 422);
    }
    if (!String(input.full_name || '').trim()) {
      throw new AppError('NAME_REQUIRED', 'กรุณากรอกชื่อผู้สูงวัย', 422);
    }
    if (input.mobility === 'bedridden') {
      // spec: bedridden is outside service scope — store but flag at booking time (M2)
      // still allowed as a profile
    }
    validateMobility(input.mobility);
    const row = await repository.insertElder({
      owner_user_id: ownerUserId,
      full_name: String(input.full_name).trim(),
      nickname: input.nickname || null,
      birth_date: input.birth_date || null,
      gender: input.gender || null,
      blood_type: input.blood_type || null,
      weight_kg: input.weight_kg ?? null,
      height_cm: input.height_cm ?? null,
      chronic_conditions: input.chronic_conditions || [],
      medications: input.medications || [],
      allergies: input.allergies || [],
      mobility: input.mobility || null,
      primary_hospital: input.primary_hospital || null,
      home_address: input.home_address || null,
      home_location: toWktPoint(input.home_location),
      home_lat: input.home_location ? Number(input.home_location.lat) : null,
      home_lng: input.home_location ? Number(input.home_location.lng) : null,
      special_notes: input.special_notes || null,
      photo_url: input.photo_url || null,
      consent_version: CONSENT_VERSION,
      consent_accepted_at: new Date().toISOString()
    });
    await repository.writeAuditLog({
      actorUserId: ownerUserId,
      action: 'elder_profile.create',
      entityType: 'care_elder_profile',
      entityId: row.id,
      payload: { consent_version: CONSENT_VERSION }
    });
    return publicElder(row);
  }

  async function updateElder(ownerUserId, elderId, input) {
    validateMobility(input.mobility);
    const patch = {};
    const passthrough = [
      'full_name', 'nickname', 'birth_date', 'gender', 'blood_type', 'weight_kg', 'height_cm',
      'chronic_conditions', 'medications', 'allergies', 'mobility', 'primary_hospital',
      'home_address', 'special_notes', 'photo_url'
    ];
    for (const key of passthrough) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.home_location !== undefined) {
      patch.home_location = toWktPoint(input.home_location);
      patch.home_lat = input.home_location ? Number(input.home_location.lat) : null;
      patch.home_lng = input.home_location ? Number(input.home_location.lng) : null;
    }
    if (!Object.keys(patch).length) {
      throw new AppError('NOTHING_TO_UPDATE', 'ไม่มีข้อมูลที่ต้องแก้ไข', 422);
    }
    const row = await repository.updateElder(elderId, ownerUserId, patch);
    if (!row) {
      throw new AppError('ELDER_NOT_FOUND', 'ไม่พบโปรไฟล์ผู้สูงวัย', 404);
    }
    await repository.writeAuditLog({
      actorUserId: ownerUserId,
      action: 'elder_profile.update',
      entityType: 'care_elder_profile',
      entityId: elderId,
      payload: { fields: Object.keys(patch) } // field names only — never values
    });
    return publicElder(row);
  }

  async function deleteElder(ownerUserId, elderId) {
    const row = await repository.softDeleteElder(elderId, ownerUserId);
    if (!row) {
      throw new AppError('ELDER_NOT_FOUND', 'ไม่พบโปรไฟล์ผู้สูงวัย', 404);
    }
    await repository.writeAuditLog({
      actorUserId: ownerUserId,
      action: 'elder_profile.delete',
      entityType: 'care_elder_profile',
      entityId: elderId
    });
    return { ok: true };
  }

  return { listElders, getElder, createElder, updateElder, deleteElder, CONSENT_VERSION };
}

module.exports = { createElderService, CONSENT_VERSION };
