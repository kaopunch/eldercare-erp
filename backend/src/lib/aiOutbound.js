const { deliverNotification: deliverLineNotification } = require('./line');

const APPROVED_TASK_STATES = new Set(['approved', 'completed', 'not_required']);
const DELIVERY_FINAL_STATUSES = new Set(['sent', 'failed', 'read']);

function outboundGatewayUrl() {
  return process.env.ELDERCARE_OUTBOUND_DELIVERY_URL || process.env.OUTBOUND_DELIVERY_WEBHOOK_URL || '';
}

function outboundGatewaySecret() {
  return process.env.ELDERCARE_OUTBOUND_DELIVERY_SECRET || process.env.OUTBOUND_DELIVERY_WEBHOOK_SECRET || '';
}

function outboundGatewayConfigured() {
  return Boolean(outboundGatewayUrl());
}

function assertTaskReadyForOutbound(task = {}, { force = false } = {}) {
  if (force) return true;
  if (APPROVED_TASK_STATES.has(task.approval_status)) return true;
  const error = new Error('AI task must be approved before outbound notifications are sent');
  error.statusCode = 409;
  error.code = 'AI_TASK_APPROVAL_REQUIRED';
  error.details = {
    task_id: task.id || null,
    approval_status: task.approval_status || null
  };
  throw error;
}

function recipientLabel(recipient = {}) {
  return recipient.recipient_role || recipient.role || 'recipient';
}

function notificationMessage(notification = {}, booking = {}) {
  const payload = notification.payload || {};
  const bookingNo = payload.booking_no || booking.booking_no || '-';
  const serviceType = payload.service_type || booking.service_type || '-';
  const pickupAt = payload.pickup_at || booking.pickup_at || '-';
  const message = payload.message || payload.summary || 'AI verified update';
  return [
    'ElderCare ERP',
    `Booking: ${bookingNo}`,
    `Service: ${serviceType}`,
    `Pickup: ${pickupAt}`,
    `Message: ${message}`
  ].join('\n');
}

async function deliverViaGateway({ notification, booking, recipient }) {
  const headers = { 'Content-Type': 'application/json' };
  const secret = outboundGatewaySecret();
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const response = await fetch(outboundGatewayUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      notification,
      booking,
      recipient,
      message: notificationMessage(notification, booking)
    })
  });
  const body = await response.text();
  if (!response.ok) {
    return {
      status: 'failed',
      sent_at: null,
      payload: {
        ...(notification.payload || {}),
        provider: 'outbound_gateway',
        provider_status: 'failed',
        provider_error: `Outbound gateway failed: ${response.status}`,
        provider_response: body.slice(0, 500),
        failed_at: new Date().toISOString()
      }
    };
  }

  let parsed = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch (error) {
    parsed = { raw_response: body.slice(0, 500) };
  }

  const now = new Date().toISOString();
  const status = DELIVERY_FINAL_STATUSES.has(parsed.status) ? parsed.status : 'sent';
  return {
    status,
    sent_at: status === 'failed' ? null : now,
    payload: {
      ...(notification.payload || {}),
      provider: parsed.provider || 'outbound_gateway',
      provider_status: parsed.provider_status || status,
      provider_message_id: parsed.provider_message_id || parsed.id || null,
      provider_response: parsed.provider_response || parsed.raw_response || null,
      delivered_at: status === 'sent' ? now : null
    }
  };
}

function mockOrQueuedDelivery({ notification, booking, recipient, forceMock = false }) {
  const channel = notification.channel || 'in_app';
  const now = new Date().toISOString();
  if (channel === 'in_app' || forceMock) {
    return {
      status: 'sent',
      sent_at: now,
      payload: {
        ...(notification.payload || {}),
        provider: forceMock ? `${channel}_mock` : 'in_app',
        mock_delivery_id: `${channel.toUpperCase()}-MOCK-${Date.now()}`,
        mock_message: notificationMessage(notification, booking),
        mock_recipient_role: recipientLabel(recipient),
        delivered_at: now
      }
    };
  }

  return {
    status: 'queued',
    sent_at: null,
    payload: {
      ...(notification.payload || {}),
      provider: `${channel}_not_configured`,
      delivery_required: true,
      delivery_message: notificationMessage(notification, booking),
      delivery_hint: 'Configure LINE credentials or ELDERCARE_OUTBOUND_DELIVERY_URL for this channel.'
    }
  };
}

async function deliverAiNotification({ notification, booking = {}, recipient = {}, forceMock = false }) {
  const channel = notification.channel || 'in_app';
  if (channel === 'line') {
    return deliverLineNotification({
      notification,
      context: { booking, recipient },
      forceMock
    });
  }

  if (!forceMock && channel !== 'in_app' && outboundGatewayConfigured()) {
    return deliverViaGateway({ notification, booking, recipient });
  }

  return mockOrQueuedDelivery({ notification, booking, recipient, forceMock });
}

function presenceStatusForDelivery(notification = {}) {
  if (notification.status === 'sent') return 'pendingConfirm';
  if (notification.status === 'read') return 'acknowledged';
  if (notification.status === 'failed') return 'needs_followup';
  return 'pending';
}

function buildPresenceRow({ task, recipient = {}, notification = {}, event = null, now = new Date().toISOString() }) {
  return {
    booking_id: task.booking_id || notification.booking_id || null,
    party_role: recipient.recipient_role || notification.payload?.recipient_role || 'recipient',
    party_name: recipient.party_name || recipient.name || null,
    channel: notification.channel || recipient.channel || 'in_app',
    recipient_user_id: notification.recipient_user_id || recipient.recipient_user_id || null,
    status: presenceStatusForDelivery(notification),
    last_seen_at: now,
    last_acknowledged_event_id: event?.id || null,
    acknowledged_at: notification.status === 'read' ? now : null,
    payload: {
      notification_id: notification.id || null,
      task_id: task.id || null,
      delivery_status: notification.status || 'queued'
    },
    updated_at: now
  };
}

function deliverySummary(notifications = []) {
  return notifications.reduce((memo, notification) => {
    const status = notification.status || 'queued';
    memo.total += 1;
    memo[status] = (memo[status] || 0) + 1;
    return memo;
  }, { total: 0, queued: 0, sent: 0, failed: 0, read: 0 });
}

module.exports = {
  APPROVED_TASK_STATES,
  assertTaskReadyForOutbound,
  buildPresenceRow,
  deliverAiNotification,
  deliverySummary,
  mockOrQueuedDelivery,
  notificationMessage,
  outboundGatewayConfigured,
  presenceStatusForDelivery
};
