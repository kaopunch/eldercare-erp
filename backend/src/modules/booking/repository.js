/** DB access for bookings/events/payments/pricing/cancel rules. */
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

// ===== config =====

async function findPricingRule(serviceType, durationType) {
  return unwrap(
    await db()
      .from('care_pricing_rules')
      .select('*')
      .eq('service_type', serviceType)
      .eq('duration_type', durationType)
      .eq('active', true)
      .maybeSingle()
  );
}

async function listCancellationRules() {
  return unwrap(await db().from('care_cancellation_rules').select('*').eq('active', true));
}

// ===== bookings =====

async function insertBooking(row) {
  return unwrap(await db().from('care_bookings').insert(row).select('*').single());
}

async function findBookingById(id, customerUserId = null) {
  let query = db().from('care_bookings').select('*').eq('id', id);
  if (customerUserId) query = query.eq('customer_user_id', customerUserId);
  return unwrap(await query.maybeSingle());
}

async function listBookingsByCustomer(customerUserId, statuses = null) {
  let query = db()
    .from('care_bookings')
    .select('*')
    .eq('customer_user_id', customerUserId)
    .order('scheduled_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (statuses?.length) query = query.in('status', statuses);
  return unwrap(await query);
}

/**
 * Conditional status update — WHERE status = fromStatus makes concurrent
 * transitions race-safe (first-writer-wins; loser gets null).
 */
async function updateBookingStatus(bookingId, fromStatus, patch) {
  return unwrap(
    await db()
      .from('care_bookings')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', bookingId)
      .eq('status', fromStatus)
      .select('*')
      .maybeSingle()
  );
}

// ===== events (append-only) =====

async function insertBookingEvent({ bookingId, eventType, actor, lat = null, lng = null, payload = {} }) {
  const row = {
    booking_id: bookingId,
    event_type: eventType,
    actor,
    lat,
    lng,
    payload
  };
  if (lat !== null && lng !== null) {
    row.location = `SRID=4326;POINT(${lng} ${lat})`;
  }
  return unwrap(await db().from('care_booking_events').insert(row).select('id').single());
}

async function listBookingEvents(bookingId) {
  return unwrap(
    await db()
      .from('care_booking_events')
      .select('id,event_type,actor,lat,lng,payload,created_at')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true })
  );
}

// ===== payments =====

async function insertPayment(row) {
  return unwrap(await db().from('care_payments').insert(row).select('*').single());
}

