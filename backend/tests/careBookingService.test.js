const test = require('node:test');
const assert = require('node:assert/strict');

const { createBookingService } = require('../src/modules/booking/service');
const { MockGateway } = require('../src/modules/payment/gateway');

const CUSTOMER = 'customer-1';
const ELDER_ID = '11111111-1111-1111-1111-111111111111';

const PRICING_RULES = {
  'hospital_visit:half_day': {
    service_type: 'hospital_visit',
    duration_type: 'half_day',
    base_satang: 90000,
    included_km: 10,
    per_km_satang: 800,
    english_multiplier: 1.25,
    platform_fee_pct: 0.2,
    insurance_fee_satang: 5000
  }
};

const CANCEL_RULES = [
  { min_hours_before: 24, customer_refund_pct: 100, caregiver_comp_pct: 0, active: true },
  { min_hours_before: 6, customer_refund_pct: 80, caregiver_comp_pct: 10, active: true },
  { min_hours_before: 0, customer_refund_pct: 50, caregiver_comp_pct: 30, active: true }
];

function createFakeBookingRepository() {
  const bookings = [];
  const events = [];
  const payments = [];
  let nextId = 1;
  const id = (prefix) => `${prefix}-${nextId++}`;
  return {
    bookings,
    events,
    payments,
    async findPricingRule(serviceType, durationType) {
      return PRICING_RULES[`${serviceType}:${durationType}`] || null;
    },
    async listCancellationRules() {
      return CANCEL_RULES;
    },
    async insertBooking(row) {
      const booking = { ...row, id: id('bk'), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      bookings.push(booking);
      return booking;
    },
    async findBookingById(bookingId, customerUserId = null) {
      const booking = bookings.find((row) => row.id === bookingId) || null;
      if (!booking) return null;
      if (customerUserId && booking.customer_user_id !== customerUserId) return null;
      return { ...booking };
    },
    async listBookingsByCustomer(customerUserId) {
      return bookings.filter((row) => row.customer_user_id === customerUserId).map((row) => ({ ...row }));
    },
    async updateBookingStatus(bookingId, fromStatus, patch) {
      const booking = bookings.find((row) => row.id === bookingId);
      if (!booking || booking.status !== fromStatus) return null;
      Object.assign(booking, patch);
      return { ...booking };
    },
    async insertBookingEvent(event) {
      events.push(event);
      return { id: id('ev') };
    },
    async listBookingEvents(bookingId) {
      return events.filter((event) => event.bookingId === bookingId);
    },
    async insertPayment(row) {
      const payment = { ...row, id: id('pm') };
      payments.push(payment);
      return payment;
    },
    async findPaymentByBooking(bookingId) {
      return [...payments].reverse().find((payment) => payment.booking_id === bookingId) || null;
    },
    async findPaymentByChargeId(chargeId) {
      return payments.find((payment) => payment.gateway_charge_id === chargeId) || null;
    },
    async updatePayment(paymentId, patch) {
      const payment = payments.find((row) => row.id === paymentId);
      Object.assign(payment, patch);
      return { ...payment };
    },
    async findElderForCustomer(elderId, customerUserId) {
      if (elderId !== ELDER_ID || customerUserId !== CUSTOMER) return null;
      return {
        id: ELDER_ID,
        full_name: 'สมศรี ทดสอบ',
        home_address: 'บ้านทดสอบ',
        home_lat: 13.7563,
        home_lng: 100.5018,
        mobility: 'wheelchair'
      };
    },
    // matching stubs (no caregivers in these tests)
    async listVerifiedCaregiversWithAvailability() {
      return [];
    },
    async listOffersForBooking() {
      return [];
    },
    async insertOffers(rows) {
      return rows;
    },
    async expireOffers() {},
    async findCaregiverPublicInfo() {
      return null;
    }
  };
}

function futureDate(hoursAhead) {
  const date = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
  // shift to Bangkok local date/time strings
  const bkk = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return {
    scheduled_date: bkk.toISOString().slice(0, 10),
    pickup_time: bkk.toISOString().slice(11, 16)
  };
}

function validCreateInput(hoursAhead = 48) {
  return {
    elder_profile_id: ELDER_ID,
    service_type: 'hospital_visit',
    duration_type: 'half_day',
    ...futureDate(hoursAhead),
    destination_name: 'โรงพยาบาลศิริราช',
    destination_location: { lat: 13.758, lng: 100.486 },
    special_requirements: { wheelchair: true }
  };
}

function buildService(repositoryOverrides = {}) {
  const repository = { ...createFakeBookingRepository(), ...repositoryOverrides };
  const service = createBookingService({ repository, gateway: new MockGateway() });
  return { repository, service };
}

test('create booking: snapshot price, pending_payment with 30-min expiry', async () => {
  const { repository, service } = buildService();
  const { booking, quote } = await service.createBooking(CUSTOMER, validCreateInput());
  assert.equal(booking.status, 'pending_payment');
  assert.ok(booking.payment_expires_at);
  assert.equal(booking.price_total_satang, quote.price_total_satang);
  assert.equal(repository.events[0].eventType, 'created');
  // pickup defaulted from elder home pin
  assert.deepEqual(booking.pickup_location, { lat: 13.7563, lng: 100.5018 });
});

test('bedridden elder is rejected', async () => {
  const { service } = buildService({
    async findElderForCustomer() {
      return { id: ELDER_ID, mobility: 'bedridden', home_lat: 13.7, home_lng: 100.5 };
    }
  });
  await assert.rejects(service.createBooking(CUSTOMER, validCreateInput()), (err) => err.code === 'MOBILITY_NOT_SUPPORTED');
});

test('scheduling in the past or beyond 30 days is rejected', async () => {
  const { service } = buildService();
  await assert.rejects(service.createBooking(CUSTOMER, validCreateInput(-2)), (err) => err.code === 'SCHEDULE_PAST');
  await assert.rejects(service.createBooking(CUSTOMER, validCreateInput(31 * 24)), (err) => err.code === 'SCHEDULE_TOO_FAR');
});

test('pay with mock gateway: escrow held and booking reaches searching (M2 DoD)', async () => {
  const { repository, service } = buildService();
  const { booking } = await service.createBooking(CUSTOMER, validCreateInput());
  const paid = await service.pay(CUSTOMER, booking.id, { method: 'mock' });
  assert.equal(paid.booking.status, 'searching');
  assert.equal(paid.payment_status, 'held_escrow');
  assert.equal(repository.payments[0].status, 'held_escrow');
  assert.equal(repository.events.map((event) => event.eventType).includes('paid'), true);
});

test('pay is idempotent: second call returns searching without a second charge', async () => {
  const { repository, service } = buildService();
  const { booking } = await service.createBooking(CUSTOMER, validCreateInput());
  await service.pay(CUSTOMER, booking.id, { method: 'mock' });
  const again = await service.pay(CUSTOMER, booking.id, { method: 'mock' });
  assert.equal(again.booking.status, 'searching');
  assert.equal(repository.payments.length, 1);
});

test('expired pending_payment flips to cancelled on read', async () => {
  const { repository, service } = buildService();
  const { booking } = await service.createBooking(CUSTOMER, validCreateInput());
  // force expiry
  const row = repository.bookings.find((item) => item.id === booking.id);
  row.payment_expires_at = new Date(Date.now() - 60 * 1000).toISOString();
  const read = await service.getBooking(CUSTOMER, booking.id);
  assert.equal(read.status, 'cancelled');
  assert.equal(read.cancel_reason, 'payment_expired');
  await assert.rejects(service.pay(CUSTOMER, booking.id, { method: 'mock' }), (err) => err.code === 'PAYMENT_NOT_ALLOWED');
});

test('cancel while searching (no caregiver yet) always refunds 100%', async () => {
  const { repository, service } = buildService();
  const { booking } = await service.createBooking(CUSTOMER, validCreateInput(2)); // would be 50% tier
  await service.pay(CUSTOMER, booking.id, { method: 'mock' });
  const result = await service.cancel(CUSTOMER, booking.id, 'หาไม่ทัน');
  assert.equal(result.booking.refund_pct, 100);
  assert.equal(result.refund_satang, booking.price_total_satang);
  assert.equal(repository.payments[0].status, 'refunded');
});

test('cancel after caregiver matched refunds per tier and records refund on payment', async () => {
  const { repository, service } = buildService();
  const { booking } = await service.createBooking(CUSTOMER, validCreateInput(12)); // 6-24h tier
  await service.pay(CUSTOMER, booking.id, { method: 'mock' });
  // simulate a caregiver having accepted (M3 matched state)
  const row = repository.bookings.find((item) => item.id === booking.id);
  row.status = 'confirmed';
  row.caregiver_user_id = 'caregiver-9';
  const result = await service.cancel(CUSTOMER, booking.id, 'เปลี่ยนแผน');
  assert.equal(result.booking.status, 'cancelled');
  assert.equal(result.booking.refund_pct, 80);
  assert.equal(result.refund_satang, Math.round((booking.price_total_satang * 80) / 100));
  assert.equal(repository.payments[0].status, 'refunded');
  assert.equal(repository.payments[0].refund_amount, result.refund_satang);
});

test('cancel unpaid booking needs no refund and is idempotent', async () => {
  const { repository, service } = buildService();
  const { booking } = await service.createBooking(CUSTOMER, validCreateInput());
  const first = await service.cancel(CUSTOMER, booking.id, 'ไม่จ่ายแล้ว');
  assert.equal(first.booking.status, 'cancelled');
  assert.equal(first.refund_satang, null);
  assert.equal(repository.payments.length, 0);
  const second = await service.cancel(CUSTOMER, booking.id, 'ซ้ำ');
  assert.equal(second.booking.status, 'cancelled');
});

test('webhook charge.complete transitions pending payment and is idempotent', async () => {
  const repository = createFakeBookingRepository();
  // gateway that returns pending (PromptPay-like)
  const pendingGateway = {
    name: 'omise',
    async createCharge() {
      return { chargeId: 'chrg_test_1', status: 'pending', qrImageUrl: 'https://qr.example/1.png' };
    },
    async refund() {
      return { refundId: 'rfnd_1', status: 'closed' };
    }
  };
  const service = createBookingService({ repository, gateway: pendingGateway });
  const { booking } = await service.createBooking(CUSTOMER, validCreateInput());
  const payResult = await service.pay(CUSTOMER, booking.id, { method: 'promptpay' });
  assert.equal(payResult.payment_status, 'pending');
  assert.equal(payResult.qr_image_url, 'https://qr.example/1.png');
  assert.equal(payResult.booking.status, 'pending_payment');

  await service.handleChargeComplete('chrg_test_1', 'successful');
  let read = await service.getBooking(CUSTOMER, booking.id);
  assert.equal(read.status, 'searching');

  // duplicate webhook delivery is harmless
  await service.handleChargeComplete('chrg_test_1', 'successful');
  read = await service.getBooking(CUSTOMER, booking.id);
  assert.equal(read.status, 'searching');
  assert.equal(repository.events.filter((event) => event.eventType === 'paid').length, 1);
});

test('quote endpoint returns transparent line items', async () => {
  const { service } = buildService();
  const quote = await service.quote({
    service_type: 'hospital_visit',
    duration_type: 'half_day',
    pickup: { lat: 13.7563, lng: 100.5018 },
    destination: { lat: 13.758, lng: 100.486 },
    special_requirements: {}
  });
  assert.ok(quote.breakdown.base_satang > 0);
  assert.equal(
    quote.price_total_satang,
    quote.breakdown.base_satang +
      quote.breakdown.distance_surcharge_satang +
      quote.breakdown.english_premium_satang +
      quote.breakdown.insurance_fee_satang
  );
});

test('cancel preview reports tier without mutating the booking', async () => {
  const { service } = buildService();
  const { booking } = await service.createBooking(CUSTOMER, validCreateInput(48));
  await service.pay(CUSTOMER, booking.id, { method: 'mock' });
  const preview = await service.cancelPreview(CUSTOMER, booking.id);
  assert.equal(preview.cancellable, true);
  assert.equal(preview.refund_pct, 100);
  const read = await service.getBooking(CUSTOMER, booking.id);
  assert.equal(read.status, 'searching');
});
