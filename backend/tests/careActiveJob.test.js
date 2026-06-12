const test = require('node:test');
const assert = require('node:assert/strict');

const { createActiveJobService } = require('../src/modules/caregiver/activeJobService');

const CAREGIVER = 'caregiver-1';
const PICKUP = { lat: 13.7563, lng: 100.5018 };
const NEAR_PICKUP = { lat: 13.7565, lng: 100.5019 }; // ~25m
const FAR_FROM_PICKUP = { lat: 13.77, lng: 100.52 }; // ~2.5km
const DESTINATION = { lat: 13.758, lng: 100.486 };

function createFakeJobRepository(initialStatus = 'confirmed') {
  const booking = {
    id: 'bk-1',
    status: initialStatus,
    caregiver_user_id: CAREGIVER,
    elder_profile_id: 'elder-1',
    customer_user_id: 'cust-1',
    pickup_lat: PICKUP.lat,
    pickup_lng: PICKUP.lng,
    destination_lat: DESTINATION.lat,
    destination_lng: DESTINATION.lng,
    checkout_at: null
  };
  const events = [];
  const pings = [];
  const healthRecords = [];
  return {
    booking,
    events,
    pings,
    healthRecords,
    async findBookingById(id) {
      return id === booking.id ? { ...booking } : null;
    },
    async updateBookingStatus(id, fromStatus, patch) {
      if (booking.id !== id || booking.status !== fromStatus) return null;
      Object.assign(booking, patch);
      return { ...booking };
    },
    async insertBookingEvent(event) {
      events.push(event);
      return { id: `ev${events.length}` };
    },
    async insertLocationPing(row) {
      pings.push(row);
      return { id: `p${pings.length}`, lat: row.lat, lng: row.lng, recorded_at: new Date().toISOString() };
    },
    async upsertHealthRecord(row) {
      healthRecords.push(row);
      return { ...row, id: `hr${healthRecords.length}` };
    }
  };
}

const fakeStorage = {
  uploads: [],
  async uploadDocument(objectPath, buffer, contentType) {
    fakeStorage.uploads.push({ objectPath, bytes: buffer.length, contentType });
    return `storage://care-documents/${objectPath}`;
  }
};

const PHOTO = { content_type: 'image/jpeg', data_base64: Buffer.from('photo-bytes').toString('base64') };

function buildService(initialStatus, broadcasts = []) {
  const repository = createFakeJobRepository(initialStatus);
  const service = createActiveJobService({
    repository,
    storageRepository: fakeStorage,
    publishFn: (bookingId, payload) => broadcasts.push({ bookingId, ...payload })
  });
  return { repository, service };
}

test('checkin requires photo and GPS within 300m, then moves to in_progress_pickup', async () => {
  const broadcasts = [];
  const { repository, service } = buildService('confirmed', broadcasts);

  await assert.rejects(
    service.checkin(CAREGIVER, 'bk-1', { photo: PHOTO, location: FAR_FROM_PICKUP }),
    (err) => err.code === 'CHECKIN_TOO_FAR' && err.details.distance_m > 300
  );
  await assert.rejects(
    service.checkin(CAREGIVER, 'bk-1', { photo: {}, location: NEAR_PICKUP }),
    (err) => err.code === 'PHOTO_REQUIRED'
  );

  const result = await service.checkin(CAREGIVER, 'bk-1', { photo: PHOTO, location: NEAR_PICKUP });
  assert.equal(result.status, 'in_progress_pickup');
  assert.equal(repository.events[0].eventType, 'checkin_home');
  assert.match(repository.events[0].payload.photo_ref, /^storage:\/\/care-documents\/bookings\/bk-1\/checkin-/);
  assert.ok(broadcasts.some((message) => message.type === 'status' && message.status === 'in_progress_pickup'));

  // idempotent repeat
  const again = await service.checkin(CAREGIVER, 'bk-1', { photo: PHOTO, location: NEAR_PICKUP });
  assert.equal(again.status, 'in_progress_pickup');
  assert.equal(repository.events.length, 1);
});

