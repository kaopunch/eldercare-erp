/** Thai phone normalization to E.164 (+66) for care_users.phone. */
const { AppError } = require('./appError');

function normalizePhone(input) {
  const digits = String(input || '').replace(/[^\d+]/g, '');
  let normalized = null;
  if (/^\+66[689]\d{8}$/.test(digits)) {
    normalized = digits;
  } else if (/^66[689]\d{8}$/.test(digits)) {
    normalized = `+${digits}`;
  } else if (/^0[689]\d{8}$/.test(digits)) {
    normalized = `+66${digits.slice(1)}`;
  }
  if (!normalized) {
    throw new AppError('PHONE_INVALID', 'เบอร์โทรศัพท์ไม่ถูกต้อง กรุณากรอกเบอร์มือถือไทย', 422);
  }
  return normalized;
}

module.exports = { normalizePhone };
