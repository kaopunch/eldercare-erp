/**
 * Pricing engine (spec 5.1). All money in int satang.
 *   price = base(duration) + distance surcharge + english premium multiplier
 *   output: price_total, platform_fee, caregiver_payout, insurance_fee
 * Rules come from care_pricing_rules (DB config — editable without deploy).
 */
const { AppError } = require('../shared/appError');

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance, good enough for surcharge bands. */
function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * @param {object} rule row from care_pricing_rules
 * @param {object} input {pickup:{lat,lng}, destination:{lat,lng}, special_requirements:{english?}}
 * @returns quote breakdown, every amount int satang
 */
function calculateQuote(rule, input) {
  if (!rule) {
    throw new AppError('PRICING_RULE_MISSING', 'ยังไม่มีอัตราค่าบริการสำหรับงานประเภทนี้', 500);
  }
  const pickup = input.pickup;
  const destination = input.destination;
  if (!pickup || !destination) {
    throw new AppError('LOCATION_REQUIRED', 'กรุณาระบุจุดรับและจุดหมาย', 422);
  }

  const distanceKm = Math.round(haversineKm(pickup, destination) * 10) / 10;
  const base = Number(rule.base_satang);

  const extraKm = Math.max(0, distanceKm - Number(rule.included_km));
  const distanceSurcharge = Math.round(extraKm * Number(rule.per_km_satang));

  const english = Boolean(input.special_requirements?.english);
  const subtotalBeforePremium = base + distanceSurcharge;
  const premium = english
    ? Math.round(subtotalBeforePremium * (Number(rule.english_multiplier) - 1))
    : 0;

  const subtotal = subtotalBeforePremium + premium;
  const insuranceFee = Number(rule.insurance_fee_satang);
  const platformFee = Math.round(subtotal * Number(rule.platform_fee_pct));
  const caregiverPayout = subtotal - platformFee;
  const priceTotal = subtotal + insuranceFee;

  return {
    service_type: rule.service_type,
    duration_type: rule.duration_type,
    distance_km: distanceKm,
    // line items shown to the customer (spec C3: transparent breakdown)
    breakdown: {
      base_satang: base,
      distance_surcharge_satang: distanceSurcharge,
      english_premium_satang: premium,
      insurance_fee_satang: insuranceFee
    },
    price_total_satang: priceTotal,
    platform_fee_satang: platformFee,
    caregiver_payout_satang: caregiverPayout,
    insurance_fee_satang: insuranceFee
  };
}

module.exports = { calculateQuote, haversineKm };
