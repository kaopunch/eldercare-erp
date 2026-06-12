/**
 * E2E (spec M6 DoD): full booking flow against a real server + Supabase.
 *   register both sides -> elder profile -> onboard + verify caregiver ->
 *   availability -> quote -> book -> pay (mock escrow) -> offer -> accept ->
 *   confirm -> checkin -> arrive -> health record -> departing -> checkout ->
 *   confirm-complete -> wallet earning -> review -> rating updated
 * Creates throwaway users with random phones and deletes everything at the end.
 * Run: npm run test:e2e
 */
require('dotenv').config();
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { getSupabase } = require('../src/db/supabase');

const PORT = process.env.E2E_PORT || 8097;
const BASE = `http://localhost:${PORT}`;
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const randomDigits = (count) => Array.from({ length: count }, () => Math.floor(Math.random() * 10)).join('');
const CUSTOMER_PHONE = `06${randomDigits(8)}`;
const CAREGIVER_PHONE = `06${randomDigits(8)}`;

async function api(pathName, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${pathName} -> ${response.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function registerUser(portal, phone) {
  const otp = await api(`/api/v1/${portal}/auth/register`, { method: 'POST', body: { phone } });
  assert.ok(otp.dev_otp, 'mock OTP exposed in dev');
  const session = await api(`/api/v1/${portal}/auth/otp/verify`, {
    method: 'POST',
    body: { phone, code: otp.dev_otp, password: 'e2e-password-123' }
  });
  assert.equal(session.user.role, portal);
  return session;
}

function futureBangkok(daysAhead, time = '09:00') {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000 + 7 * 60 * 60 * 1000);
  return { scheduled_date: date.toISOString().slice(0, 10), pickup_time: time };
}

async function cleanup(ids) {
  const sb = getSupabase();
  const userIds = [ids.customerId, ids.caregiverId].filter(Boolean);
  if (!userIds.length) return;
  if (ids.bookingId) {
    for (const table of [
      'care_notifications',
      'care_reviews',
      'care_payout_ledger',
      'care_location_pings',
      'care_service_health_records',
      'care_booking_events',
      'care_booking_offers',
      'care_payments'
    ]) {
      await sb.from(table).delete().eq('booking_id', ids.bookingId);
    }
    await sb.from('care_bookings').delete().eq('id', ids.bookingId);
  }
  await sb.from('care_notifications').delete().in('user_id', userIds);
  await sb.from('care_caregiver_availability').delete().in('caregiver_user_id', userIds);
  await sb.from('care_payout_ledger').delete().in('caregiver_user_id', userIds);
  if (ids.elderId) {
    await sb.from('care_audit_logs').delete().eq('entity_id', ids.elderId);
    await sb.from('care_elder_profiles').delete().eq('id', ids.elderId);
  }
  await sb.from('care_caregiver_profiles').delete().in('user_id', userIds);
  await sb.from('care_refresh_tokens').delete().in('user_id', userIds);
  await sb.from('care_otp_codes').delete().in('phone', [`+66${CUSTOMER_PHONE.slice(1)}`, `+66${CAREGIVER_PHONE.slice(1)}`]);
  await sb.from('care_users').delete().in('id', userIds);
}

async function main() {
  // boot an isolated server
  const server = spawn('node', [path.join(__dirname, '../src/server.js')], {
    env: { ...process.env, PORT: String(PORT), CARE_PAYMENT_GATEWAY: 'mock' },
    stdio: 'ignore'
  });
  const ids = {};
  let exitCode = 0;
  try {
    // wait for health
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await api('/health');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    console.log('1) register customer + caregiver');
    const customer = await registerUser('customer', CUSTOMER_PHONE);
    const caregiver = await registerUser('caregiver', CAREGIVER_PHONE);
    ids.customerId = customer.user.id;
    ids.caregiverId = caregiver.user.id;

    console.log('2) elder profile with PDPA consent + home pin');
    const elder = await api('/api/v1/customer/elders', {
      method: 'POST',
      token: customer.access_token,
      body: {
        full_name: 'E2E ผู้สูงวัย',
        mobility: 'wheelchair',
        chronic_conditions: ['เบาหวาน'],
        home_address: 'E2E กรุงเทพฯ',
        home_location: { lat: 13.7563, lng: 100.5018 },
        consent_accepted: true
      }
    });
    ids.elderId = elder.id;

    console.log('3) caregiver onboarding + documents + verify + availability');
    await api('/api/v1/caregiver/onboard/profile', {
      method: 'POST',
      token: caregiver.access_token,
      body: {
        full_name: 'E2E ผู้ดูแล',
        background: 'trained_general',
        id_card_number: `1${randomDigits(12)}`,
        service_area: { lat: 13.75, lng: 100.5, radius_km: 20 },
        base_rate_half_day_baht: 750,
        base_rate_full_day_baht: 1400
      }
    });
    for (const type of ['id_card', 'photo']) {
      await api('/api/v1/caregiver/onboard/documents', {
        method: 'POST',
        token: caregiver.access_token,
        body: { type, file_name: `${type}.png`, content_type: 'image/png', data_base64: PNG }
      });
    }
    await getSupabase()
      .from('care_caregiver_profiles')
      .update({ verification_status: 'verified', verified_badge: true })
      .eq('user_id', ids.caregiverId);
    const when = futureBangkok(7);
    await api('/api/v1/caregiver/availability', {
      method: 'PUT',
      token: caregiver.access_token,
      body: { days: [{ date: when.scheduled_date, slots: { morning: true, afternoon: true } }] }
    });

    console.log('4) quote -> book -> pay (mock escrow) -> searching');
    const created = await api('/api/v1/customer/bookings', {
      method: 'POST',
      token: customer.access_token,
      body: {
        elder_profile_id: ids.elderId,
        service_type: 'hospital_visit',
        duration_type: 'half_day',
        ...when,
        destination_name: 'E2E โรงพยาบาล',
        destination_location: { lat: 13.758, lng: 100.486 },
        special_requirements: { wheelchair: true }
      }
    });
    ids.bookingId = created.booking.id;
    assert.equal(created.booking.status, 'pending_payment');
    const paid = await api(`/api/v1/customer/bookings/${ids.bookingId}/pay`, {
      method: 'POST',
      token: customer.access_token,
      body: { method: 'mock' }
    });
    assert.equal(paid.booking.status, 'searching');
    assert.equal(paid.payment_status, 'held_escrow');

    console.log('5) offer appears -> first-accept-wins -> customer confirms');
    const offers = await api('/api/v1/caregiver/jobs/offers', { token: caregiver.access_token });
    assert.ok(offers.some((offer) => offer.booking_id === ids.bookingId), 'offer broadcast to caregiver');
    const job = await api(`/api/v1/caregiver/jobs/${ids.bookingId}/accept`, {
      method: 'POST',
      token: caregiver.access_token
    });
    assert.equal(job.status, 'matched');
    const confirmed = await api(`/api/v1/customer/bookings/${ids.bookingId}/confirm`, {
      method: 'POST',
      token: customer.access_token
    });
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.caregiver.phone, `+66${CAREGIVER_PHONE.slice(1)}`, 'phone revealed after confirm');

    console.log('6) active job: checkin -> arrive -> health record -> departing -> checkout');
    const near = { lat: 13.7564, lng: 100.5018 };
    await assert.rejects(
      api(`/api/v1/caregiver/jobs/${ids.bookingId}/checkin`, {
        method: 'POST',
        token: caregiver.access_token,
        body: { photo: { content_type: 'image/png', data_base64: PNG }, location: { lat: 13.9, lng: 100.7 } }
      }),
      /CHECKIN_TOO_FAR/,
      '300m rule enforced'
    );
    const checkin = await api(`/api/v1/caregiver/jobs/${ids.bookingId}/checkin`, {
      method: 'POST',
      token: caregiver.access_token,
      body: { photo: { content_type: 'image/png', data_base64: PNG }, location: near }
    });
    assert.equal(checkin.status, 'in_progress_pickup');
    await api(`/api/v1/caregiver/jobs/${ids.bookingId}/location`, {
      method: 'POST',
      token: caregiver.access_token,
      body: { lat: 13.757, lng: 100.495 }
    });
    await api(`/api/v1/caregiver/jobs/${ids.bookingId}/arrive`, {
      method: 'POST',
      token: caregiver.access_token,
      body: { location: { lat: 13.758, lng: 100.486 } }
    });
    await api(`/api/v1/caregiver/jobs/${ids.bookingId}/health-record`, {
      method: 'POST',
      token: caregiver.access_token,
      body: {
        vital_signs: { bp: '120/80' },
        doctor_summary: 'E2E: อาการปกติ',
        medications_received: [{ name: 'E2E-Med', note: 'วันละครั้ง' }],
        next_appointment: { date: futureBangkok(90).scheduled_date, department: 'อายุรกรรม' }
      }
    });
    await api(`/api/v1/caregiver/jobs/${ids.bookingId}/departing`, {
      method: 'POST',
      token: caregiver.access_token,
      body: {}
    });
    const checkout = await api(`/api/v1/caregiver/jobs/${ids.bookingId}/checkout`, {
      method: 'POST',
      token: caregiver.access_token,
      body: { location: near }
    });
    assert.equal(checkout.status, 'pending_confirmation');

    console.log('7) confirm-complete -> escrow released -> wallet earning -> review');
    const completed = await api(`/api/v1/customer/bookings/${ids.bookingId}/confirm-complete`, {
      method: 'POST',
      token: customer.access_token
    });
    assert.equal(completed.status, 'completed');

    const wallet = await api('/api/v1/caregiver/wallet', { token: caregiver.access_token });
    const earning = wallet.ledger.find((entry) => entry.booking_id === ids.bookingId && entry.type === 'earning');
    assert.ok(earning, 'earning in payout ledger');
    assert.equal(wallet.balance_satang >= earning.amount, true);

    const healthRecords = await api(`/api/v1/customer/elders/${ids.elderId}/health-records`, {
      token: customer.access_token
    });
    assert.equal(healthRecords.length, 1, 'health record visible on the elder timeline');

    await api('/api/v1/customer/reviews', {
      method: 'POST',
      token: customer.access_token,
      body: { booking_id: ids.bookingId, stars: 5, comment: 'E2E เยี่ยม', tags: ['ตรงเวลา'] }
    });
    const received = await api('/api/v1/caregiver/reviews', { token: caregiver.access_token });
    assert.equal(received[0].stars, 5);

    const events = await api(`/api/v1/customer/bookings/${ids.bookingId}/events`, {
      token: customer.access_token
    });
    const eventTypes = events.map((event) => event.event_type);
    for (const expected of ['created', 'paid', 'matched', 'checkin_home', 'arrived_destination', 'service_note_added', 'departing', 'checkout_home', 'customer_confirmed']) {
      assert.ok(eventTypes.includes(expected), `event ${expected} logged`);
    }

    console.log('\nE2E PASS — booking -> completed ครบทุกขั้น ✓');
  } catch (err) {
    exitCode = 1;
    console.error('\nE2E FAIL:', err.message);
  } finally {
    try {
      await cleanup(ids);
      console.log('cleanup: test data removed');
    } catch (cleanupErr) {
      console.error('cleanup failed:', cleanupErr.message);
    }
    server.kill();
  }
  process.exit(exitCode);
}

main();
