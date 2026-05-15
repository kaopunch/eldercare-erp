const CUSTOMER_FAMILY_AUDIENCE = 'customer_family';

function buildBookingPayload(booking = {}, payload = {}) {
  const bookingNo = booking.booking_no || payload.booking_no || null;
  const elderId = booking.elder_id || payload.elder_id || null;
  return {
    booking_no: bookingNo,
    service_type: booking.service_type || payload.service_type || null,
    pickup_at: booking.pickup_at || payload.pickup_at || null,
    status_url: payload.status_url || (bookingNo ? `/portal/status/${bookingNo}` : null),
    rating_url: payload.rating_url || (bookingNo ? `/portal/rating/${bookingNo}` : null),
    consent_url: payload.consent_url || (elderId ? `/portal/consent/${elderId}` : null),
    customer_visible: payload.customer_visible !== false,
    ...payload
  };
}

async function queueNotification(sb, {
  booking = null,
  bookingId = null,
  assignmentId = null,
  recipientUserId = null,
  channel = 'in_app',
  type,
  payload = {}
}) {
  if (!type) {
    const error = new Error('notification type is required');
    error.statusCode = 422;
    error.code = 'NOTIFICATION_TYPE_REQUIRED';
    throw error;
  }

  const { error } = await sb.from('notifications').insert({
    booking_id: bookingId || booking?.id || null,
    assignment_id: assignmentId || null,
    recipient_user_id: recipientUserId || null,
    channel,
    notification_type: type,
    payload: buildBookingPayload(booking || {}, payload)
  });
  if (error) throw error;
}

async function queueCustomerNotification(sb, booking, type, payload = {}) {
  await queueNotification(sb, {
    booking,
    channel: payload.delivery_channel || 'line',
    type,
    payload: {
      audience: CUSTOMER_FAMILY_AUDIENCE,
      ...payload
    }
  });
}

module.exports = {
  CUSTOMER_FAMILY_AUDIENCE,
  queueNotification,
  queueCustomerNotification
};
