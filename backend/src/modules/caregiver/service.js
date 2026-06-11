/**
 * Caregiver onboarding business logic (spec G1, 4-step wizard).
 * - id card number is AES-encrypted at rest, never logged, never returned by any API
 * - documents go to the private care-documents bucket; clients only ever get
 *   signed URLs valid ≤ 15 minutes
 * - verification_status: pending -> documents_submitted -> verified/rejected
 *   (verified/rejected is an admin action, out of scope this milestone)
 */
const path = require('path');
const defaultRepository = require('./repository');
const { AppError } = require('../shared/appError');
const { encryptSensitive } = require('../shared/crypto');

const DOCUMENT_TYPES = ['id_card', 'certificate', 'photo'];
const REQUIRED_DOCUMENT_TYPES = ['id_card', 'photo'];
const MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const BACKGROUNDS = ['nurse_retired', 'nurse_assistant', 'health_student', 'trained_general'];

function bahtToSatang(value) {
  // API accepts baht from the form; storage is int satang per spec
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100000) {
    throw new AppError('RATE_INVALID', 'อัตราค่าบริการไม่ถูกต้อง', 422);
  }
  return Math.round(num * 100);
}

function safeFileName(fileName) {
  const parsed = path.parse(String(fileName || 'document'));
  const base = parsed.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
  const ext = parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
  return `${base}${ext || '.bin'}`;
}

function publicProfile(row) {
  if (!row) return null;
  return {
    full_name: row.full_name,
    birth_date: row.birth_date || null,
    gender: row.gender || null,
    has_photo: Boolean(row.photo_url), // raw storage ref stays internal; use photo_signed_url from /onboard/status
    has_id_card_number: Boolean(row.id_card_number_encrypted), // boolean only — never the value
    background: row.background || null,
    certificates: (row.certificates || []).map((cert) => ({
      type: cert.type,
      uploaded_at: cert.uploaded_at,
      verified_at: cert.verified_at || null
    })),
    languages: row.languages || ['th'],
    service_area: row.service_area_lat === null || row.service_area_lat === undefined
      ? null
      : {
          lat: Number(row.service_area_lat),
          lng: Number(row.service_area_lng),
          radius_km: row.service_radius_km === null ? null : Number(row.service_radius_km)
        },
    base_rate_half_day_satang: row.base_rate_half_day ?? null,
    base_rate_full_day_satang: row.base_rate_full_day ?? null,
    verification_status: row.verification_status,
    verification_note: row.verification_note || null,
    verified_badge: row.verified_badge
  };
}

