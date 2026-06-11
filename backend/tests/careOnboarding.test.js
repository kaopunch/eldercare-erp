const test = require('node:test');
const assert = require('node:assert/strict');

const { createOnboardingService } = require('../src/modules/caregiver/service');

function createFakeCaregiverRepository() {
  const profiles = new Map();
  const uploads = [];
  return {
    profiles,
    uploads,
    async findProfileByUserId(userId) {
      return profiles.get(userId) || null;
    },
    async upsertProfile(userId, row) {
      const existing = profiles.get(userId) || {
        user_id: userId,
        certificates: [],
        languages: ['th'],
        verification_status: 'pending',
        verification_note: null,
        verified_badge: false,
        photo_url: null,
        id_card_number_encrypted: null,
        base_rate_half_day: null,
        base_rate_full_day: null,
        service_area_lat: null,
        service_area_lng: null,
        service_radius_km: null
      };
      const merged = { ...existing, ...row };
      profiles.set(userId, merged);
      return merged;
    },
    async updateProfile(userId, patch) {
      const existing = profiles.get(userId);
      if (!existing) return null;
      Object.assign(existing, patch);
      return existing;
    },
    async uploadDocument(objectPath, buffer, contentType) {
      uploads.push({ objectPath, bytes: buffer.length, contentType });
      return `storage://care-documents/${objectPath}`;
    },
    async signedUrlFor(fileRef) {
      return `https://signed.example/${encodeURIComponent(fileRef)}?ttl=900`;
    }
  };
}

const USER = 'caregiver-user-1';

function validProfile(extra = {}) {
  return {
    full_name: 'พยาบาลดี มีใจ',
    background: 'nurse_retired',
    id_card_number: '1234567890123',
    languages: ['th', 'en'],
    service_area: { lat: 13.75, lng: 100.5, radius_km: 15 },
    base_rate_half_day_baht: 750,
    base_rate_full_day_baht: 1400,
    ...extra
  };
}

function pngUpload(type) {
  return {
    type,
    file_name: `${type}.png`,
    content_type: 'image/png',
    data_base64: Buffer.from('fake-image-bytes').toString('base64')
  };
}

test('saveProfile encrypts id card and never returns it', async () => {
  const repository = createFakeCaregiverRepository();
  const service = createOnboardingService({ repository });
  const profile = await service.saveProfile(USER, validProfile());
  assert.equal(profile.has_id_card_number, true);
  assert.equal(Object.hasOwn(profile, 'id_card_number'), false);
  assert.equal(Object.hasOwn(profile, 'id_card_number_encrypted'), false);
  const stored = repository.profiles.get(USER).id_card_number_encrypted;
  assert.ok(stored);
  assert.equal(stored.includes('1234567890123'), false);
});

test('rates are converted from baht to int satang', async () => {
  const repository = createFakeCaregiverRepository();
  const service = createOnboardingService({ repository });
  const profile = await service.saveProfile(USER, validProfile());
  assert.equal(profile.base_rate_half_day_satang, 75000);
  assert.equal(profile.base_rate_full_day_satang, 140000);
  assert.equal(Number.isInteger(repository.profiles.get(USER).base_rate_half_day), true);
});

test('invalid id card and service radius are rejected', async () => {
  const service = createOnboardingService({ repository: createFakeCaregiverRepository() });
  await assert.rejects(
    service.saveProfile(USER, validProfile({ id_card_number: '12345' })),
    (err) => err.code === 'ID_CARD_INVALID'
  );
  await assert.rejects(
    service.saveProfile(USER, validProfile({ service_area: { lat: 13.7, lng: 100.5, radius_km: 0 } })),
    (err) => err.code === 'RADIUS_INVALID'
  );
});

test('document upload requires the profile step first', async () => {
  const service = createOnboardingService({ repository: createFakeCaregiverRepository() });
  await assert.rejects(service.uploadDocument(USER, pngUpload('id_card')), (err) => err.code === 'PROFILE_REQUIRED');
});

test('uploading required documents moves status to documents_submitted', async () => {
  const repository = createFakeCaregiverRepository();
  const service = createOnboardingService({ repository });
  await service.saveProfile(USER, validProfile());

  const first = await service.uploadDocument(USER, pngUpload('id_card'));
  assert.equal(first.verification_status, 'pending', 'photo still missing');
  assert.match(first.preview_url, /^https:\/\/signed\.example\//);

  const second = await service.uploadDocument(USER, pngUpload('photo'));
  assert.equal(second.verification_status, 'documents_submitted');

  const status = await service.getStatus(USER);
  assert.equal(status.verification_status, 'documents_submitted');
  assert.deepEqual(status.checklist.documents, { id_card: true, photo: true, certificate: false });
  assert.equal(status.checklist.profile_complete, true);
  assert.equal(status.checklist.rates, true);
});

test('uploads are stored under the caregiver folder in the private bucket', async () => {
  const repository = createFakeCaregiverRepository();
  const service = createOnboardingService({ repository });
  await service.saveProfile(USER, validProfile());
  await service.uploadDocument(USER, pngUpload('certificate'));
  assert.match(repository.uploads[0].objectPath, new RegExp(`^caregiver/${USER}/certificate-`));
});

test('oversized or wrong-format files are rejected', async () => {
  const repository = createFakeCaregiverRepository();
  const service = createOnboardingService({ repository });
  await service.saveProfile(USER, validProfile());
  await assert.rejects(
    service.uploadDocument(USER, { ...pngUpload('id_card'), content_type: 'application/zip' }),
    (err) => err.code === 'DOCUMENT_FORMAT_INVALID'
  );
  await assert.rejects(
    service.uploadDocument(USER, {
      ...pngUpload('id_card'),
      data_base64: Buffer.alloc(7 * 1024 * 1024).toString('base64')
    }),
    (err) => err.code === 'DOCUMENT_SIZE_INVALID'
  );
});

test('getStatus before any profile returns an all-false checklist', async () => {
  const service = createOnboardingService({ repository: createFakeCaregiverRepository() });
  const status = await service.getStatus(USER);
  assert.equal(status.verification_status, 'pending');
  assert.equal(status.checklist.profile_complete, false);
  assert.deepEqual(status.checklist.documents, { id_card: false, photo: false, certificate: false });
});