test('full step sequence walks to pending_confirmation with checkout 300m rule', async () => {
  const { repository, service } = buildService('confirmed');
  await service.checkin(CAREGIVER, 'bk-1', { photo: PHOTO, location: NEAR_PICKUP });
  await service.arrive(CAREGIVER, 'bk-1', { location: DESTINATION });
  await service.departing(CAREGIVER, 'bk-1', {});
  await assert.rejects(
    service.checkout(CAREGIVER, 'bk-1', { location: FAR_FROM_PICKUP }),
    (err) => err.code === 'CHECKOUT_TOO_FAR'
  );
  const done = await service.checkout(CAREGIVER, 'bk-1', { location: NEAR_PICKUP });
  assert.equal(done.status, 'pending_confirmation');
  assert.ok(repository.booking.checkout_at);
  assert.deepEqual(
    repository.events.map((event) => event.eventType),
    ['checkin_home', 'arrived_destination', 'departing', 'checkout_home']
  );
});

test('steps out of order are rejected', async () => {
  const { service } = buildService('confirmed');
  await assert.rejects(service.arrive(CAREGIVER, 'bk-1', {}), (err) => err.code === 'STEP_INVALID');
  await assert.rejects(service.checkout(CAREGIVER, 'bk-1', { location: NEAR_PICKUP }), (err) => err.code === 'STEP_INVALID');
});

test('only the assigned caregiver can act on the job', async () => {
  const { service } = buildService('confirmed');
  await assert.rejects(
    service.checkin('someone-else', 'bk-1', { photo: PHOTO, location: NEAR_PICKUP }),
    (err) => err.code === 'BOOKING_NOT_FOUND'
  );
});

test('health record uploads photos and logs only ids in the event payload', async () => {
  const { repository, service } = buildService('confirmed');
  await service.checkin(CAREGIVER, 'bk-1', { photo: PHOTO, location: NEAR_PICKUP });
  await service.arrive(CAREGIVER, 'bk-1', {});
  const saved = await service.saveHealthRecord(CAREGIVER, 'bk-1', {
    vital_signs: { bp: '130/85', pulse: '78' },
    doctor_summary: 'ความดันคงที่ นัดติดตาม 3 เดือน',
    medications_received: [{ name: 'Amlodipine', note: '5mg วันละครั้ง', photo: PHOTO }],
    next_appointment: { date: '2026-09-15', department: 'อายุรกรรม' },
    attachments: [PHOTO]
  });
  assert.ok(saved.id);
  const record = repository.healthRecords[0];
  assert.match(record.medications_received[0].photo_ref, /^storage:\/\//);
  assert.equal(record.attachments.length, 1);
  const noteEvent = repository.events.find((event) => event.eventType === 'service_note_added');
  assert.ok(noteEvent);
  assert.equal(JSON.stringify(noteEvent.payload).includes('ความดัน'), false, 'no health values in event log');
});

test('health record is rejected before reaching the destination', async () => {
  const { service } = buildService('confirmed');
  await assert.rejects(
    service.saveHealthRecord(CAREGIVER, 'bk-1', { doctor_summary: 'x' }),
    (err) => err.code === 'STEP_INVALID'
  );
});

test('pings store + broadcast and raise geofence_alert when off-route > 2km', async () => {
  const broadcasts = [];
  const { repository, service } = buildService('confirmed', broadcasts);
  await service.checkin(CAREGIVER, 'bk-1', { photo: PHOTO, location: NEAR_PICKUP });

  const onRoute = await service.ping(CAREGIVER, 'bk-1', { lat: 13.757, lng: 100.495 });
  assert.equal(onRoute.stored, true);
  assert.equal(repository.events.some((event) => event.eventType === 'geofence_alert'), false);

  await service.ping(CAREGIVER, 'bk-1', { lat: 13.79, lng: 100.56 }); // big detour
  const alert = repository.events.find((event) => event.eventType === 'geofence_alert');
  assert.ok(alert);
  assert.ok(alert.payload.deviation_km > 2);
  assert.ok(broadcasts.some((message) => message.type === 'location'));
});

test('pings are dropped quietly outside active statuses', async () => {
  const { repository, service } = buildService('confirmed');
  const result = await service.ping(CAREGIVER, 'bk-1', { lat: 13.75, lng: 100.5 });
  assert.deepEqual(result, { stored: false });
  assert.equal(repository.pings.length, 0);
});

test('sos writes an event immediately in any active step', async () => {
  const { repository, service } = buildService('confirmed');
  const result = await service.sos(CAREGIVER, 'bk-1', { location: NEAR_PICKUP, note: 'ผู้สูงวัยหน้ามืด' });
  assert.deepEqual(result, { ok: true });
  assert.equal(repository.events[0].eventType, 'sos');
});