function createOnboardingService({ repository = defaultRepository } = {}) {
  /** Steps 1+3 of the wizard: personal info, service area, rates, languages. */
  async function saveProfile(userId, input) {
    if (!String(input.full_name || '').trim()) {
      throw new AppError('NAME_REQUIRED', 'กรุณากรอกชื่อ-นามสกุล', 422);
    }
    if (input.background && !BACKGROUNDS.includes(input.background)) {
      throw new AppError('BACKGROUND_INVALID', 'ประเภทพื้นฐานวิชาชีพไม่ถูกต้อง', 422);
    }
    const row = {
      full_name: String(input.full_name).trim(),
      birth_date: input.birth_date || null,
      gender: input.gender || null,
      background: input.background || null,
      languages: input.languages && input.languages.length ? input.languages : ['th']
    };
    if (input.id_card_number !== undefined && input.id_card_number !== null) {
      const idCard = String(input.id_card_number).replace(/\D/g, '');
      if (!/^\d{13}$/.test(idCard)) {
        throw new AppError('ID_CARD_INVALID', 'เลขบัตรประชาชนต้องมี 13 หลัก', 422);
      }
      row.id_card_number_encrypted = encryptSensitive(idCard);
    }
    if (input.service_area) {
      const { lat, lng, radius_km: radiusKm } = input.service_area;
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
        throw new AppError('LOCATION_INVALID', 'พิกัดพื้นที่ให้บริการไม่ถูกต้อง', 422);
      }
      const radius = Number(radiusKm);
      if (!Number.isFinite(radius) || radius <= 0 || radius > 100) {
        throw new AppError('RADIUS_INVALID', 'รัศมีพื้นที่ให้บริการต้องอยู่ระหว่าง 1-100 กม.', 422);
      }
      row.service_area_center = `SRID=4326;POINT(${Number(lng)} ${Number(lat)})`;
      row.service_area_lat = Number(lat);
      row.service_area_lng = Number(lng);
      row.service_radius_km = radius;
    }
    if (input.base_rate_half_day_baht !== undefined) {
      row.base_rate_half_day = bahtToSatang(input.base_rate_half_day_baht);
    }
    if (input.base_rate_full_day_baht !== undefined) {
      row.base_rate_full_day = bahtToSatang(input.base_rate_full_day_baht);
    }
    const saved = await repository.upsertProfile(userId, row);
    return publicProfile(saved);
  }

  /** Step 2: document upload (base64 JSON body — same pattern as ERP payment evidence). */
  async function uploadDocument(userId, input) {
    if (!DOCUMENT_TYPES.includes(input.type)) {
      throw new AppError('DOCUMENT_TYPE_INVALID', 'ประเภทเอกสารไม่ถูกต้อง', 422);
    }
    const contentType = String(input.content_type || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new AppError('DOCUMENT_FORMAT_INVALID', 'รองรับเฉพาะไฟล์ PDF, JPEG, PNG หรือ WebP', 422);
    }
    const buffer = Buffer.from(String(input.data_base64 || ''), 'base64');
    if (!buffer.length || buffer.length > MAX_DOCUMENT_BYTES) {
      throw new AppError('DOCUMENT_SIZE_INVALID', 'ไฟล์ว่างหรือใหญ่เกิน 6 MB', 422);
    }
    const profile = await repository.findProfileByUserId(userId);
    if (!profile) {
      throw new AppError('PROFILE_REQUIRED', 'กรุณากรอกข้อมูลส่วนตัว (ขั้นตอนที่ 1) ก่อนอัปโหลดเอกสาร', 409);
    }
    const objectPath = `caregiver/${userId}/${input.type}-${Date.now()}-${safeFileName(input.file_name)}`;
    const fileRef = await repository.uploadDocument(objectPath, buffer, contentType);

    const certificates = [...(profile.certificates || [])];
    certificates.push({ type: input.type, file_ref: fileRef, uploaded_at: new Date().toISOString() });

    const patch = { certificates };
    if (input.type === 'photo') {
      patch.photo_url = fileRef; // resolved to a signed URL on read
    }
    const uploadedTypes = new Set(certificates.map((cert) => cert.type));
    if (
      profile.verification_status === 'pending' &&
      REQUIRED_DOCUMENT_TYPES.every((type) => uploadedTypes.has(type))
    ) {
      patch.verification_status = 'documents_submitted';
    }
    const saved = await repository.updateProfile(userId, patch);
    const previewUrl = await repository.signedUrlFor(fileRef);
    return {
      type: input.type,
      uploaded_at: new Date().toISOString(),
      preview_url: previewUrl, // expires ≤ 15 min
      verification_status: saved.verification_status
    };
  }

  /** Step 4: pending page checklist. */
  async function getStatus(userId) {
    const profile = await repository.findProfileByUserId(userId);
    if (!profile) {
      return {
        verification_status: 'pending',
        verification_note: null,
        checklist: {
          profile_complete: false,
          id_card_number: false,
          service_area: false,
          rates: false,
          documents: { id_card: false, photo: false, certificate: false }
        }
      };
    }
    const uploadedTypes = new Set((profile.certificates || []).map((cert) => cert.type));
    let photoUrl = null;
    if (profile.photo_url) {
      photoUrl = await repository.signedUrlFor(profile.photo_url);
    }
    return {
      verification_status: profile.verification_status,
      verification_note: profile.verification_note || null,
      profile: publicProfile(profile),
      photo_signed_url: photoUrl,
      checklist: {
        profile_complete: Boolean(profile.full_name && profile.background),
        id_card_number: Boolean(profile.id_card_number_encrypted),
        service_area: profile.service_area_lat !== null && profile.service_area_lat !== undefined,
        rates: profile.base_rate_half_day !== null && profile.base_rate_full_day !== null,
        documents: {
          id_card: uploadedTypes.has('id_card'),
          photo: uploadedTypes.has('photo'),
          certificate: uploadedTypes.has('certificate')
        }
      }
    };
  }

  return { saveProfile, uploadDocument, getStatus };
}

module.exports = { createOnboardingService };
