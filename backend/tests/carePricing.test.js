const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateQuote, haversineKm } = require('../src/modules/booking/pricing');
const { calculateCancellation } = require('../src/modules/booking/cancellation');

const RULE = {
  service_type: 'hospital_visit',
  duration_type: 'half_day',
  base_satang: 90000, // 900 บาท
  included_km: 10,
  per_km_satang: 800, // 8 บาท/กม.
  english_multiplier: 1.25,
  platform_fee_pct: 0.2,
  insurance_fee_satang: 5000 // 50 บาท
};

// ~13.6 km apart (Siam -> Bang Khae area)
const PICKUP = { lat: 13.7563, lng: 100.5018 };
const DEST_FAR = { lat: 13.7563, lng: 100.38 };
const DEST_NEAR = { lat: 13.76, lng: 100.51 };

test('haversine distance is sane for Bangkok coordinates', () => {
  const km = haversineKm(PICKUP, DEST_FAR);
  assert.ok(km > 12 && km < 14, `expected ~13.2km got ${km}`);
});

test('base price within included km — no distance surcharge', () => {
  const quote = calculateQuote(RULE, { pickup: PICKUP, destination: DEST_NEAR, special_requirements: {} });
  assert.equal(quote.breakdown.distance_surcharge_satang, 0);
  assert.equal(quote.price_total_satang, 90000 + 5000);
  assert.equal(quote.platform_fee_satang, 18000); // 20% of 900
  assert.equal(quote.caregiver_payout_satang, 72000);
});

test('distance surcharge applies only beyond included km', () => {
  const quote = calculateQuote(RULE, { pickup: PICKUP, destination: DEST_FAR, special_requirements: {} });
  assert.ok(quote.distance_km > 12);
  const expectedSurcharge = Math.round((quote.distance_km - 10) * 800);
  assert.equal(quote.breakdown.distance_surcharge_satang, expectedSurcharge);
  assert.equal(
    quote.price_total_satang,
    90000 + expectedSurcharge + 5000
  );
});

test('english premium multiplies base+distance, not insurance', () => {
  const quote = calculateQuote(RULE, {
    pickup: PICKUP,
    destination: DEST_NEAR,
    special_requirements: { english: true }
  });
  assert.equal(quote.breakdown.english_premium_satang, Math.round(90000 * 0.25));
  assert.equal(quote.price_total_satang, 90000 + 22500 + 5000);
  // payout/fee split on subtotal (base+premium), insurance excluded
  assert.equal(quote.platform_fee_satang, Math.round(112500 * 0.2));
  assert.equal(quote.caregiver_payout_satang, 112500 - Math.round(112500 * 0.2));
});

test('all quote outputs are integers (satang)', () => {
  const quote = calculateQuote(RULE, {
    pickup: PICKUP,
    destination: DEST_FAR,
    special_requirements: { english: true }
  });
  for (const value of [
    quote.price_total_satang,
    quote.platform_fee_satang,
    quote.caregiver_payout_satang,
    quote.insurance_fee_satang,
    ...Object.values(quote.breakdown)
  ]) {
    assert.equal(Number.isInteger(value), true);
  }
});

test('missing pricing rule throws PRICING_RULE_MISSING', () => {
  assert.throws(
    () => calculateQuote(null, { pickup: PICKUP, destination: DEST_NEAR }),
    (err) => err.code === 'PRICING_RULE_MISSING'
  );
});

// ===== cancellation tiers (spec 3.1) =====

const CANCEL_RULES = [
  { min_hours_before: 24, customer_refund_pct: 100, caregiver_comp_pct: 0, active: true },
  { min_hours_before: 6, customer_refund_pct: 80, caregiver_comp_pct: 10, active: true },
  { min_hours_before: 0, customer_refund_pct: 50, caregiver_comp_pct: 30, active: true }
];

function cancelAt(hoursBefore) {
  return calculateCancellation({
    rules: CANCEL_RULES,
    cancelledBy: 'customer',
    hoursBefore,
    priceTotalSatang: 100000,
    caregiverPayoutSatang: 72000
  });
}

test('customer cancel >24h: 100% refund, no caregiver comp', () => {
  const result = cancelAt(30);
  assert.equal(result.refund_pct, 100);
  assert.equal(result.refund_satang, 100000);
  assert.equal(result.caregiver_comp_satang, 0);
});

test('customer cancel 6-24h: 80% refund, 10% payout comp', () => {
  const result = cancelAt(12);
  assert.equal(result.refund_pct, 80);
  assert.equal(result.refund_satang, 80000);
  assert.equal(result.caregiver_comp_satang, 7200);
});

test('customer cancel <6h: 50% refund, 30% payout comp', () => {
  const result = cancelAt(2);
  assert.equal(result.refund_pct, 50);
  assert.equal(result.refund_satang, 50000);
  assert.equal(result.caregiver_comp_satang, 21600);
});

test('boundary hours hit the higher tier exactly at the threshold', () => {
  assert.equal(cancelAt(24).refund_pct, 100);
  assert.equal(cancelAt(23.99).refund_pct, 80);
  assert.equal(cancelAt(6).refund_pct, 80);
  assert.equal(cancelAt(5.99).refund_pct, 50);
  assert.equal(cancelAt(-1).refund_pct, 50); // past pickup time
});

test('caregiver/system cancellation always refunds customer 100%', () => {
  for (const who of ['caregiver', 'system', 'admin']) {
    const result = calculateCancellation({
      rules: CANCEL_RULES,
      cancelledBy: who,
      hoursBefore: 1,
      priceTotalSatang: 100000,
      caregiverPayoutSatang: 72000
    });
    assert.equal(result.refund_pct, 100);
    assert.equal(result.refund_satang, 100000);
  }
});
