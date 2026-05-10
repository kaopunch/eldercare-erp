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

function messageText(notification = {}, context = {}) {
  const payload = notification.payload || {};
  const bookingNo = payload.booking_no || context.booking?.booking_no || '-';
  const type = notification.notification_type || 'notification';
  const statusUrl = payload.absolute_status_url || payload.status_url || '';
  const amount = payload.amount ? `\nAmount: ${payload.amount}` : '';
  const link = statusUrl ? `\nPortal: ${statusUrl}` : '';
  return `ElderCare ERP\nBooking: ${bookingNo}\nType: ${type}${amount}${link}`;
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
