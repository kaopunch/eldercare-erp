const CUSTOMER_FAMILY_AUDIENCE = 'customer_family';

function buildBookingPayload(booking = {}, payload = {}) {
  return {
    booking_no: booking.booking_no || payload.booking_no || null,
    service_type: booking.service_type || payload.service_type || null,
    pickup_at: booking.pickup_at || payload.pickup_at || null,
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
