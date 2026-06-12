/**
 * Active job actions (spec G4) — one big button per step, driven strictly by
 * the BookingStateMachine:
 *   checkin  (photo + GPS <= 300m of pickup)  confirmed -> in_progress_pickup
 *   arrive                                    in_progress_pickup -> at_destination
 *   health-record (upsert, audit-logged)      at_destination..pending_confirmation
 *   departing                                 at_destination -> returning
 *   checkout (GPS <= 300m of pickup)          returning -> pending_confirmation
 *   sos      (event only, never queued)       any active status
 *   ping     (30s GPS) stored + fanned out to the tracking WS; route deviation
 *            > 2km during pickup leg raises a geofence_alert event
 */
const bookingRepository = require('../booking/repository');
const caregiverRepository = require('./repository');
const { createBookingStateMachine } = require('../booking/stateMachine');
const { haversineKm } = require('../booking/pricing');
const { publish } = require('../realtime/trackingHub');
const { notifySafe, adminGroupTarget } = require('../notification/notifier');
const { AppError } = require('../shared/appError');

function thaiTime(date = new Date()) {
  return date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
}

const CHECKIN_RADIUS_KM = 0.3;
const ROUTE_DEVIATION_KM = 2;
const PINGABLE = ['in_progress_pickup', 'at_destination', 'returning'];
const SOSABLE = ['confirmed', 'in_progress_pickup', 'at_destination', 'returning', 'pending_confirmation'];

function point(booking, prefix) {
  if (booking[`${prefix}_lat`] === null || booking[`${prefix}_lat`] === undefined) return null;
  return { lat: Number(booking[`${prefix}_lat`]), lng: Number(booking[`${prefix}_lng`]) };
}

/** Detour metric: how much longer pickup->p->destination is vs the direct leg. */
function routeDeviationKm(booking, location) {
  const pickup = point(booking, 'pickup');
  const destination = point(booking, 'destination');
  if (!pickup || !destination) return 0;
  const direct = haversineKm(pickup, destination);
  const viaPoint = haversineKm(pickup, location) + haversineKm(location, destination);
  return Math.max(0, viaPoint - direct);
}

