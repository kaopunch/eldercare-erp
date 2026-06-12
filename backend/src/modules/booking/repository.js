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

module.exports = {
  findPricingRule,
  listCancellationRules,
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
