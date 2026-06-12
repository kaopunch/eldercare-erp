/**
 * Cancellation fee rules (spec 3.1) — tiers come from care_cancellation_rules
 * (DB config, not hardcoded):
 *   >= 24h before pickup: customer 100% refund, caregiver 0
 *   6–24h:                customer 80%,        caregiver 10% of payout
 *   < 6h:                 customer 50%,        caregiver 30% of payout
 * Caregiver-initiated cancellation after confirmed: customer 100% (strike
 * handling arrives with M3 matching).
 */
const { AppError } = require('../shared/appError');

/**
 * Pick the applicable tier. Rules sorted by min_hours_before desc; first tier
 * whose min_hours_before <= hoursBefore wins.
 */
function resolveTier(rules, hoursBefore) {
  const sorted = [...rules]
    .filter((rule) => rule.active !== false)
    .sort((a, b) => Number(b.min_hours_before) - Number(a.min_hours_before));
  if (!sorted.length) {
    throw new AppError('CANCEL_RULES_MISSING', 'ยังไม่มีกติกายกเลิกในระบบ', 500);
  }
  for (const rule of sorted) {
    if (hoursBefore >= Number(rule.min_hours_before)) return rule;
  }
  return sorted[sorted.length - 1]; // below the lowest threshold (incl. past pickup time)
}

/**
 * @param {object} input {
 *   rules: care_cancellation_rules rows,
 *   cancelledBy: 'customer'|'caregiver'|'system'|'admin',
 *   hoursBefore: number (may be negative),
 *   priceTotalSatang, caregiverPayoutSatang
 * }
 * @returns {refund_pct, refund_satang, caregiver_comp_pct, caregiver_comp_satang}
 */
function calculateCancellation(input) {
  const { rules, cancelledBy, hoursBefore, priceTotalSatang, caregiverPayoutSatang } = input;

  // caregiver/system/admin cancellation never penalizes the customer
  if (cancelledBy !== 'customer') {
    return {
      refund_pct: 100,
      refund_satang: priceTotalSatang,
      caregiver_comp_pct: 0,
      caregiver_comp_satang: 0
    };
  }

  const tier = resolveTier(rules, hoursBefore);
  const refundPct = Number(tier.customer_refund_pct);
  const compPct = Number(tier.caregiver_comp_pct);
  return {
    refund_pct: refundPct,
    refund_satang: Math.round((priceTotalSatang * refundPct) / 100),
    caregiver_comp_pct: compPct,
    caregiver_comp_satang: Math.round(((caregiverPayoutSatang || 0) * compPct) / 100)
  };
}

module.exports = { calculateCancellation, resolveTier };