function createActiveJobService({
  repository = bookingRepository,
  storageRepository = caregiverRepository,
  publishFn = publish,
  notifier = null,
  now = () => new Date()
} = {}) {
  const machine = createBookingStateMachine({ repository });
  // real repository -> real notifier; injected fakes (tests) stay silent
  const notify = notifier || (repository === bookingRepository ? notifySafe : () => {});

  /** LINE → ครอบครัว ทุก checkpoint (spec section 6). */
  function notifyCheckpoint(booking, template) {
    notify({
      userId: booking.customer_user_id,
      bookingId: booking.id,
      template,
      data: {
        booking_id: booking.id,
        destination_name: booking.destination_name,
        time: thaiTime(now())
      }
    });
  }

  async function ownedBooking(caregiverUserId, bookingId) {
    const booking = await repository.findBookingById(bookingId);
    if (!booking || booking.caregiver_user_id !== caregiverUserId) {
      throw new AppError('BOOKING_NOT_FOUND', 'ไม่พบงานนี้', 404);
    }
    return booking;
  }

  function assertNearby(target, location, code, message) {
    if (!location || !Number.isFinite(Number(location.lat))) {
      throw new AppError('LOCATION_REQUIRED', 'ต้องเปิด GPS เพื่อยืนยันตำแหน่ง', 422);
    }
    if (!target) return 0; // booking without pin — allow but record nothing to compare
    const distanceKm = haversineKm(target, { lat: Number(location.lat), lng: Number(location.lng) });
    if (distanceKm > CHECKIN_RADIUS_KM) {
      throw new AppError(code, message, 422, {
        distance_m: Math.round(distanceKm * 1000),
        max_m: CHECKIN_RADIUS_KM * 1000
      });
    }
    return Math.round(distanceKm * 1000);
  }

  async function uploadActionPhoto(booking, kind, photo) {
    if (!photo?.data_base64) {
      throw new AppError('PHOTO_REQUIRED', 'กรุณาถ่ายรูปเพื่อยืนยัน', 422);
    }
    const buffer = Buffer.from(String(photo.data_base64), 'base64');
    if (!buffer.length || buffer.length > 6 * 1024 * 1024) {
      throw new AppError('PHOTO_SIZE_INVALID', 'รูปว่างหรือใหญ่เกิน 6 MB', 422);
    }
    const contentType = String(photo.content_type || 'image/jpeg').split(';')[0];
    const objectPath = `bookings/${booking.id}/${kind}-${Date.now()}.jpg`;
    return storageRepository.uploadDocument(objectPath, buffer, contentType);
  }

  function broadcast(bookingId, payload) {
    try {
      publishFn(bookingId, payload);
    } catch {
      // realtime is best-effort; the source of truth is the DB
    }
  }

  async function transitionStep(booking, toStatus, options) {
    const { booking: updated, changed } = await machine.transition(booking, toStatus, options);
    if (changed) {
      broadcast(booking.id, { type: 'status', status: toStatus });
      broadcast(booking.id, {
        type: 'event',
        event_type: options.eventType,
        actor: options.actor,
        payload: options.payload || {},
        created_at: now().toISOString()
      });
    }
    return updated;
  }

  /** Step 1: เช็คอินรับผู้สูงวัย — photo + GPS within 300m of pickup. */
  async function checkin(caregiverUserId, bookingId, { photo, location }) {
    const booking = await ownedBooking(caregiverUserId, bookingId);
    if (booking.status === 'in_progress_pickup') return { status: booking.status }; // idempotent
    if (booking.status !== 'confirmed') {
      throw new AppError('STEP_INVALID', 'งานยังไม่พร้อมเช็คอิน', 409, { status: booking.status });
    }
    const distanceM = assertNearby(
      point(booking, 'pickup'),
      location,
      'CHECKIN_TOO_FAR',
      'คุณอยู่ห่างจากจุดรับเกิน 300 เมตร'
    );
    const photoRef = await uploadActionPhoto(booking, 'checkin', photo);
    const updated = await transitionStep(booking, 'in_progress_pickup', {
      actor: 'caregiver',
      eventType: 'checkin_home',
      location,
      payload: { photo_ref: photoRef, distance_m: distanceM }
    });
    notifyCheckpoint(booking, 'checkin_home');
    return { status: updated.status };
  }

  /** Step 2: ถึงจุดหมาย. */
  async function arrive(caregiverUserId, bookingId, { location } = {}) {
    const booking = await ownedBooking(caregiverUserId, bookingId);
    if (booking.status === 'at_destination') return { status: booking.status };
    if (booking.status !== 'in_progress_pickup') {
      throw new AppError('STEP_INVALID', 'ลำดับขั้นตอนไม่ถูกต้อง', 409, { status: booking.status });
    }
    const destination = point(booking, 'destination');
    const distanceM =
      destination && location
        ? Math.round(haversineKm(destination, location) * 1000)
        : null;
    const updated = await transitionStep(booking, 'at_destination', {
      actor: 'caregiver',
      eventType: 'arrived_destination',
      location: location || null,
      payload: distanceM === null ? {} : { distance_m: distanceM }
    });
    notifyCheckpoint(booking, 'arrived_destination');
    return { status: updated.status };
  }

  /** Step 3: บันทึกข้อมูลสุขภาพ (upsert — แก้ซ้ำได้จนกว่างานจบ). */
  async function saveHealthRecord(caregiverUserId, bookingId, input) {
    const booking = await ownedBooking(caregiverUserId, bookingId);
    if (!['at_destination', 'returning', 'pending_confirmation'].includes(booking.status)) {
      throw new AppError('STEP_INVALID', 'บันทึกข้อมูลสุขภาพได้เมื่อถึงจุดหมายแล้ว', 409);
    }
    const attachments = [];
    for (const file of input.attachments || []) {
      attachments.push(await uploadActionPhoto(booking, 'attachment', file));
    }
    const medications = [];
    for (const med of input.medications_received || []) {
      const entry = { name: med.name, note: med.note || '' };
      if (med.photo?.data_base64) {
        entry.photo_ref = await uploadActionPhoto(booking, 'medication', med.photo);
      }
      medications.push(entry);
    }
    const record = await repository.upsertHealthRecord({
      booking_id: booking.id,
      elder_profile_id: booking.elder_profile_id,
      vital_signs: input.vital_signs || {},
      doctor_summary: input.doctor_summary || null,
      medications_received: medications,
      next_appointment: input.next_appointment || null,
      attachments,
      created_by_user_id: caregiverUserId
    });
    await repository.insertBookingEvent({
      bookingId: booking.id,
      eventType: 'service_note_added',
      actor: 'caregiver',
      payload: { health_record_id: record.id } // ids only — health values never enter the event log
    });
    broadcast(booking.id, {
      type: 'event',
      event_type: 'service_note_added',
      actor: 'caregiver',
      payload: {},
      created_at: now().toISOString()
    });
    return { id: record.id };
  }

  /** Step 4: เริ่มเดินทางกลับ. */
  async function departing(caregiverUserId, bookingId, { location } = {}) {
    const booking = await ownedBooking(caregiverUserId, bookingId);
    if (booking.status === 'returning') return { status: booking.status };
    if (booking.status !== 'at_destination') {
      throw new AppError('STEP_INVALID', 'ลำดับขั้นตอนไม่ถูกต้อง', 409, { status: booking.status });
    }
    const updated = await transitionStep(booking, 'returning', {
      actor: 'caregiver',
      eventType: 'departing',
      location: location || null
    });
    notifyCheckpoint(booking, 'departing');
    return { status: updated.status };
  }

  /** Step 5: เช็คเอาท์ส่งถึงบ้าน — GPS within 300m of pickup. */
  async function checkout(caregiverUserId, bookingId, { location }) {
    const booking = await ownedBooking(caregiverUserId, bookingId);
    if (booking.status === 'pending_confirmation') return { status: booking.status };
    if (booking.status !== 'returning') {
      throw new AppError('STEP_INVALID', 'ลำดับขั้นตอนไม่ถูกต้อง', 409, { status: booking.status });
    }
    const distanceM = assertNearby(
      point(booking, 'pickup'),
      location,
      'CHECKOUT_TOO_FAR',
      'คุณอยู่ห่างจากบ้านผู้สูงวัยเกิน 300 เมตร'
    );
    const updated = await transitionStep(booking, 'pending_confirmation', {
      actor: 'caregiver',
      eventType: 'checkout_home',
      location,
      patch: { checkout_at: now().toISOString() },
      payload: { distance_m: distanceM }
    });
    notifyCheckpoint(booking, 'checkout_home');
    return { status: updated.status };
  }

  /** SOS — straight to the event log, no queue, works in every active step. */
  async function sos(caregiverUserId, bookingId, { location, note } = {}) {
    const booking = await ownedBooking(caregiverUserId, bookingId);
    if (!SOSABLE.includes(booking.status)) {
      throw new AppError('STEP_INVALID', 'งานนี้ไม่ได้กำลังดำเนินอยู่', 409);
    }
    await repository.insertBookingEvent({
      bookingId: booking.id,
      eventType: 'sos',
      actor: 'caregiver',
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      payload: { note: note || null }
    });
    console.error(`[SOS] booking=${booking.id} caregiver=${caregiverUserId}`);
    notify({
      lineTo: adminGroupTarget(),
      bookingId: booking.id,
      template: 'sos_admin',
      data: { booking_id: booking.id, note: note || '' }
    });
    broadcast(booking.id, {
      type: 'event',
      event_type: 'sos',
      actor: 'caregiver',
      payload: {},
      created_at: now().toISOString()
    });
    return { ok: true };
  }

  /** 30-second GPS ping — store, fan out, geofence check on the pickup leg. */
  async function ping(caregiverUserId, bookingId, { lat, lng, accuracy_m: accuracyM }) {
    const booking = await ownedBooking(caregiverUserId, bookingId);
    if (!PINGABLE.includes(booking.status)) {
      return { stored: false }; // job not running — drop quietly (late buffer flushes)
    }
    const saved = await repository.insertLocationPing({
      bookingId: booking.id,
      lat,
      lng,
      accuracyM: accuracyM ?? null
    });
    broadcast(booking.id, { type: 'location', lat, lng, recorded_at: saved.recorded_at });

    if (booking.status === 'in_progress_pickup') {
      const deviation = routeDeviationKm(booking, { lat, lng });
      if (deviation > ROUTE_DEVIATION_KM) {
        await repository.insertBookingEvent({
          bookingId: booking.id,
          eventType: 'geofence_alert',
          actor: 'system',
          lat,
          lng,
          payload: { deviation_km: Math.round(deviation * 10) / 10 }
        });
        console.error(`[geofence] booking=${booking.id} deviation=${deviation.toFixed(1)}km`);
        notify({
          lineTo: adminGroupTarget(),
          bookingId: booking.id,
          template: 'geofence_admin',
          data: { booking_id: booking.id, deviation_km: Math.round(deviation * 10) / 10 }
        });
      }
    }
    return { stored: true };
  }

  return { checkin, arrive, saveHealthRecord, departing, checkout, sos, ping, routeDeviationKm };
}

module.exports = { createActiveJobService };