async function findPaymentByBooking(bookingId) {
  return unwrap(
    await db()
      .from('care_payments')
      .select('*')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

async function findPaymentByChargeId(chargeId) {
  return unwrap(
    await db().from('care_payments').select('*').eq('gateway_charge_id', chargeId).maybeSingle()
  );
}

async function updatePayment(id, patch) {
  return unwrap(
    await db()
      .from('care_payments')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single()
  );
}

async function findElderForCustomer(elderId, customerUserId) {
  return unwrap(
    await db()
      .from('care_elder_profiles')
      .select('id,full_name,nickname,home_address,home_lat,home_lng,mobility')
      .eq('id', elderId)
      .eq('owner_user_id', customerUserId)
      .is('deleted_at', null)
      .maybeSingle()
  );
}

// ===== matching: candidates + offers (M3) =====

/** Verified caregivers with their availability slots for a given date. */
async function listVerifiedCaregiversWithAvailability(date) {
  const availability = unwrap(
    await db()
      .from('care_caregiver_availability')
      .select('caregiver_user_id,slots')
      .eq('date', date)
  );
  if (!availability.length) return [];
  const byUser = new Map(availability.map((row) => [row.caregiver_user_id, row.slots]));
  const profiles = unwrap(
    await db()
      .from('care_caregiver_profiles')
      .select(
        'user_id,gender,languages,service_area_lat,service_area_lng,service_radius_km,verification_status,rating_avg,jobs_completed'
      )
      .eq('verification_status', 'verified')
      .in('user_id', [...byUser.keys()])
  );
  return profiles.map((profile) => ({ ...profile, availability: byUser.get(profile.user_id) || null }));
}

async function listOffersForBooking(bookingId) {
  return unwrap(
    await db()
      .from('care_booking_offers')
      .select('*')
      .eq('booking_id', bookingId)
      .order('batch_no', { ascending: true })
  );
}

async function insertOffers(rows) {
  if (!rows.length) return [];
  return unwrap(await db().from('care_booking_offers').insert(rows).select('id'));
}

async function expireOffers(bookingId, nowIso) {
  const { error } = await db()
    .from('care_booking_offers')
    .update({ status: 'expired' })
    .eq('booking_id', bookingId)
    .eq('status', 'offered')
    .lte('expires_at', nowIso);
  if (error) throw new AppError('DB_ERROR', 'เกิดข้อผิดพลาดภายในระบบ', 500, { hint: error.message });
}

async function listActiveOffersForCaregiver(caregiverUserId, nowIso) {
  return unwrap(
    await db()
      .from('care_booking_offers')
      .select('*, booking:care_bookings(*)')
      .eq('caregiver_user_id', caregiverUserId)
      .eq('status', 'offered')
      .gt('expires_at', nowIso)
      .order('expires_at', { ascending: true })
  );
}

async function setOfferStatus(bookingId, caregiverUserId, status) {
  const { error } = await db()
    .from('care_booking_offers')
    .update({ status, responded_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
    .eq('caregiver_user_id', caregiverUserId);
  if (error) throw new AppError('DB_ERROR', 'เกิดข้อผิดพลาดภายในระบบ', 500, { hint: error.message });
}

async function markOtherOffersLost(bookingId, winnerUserId) {
  const { error } = await db()
    .from('care_booking_offers')
    .update({ status: 'lost' })
    .eq('booking_id', bookingId)
    .eq('status', 'offered')
    .neq('caregiver_user_id', winnerUserId);
  if (error) throw new AppError('DB_ERROR', 'เกิดข้อผิดพลาดภายในระบบ', 500, { hint: error.message });
}

async function listSearchingBookings() {
  return unwrap(await db().from('care_bookings').select('*').eq('status', 'searching'));
}

async function listBookingsByCaregiver(caregiverUserId, statuses) {
  let query = db()
    .from('care_bookings')
    .select('*')
    .eq('caregiver_user_id', caregiverUserId)
    .order('scheduled_date', { ascending: true });
  if (statuses?.length) query = query.in('status', statuses);
  return unwrap(await query);
}

// ===== availability (G2) =====

async function listAvailability(caregiverUserId, fromDate, toDate) {
  return unwrap(
    await db()
      .from('care_caregiver_availability')
      .select('date,slots')
      .eq('caregiver_user_id', caregiverUserId)
      .gte('date', fromDate)
      .lte('date', toDate)
      .order('date', { ascending: true })
  );
}

async function upsertAvailability(caregiverUserId, days) {
  const rows = days.map((day) => ({
    caregiver_user_id: caregiverUserId,
    date: day.date,
    slots: day.slots,
    updated_at: new Date().toISOString()
  }));
  return unwrap(
    await db()
      .from('care_caregiver_availability')
      .upsert(rows, { onConflict: 'caregiver_user_id,date' })
      .select('date,slots')
  );
}

// ===== active job: pings + health records (M4) =====

async function insertLocationPing({ bookingId, lat, lng, accuracyM = null, recordedAt = null }) {
  return unwrap(
    await db()
      .from('care_location_pings')
      .insert({
        booking_id: bookingId,
        lat,
        lng,
        accuracy_m: accuracyM,
        recorded_at: recordedAt || new Date().toISOString()
      })
      .select('id,lat,lng,recorded_at')
      .single()
  );
}

async function latestLocationPing(bookingId) {
  return unwrap(
    await db()
      .from('care_location_pings')
      .select('lat,lng,accuracy_m,recorded_at')
      .eq('booking_id', bookingId)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
}

async function upsertHealthRecord(row) {
  return unwrap(
    await db()
      .from('care_service_health_records')
      .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'booking_id' })
      .select('*')
      .single()
  );
}

async function findHealthRecordByBooking(bookingId) {
  return unwrap(
    await db().from('care_service_health_records').select('*').eq('booking_id', bookingId).maybeSingle()
  );
}

async function incrementJobsCompleted(caregiverUserId) {
  const { data, error } = await db()
    .from('care_caregiver_profiles')
    .select('jobs_completed')
    .eq('user_id', caregiverUserId)
    .maybeSingle();
  if (error || !data) return;
  await db()
    .from('care_caregiver_profiles')
    .update({ jobs_completed: (data.jobs_completed || 0) + 1, updated_at: new Date().toISOString() })
    .eq('user_id', caregiverUserId);
}

/** Elder card shown on the caregiver active-job screen + family emergency phone. */
async function findElderForJob(elderProfileId) {
  const elder = unwrap(
    await db()
      .from('care_elder_profiles')
      .select('id,full_name,nickname,mobility,chronic_conditions,special_notes,photo_url,owner_user_id')
      .eq('id', elderProfileId)
      .maybeSingle()
  );
  if (!elder) return null;
  const owner = unwrap(
    await db().from('care_users').select('phone').eq('id', elder.owner_user_id).maybeSingle()
  );
  return { ...elder, family_phone: owner?.phone || null };
}

/** Public caregiver info shown to the customer after match — name/photo only. */
async function findCaregiverPublicInfo(userId) {
  const profile = unwrap(
    await db()
      .from('care_caregiver_profiles')
      .select('full_name,gender,rating_avg,jobs_completed,verified_badge')
      .eq('user_id', userId)
      .maybeSingle()
  );
  if (!profile) return null;
  const user = unwrap(
    await db().from('care_users').select('phone').eq('id', userId).maybeSingle()
  );
  return { ...profile, phone: user?.phone || null };
}

module.exports = {
  findPricingRule,
  listCancellationRules,
  listVerifiedCaregiversWithAvailability,
  listOffersForBooking,
  insertOffers,
  expireOffers,
  listActiveOffersForCaregiver,
  setOfferStatus,
  markOtherOffersLost,
  listSearchingBookings,
  listBookingsByCaregiver,
  listAvailability,
  upsertAvailability,
  findCaregiverPublicInfo,
  insertLocationPing,
  latestLocationPing,
  upsertHealthRecord,
  findHealthRecordByBooking,
  incrementJobsCompleted,
  findElderForJob,
  insertBooking,
  findBookingById,
  listBookingsByCustomer,
  updateBookingStatus,
  insertBookingEvent,
  listBookingEvents,
  insertPayment,
  findPaymentByBooking,
  findPaymentByChargeId,
  updatePayment,
  findElderForCustomer
};
