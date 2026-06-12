/**
 * Notification engine (spec section 6 matrix). Channel priority per user:
 *   1. LINE push  — when LINE_CHANNEL_ACCESS_TOKEN is set AND the user linked
 *      their LINE account (care_users.line_user_id)
 *   2. SMS        — fallback for key events only (accepted/checkin/checkout)
 *   3. mock       — logged + stored in care_notifications so the matrix is
 *      verifiable end-to-end before real credentials exist
 * Every attempt is recorded in care_notifications. All sends are best-effort:
 * notifySafe never throws into a booking flow.
 */
const { getSupabase } = require('../../db/supabase');
const { configured: lineConfigured, sendLinePush } = require('../../lib/line');
const { getSmsProvider } = require('./smsProvider');

const SMS_FALLBACK_TEMPLATES = new Set(['accepted_customer', 'checkin_home', 'checkout_home']);

function customerUrl(path = '') {
  return `${process.env.CARE_PORTAL_BASE_URL || 'http://localhost:5173'}${path}`;
}

function caregiverUrl(path = '') {
  return `${process.env.CARE_CAREGIVER_PORTAL_BASE_URL || 'http://localhost:5174'}${path}`;
}

function bahtText(satang) {
  return (Number(satang || 0) / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

/** Thai message per template — every LINE message carries a deep link (spec). */
const TEMPLATES = {
  paid: (d) =>
    `อุ่นใจ Care: ชำระเงิน ${bahtText(d.amount_satang)} บาท สำเร็จแล้ว กำลังค้นหาผู้ดูแลสำหรับวันที่ ${d.scheduled_date}\n${customerUrl('/bookings')}`,
  new_offer: (d) =>
    `อุ่นใจ Care: มีงานใหม่ ${d.scheduled_date} ${String(d.pickup_time || '').slice(0, 5)} น. รายได้ ${bahtText(d.payout_satang)} บาท — กดรับก่อนหมดเวลา\n${caregiverUrl('/jobs')}`,
  accepted_customer: (d) =>
    `อุ่นใจ Care: พบผู้ดูแลแล้ว — ${d.caregiver_name} จะดูแลวันที่ ${d.scheduled_date}\nดูโปรไฟล์และยืนยัน: ${customerUrl('/bookings')}`,
  accepted_caregiver: (d) =>
    `อุ่นใจ Care: คุณรับงานวันที่ ${d.scheduled_date} ${String(d.pickup_time || '').slice(0, 5)} น. เรียบร้อย\n${caregiverUrl('/jobs')}`,
  checkin_home: (d) =>
    `อุ่นใจ Care: ผู้ดูแลถึงบ้านและรับ${d.elder_name || 'ผู้สูงวัย'}แล้ว (${d.time})\nติดตามสด: ${customerUrl(`/bookings/${d.booking_id}/track`)}`,
  arrived_destination: (d) =>
    `อุ่นใจ Care: ถึง${d.destination_name || 'จุดหมาย'}แล้ว (${d.time})\nติดตามสด: ${customerUrl(`/bookings/${d.booking_id}/track`)}`,
  departing: (d) =>
    `อุ่นใจ Care: เริ่มเดินทางกลับบ้านแล้ว (${d.time})\nติดตามสด: ${customerUrl(`/bookings/${d.booking_id}/track`)}`,
  checkout_home: (d) =>
    `อุ่นใจ Care: ส่ง${d.elder_name || 'ผู้สูงวัย'}ถึงบ้านเรียบร้อย (${d.time}) กรุณากดยืนยันจบงาน\n${customerUrl(`/bookings/${d.booking_id}/track`)}`,
  money_in: (d) =>
    `อุ่นใจ Care: เงินเข้ากระเป๋า ${bahtText(d.amount_satang)} บาท (ยอดคงเหลือ ${bahtText(d.balance_satang)} บาท)\n${caregiverUrl('/wallet')}`,
  sos_admin: (d) => `🚨 SOS! booking ${d.booking_id} ผู้ดูแล ${d.caregiver_name || ''} ${d.note || ''}`.trim(),
  geofence_admin: (d) => `⚠️ ออกนอกเส้นทาง ${d.deviation_km} กม. booking ${d.booking_id}`,
  line_linked: () => 'เชื่อมบัญชี LINE กับอุ่นใจ Care สำเร็จแล้ว ✓ จะได้รับการแจ้งเตือนทุกขั้นตอนทางนี้'
};

async function recordNotification(row) {
  try {
    await getSupabase().from('care_notifications').insert(row);
  } catch (err) {
    console.error('[notifier] log failed:', err.message);
  }
}

/**
 * @param {object} input {userId|null, lineTo?: string (override เช่น admin group),
 *   bookingId?, template, data}
 */
async function notify({ userId = null, lineTo = null, bookingId = null, template, data = {} }) {
  const builder = TEMPLATES[template];
  if (!builder) throw new Error(`unknown notification template: ${template}`);
  const message = builder(data);

  let user = null;
  if (userId) {
    const { data: row } = await getSupabase()
      .from('care_users')
      .select('id,phone,line_user_id')
      .eq('id', userId)
      .maybeSingle();
    user = row;
  }
  const lineTarget = lineTo || user?.line_user_id || null;

  // 1) LINE
  if (lineConfigured() && lineTarget) {
    try {
      await sendLinePush({ to: lineTarget, text: message });
      await recordNotification({ user_id: userId, booking_id: bookingId, template, channel: 'line', message, status: 'sent' });
      return { channel: 'line' };
    } catch (err) {
      await recordNotification({
        user_id: userId,
        booking_id: bookingId,
        template,
        channel: 'line',
        message,
        status: 'failed',
        detail: err.message
      });
      // fall through to SMS/mock
    }
  }

  // 2) SMS fallback — key events only (spec section 6)
  if (user?.phone && SMS_FALLBACK_TEMPLATES.has(template)) {
    try {
      await getSmsProvider().sendSms(user.phone, message);
      await recordNotification({ user_id: userId, booking_id: bookingId, template, channel: 'sms', message, status: 'sent' });
      return { channel: 'sms' };
    } catch {
      // fall through to mock
    }
  }

  // 3) mock — visible in logs + DB so the matrix is testable without credentials
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[notify:mock] template=${template} user=${userId || lineTarget || '-'}: ${message.split('\n')[0]}`);
  }
  await recordNotification({ user_id: userId, booking_id: bookingId, template, channel: 'mock', message, status: 'sent' });
  return { channel: 'mock' };
}

/** Fire-and-forget — notification failure must never break a booking flow. */
function notifySafe(input) {
  return notify(input).catch((err) => {
    console.error('[notifier]', input.template, err.message);
    return { channel: 'none' };
  });
}

function adminGroupTarget() {
  return process.env.CARE_LINE_ADMIN_GROUP_ID || null;
}

module.exports = { notify, notifySafe, adminGroupTarget, TEMPLATES };
