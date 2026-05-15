function configured() {
  return Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN);
}

function lineRecipient(context = {}, notification = {}) {
  const payload = notification.payload || {};
  const customer = Array.isArray(context.booking?.customers)
    ? context.booking.customers[0]
    : context.booking?.customers;
  const recipient = context.recipient || {};
  return payload.line_user_id
    || payload.line_id
    || recipient.line_id
    || customer?.line_id
    || null;
}

const TYPE_MESSAGES = {
  portal_booking_requested: 'รับคำขอจองแล้ว ทีมจะตรวจราคา เวลา และความพร้อมก่อนยืนยันงาน',
  booking_requested: 'รับคำขอจองแล้ว ทีมกำลังตรวจรายละเอียด',
  booking_updated: 'มีการอัปเดตข้อมูล booking',
  booking_confirmed: 'ยืนยันงานเรียบร้อยแล้ว',
  booking_cancelled: 'booking นี้ถูกยกเลิกแล้ว',
  portal_link_ready: 'ลิงก์ติดตามสถานะพร้อมแล้ว',
  trip_driver_accepted: 'คนขับรับงานแล้ว',
  trip_arrived_pickup: 'ทีมถึงจุดรับแล้ว',
  arrived_at_location: 'ทีมถึงสถานที่บริการแล้ว',
  trip_elder_onboard: 'ผู้สูงวัยขึ้นรถเรียบร้อยแล้ว',
  patient_onboarded: 'ผู้สูงวัยขึ้นรถเรียบร้อยแล้ว',
  trip_started: 'เริ่มเดินทางแล้ว',
  service_started: 'เริ่มให้บริการแล้ว',
  patient_checked_in: 'เช็กอินที่สถานที่นัดหมายแล้ว',
  consultation_started: 'อยู่ระหว่างพบแพทย์/รับบริการ',
  lab_or_xray: 'อยู่ระหว่างขั้นตอนแล็บหรือเอกซเรย์',
  pharmacy_completed: 'ขั้นตอนรับยาเสร็จแล้ว',
  home_check_in: 'ผู้ช่วยดูแลเช็กอินที่บ้านแล้ว',
  midpoint_update: 'มีอัปเดตระหว่างงาน',
  home_check_out: 'ผู้ช่วยดูแลเช็กเอาต์จากงานที่บ้านแล้ว',
  coordination_started: 'เริ่มประสานงานทางการแพทย์แล้ว',
  coordination_update: 'มีอัปเดตการประสานงาน',
  coordination_completed: 'ประสานงานเสร็จแล้ว',
  monitoring_started: 'เริ่มติดตามสถานะครอบครัวแล้ว',
  monitoring_completed: 'ติดตามสถานะเสร็จแล้ว',
  family_update: 'มีอัปเดตถึงครอบครัว',
  visit_summary_submitted: 'ทีมส่งสรุปการดูแลแล้ว',
  summary_approved: 'สรุปหลังจบงานพร้อมให้ครอบครัวดูแล้ว',
  trip_arrived_dropoff: 'ทีมถึงจุดส่งแล้ว',
  trip_handover_completed: 'ส่งมอบและ handover เสร็จแล้ว',
  trip_completed: 'เดินทางเสร็จแล้ว',
  service_completed: 'บริการเสร็จสมบูรณ์',
  quality_review_created: 'เปิดเคสติดตามคุณภาพบริการแล้ว'
};

function messageText(notification = {}, context = {}) {
  const payload = notification.payload || {};
  const bookingNo = payload.booking_no || context.booking?.booking_no || '-';
  const type = notification.notification_type || 'notification';
  const statusUrl = payload.absolute_status_url || payload.status_url || payload.rating_url || '';
  const amount = payload.amount ? `\nAmount: ${payload.amount}` : '';
  const summary = payload.family_summary || payload.message || payload.notes || '';
  const summaryLine = summary ? `\nรายละเอียด: ${String(summary).slice(0, 180)}` : '';
  const link = statusUrl ? `\nดูสถานะ: ${statusUrl}` : '';
  const title = TYPE_MESSAGES[type] || 'มีการอัปเดตจากทีม ElderCare';
  return `SandyCare\nBooking: ${bookingNo}\n${title}${summaryLine}${amount}${link}`;
}

async function sendLinePush({ to, text }) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to,
      messages: [{ type: 'text', text }]
    })
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`LINE push failed: ${response.status}`);
    error.statusCode = 502;
    error.code = 'LINE_PUSH_FAILED';
    error.details = { status: response.status, body: body.slice(0, 500) };
    throw error;
  }
  return {
    provider: 'line',
    provider_status: 'sent',
    provider_response: body ? body.slice(0, 500) : null
  };
}

async function deliverNotification({ notification, context = {}, forceMock = false }) {
  const now = new Date().toISOString();
  const to = lineRecipient(context, notification);
  const text = messageText(notification, context);

  if (forceMock || !configured()) {
    return {
      status: 'sent',
      sent_at: now,
      payload: {
        ...(notification.payload || {}),
        provider: configured() ? 'line_mock' : 'line_mock_no_token',
        mock_delivery_id: `LINE-MOCK-${Date.now()}`,
        mock_message: text,
        mock_delivered_at: now
      }
    };
  }

  if (!to) {
    return {
      status: 'failed',
      sent_at: null,
      payload: {
        ...(notification.payload || {}),
        provider: 'line',
        provider_status: 'failed',
        provider_error: 'LINE recipient id is missing',
        failed_at: now
      }
    };
  }

  const result = await sendLinePush({ to, text });
  return {
    status: 'sent',
    sent_at: now,
    payload: {
      ...(notification.payload || {}),
      ...result,
      line_user_id: to,
      delivered_at: now
    }
  };
}

module.exports = {
  configured,
  deliverNotification,
  lineRecipient,
  messageText
};
