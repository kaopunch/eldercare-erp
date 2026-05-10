const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertTaskReadyForOutbound,
  buildPresenceRow,
  deliverySummary,
  mockOrQueuedDelivery,
  presenceStatusForDelivery
} = require('../src/lib/aiOutbound');

test('blocks outbound delivery until AI task is approved', () => {
  assert.throws(() => assertTaskReadyForOutbound({
    id: 'task-1',
    approval_status: 'pending'
  }), /approved/);
  assert.equal(assertTaskReadyForOutbound({ approval_status: 'approved' }), true);
  assert.equal(assertTaskReadyForOutbound({ approval_status: 'pending' }, { force: true }), true);
});

test('maps notification delivery status to party presence', () => {
  assert.equal(presenceStatusForDelivery({ status: 'sent' }), 'pendingConfirm');
  assert.equal(presenceStatusForDelivery({ status: 'read' }), 'acknowledged');
  assert.equal(presenceStatusForDelivery({ status: 'failed' }), 'needs_followup');
  assert.equal(presenceStatusForDelivery({ status: 'queued' }), 'pending');
});

test('builds presence row from delivered notification', () => {
  const row = buildPresenceRow({
    task: { id: 'task-1', booking_id: 'booking-1' },
    recipient: { recipient_role: 'driver', recipient_user_id: 'driver-user' },
    notification: {
      id: 'notification-1',
      channel: 'in_app',
      recipient_user_id: 'driver-user',
      status: 'sent',
      payload: {}
    },
    event: { id: 'event-1' },
    now: '2026-05-07T00:00:00.000Z'
  });

  assert.equal(row.booking_id, 'booking-1');
  assert.equal(row.party_role, 'driver');
  assert.equal(row.status, 'pendingConfirm');
  assert.equal(row.last_acknowledged_event_id, 'event-1');
});

test('summarizes outbound notification delivery states', () => {
  assert.deepEqual(deliverySummary([
    { status: 'sent' },
    { status: 'queued' },
    { status: 'failed' }
  ]), { total: 3, queued: 1, sent: 1, failed: 1, read: 0 });
});

test('keeps unconfigured non-app channels queued unless forced mock', () => {
  const queued = mockOrQueuedDelivery({
    notification: { channel: 'whatsapp', payload: { booking_no: 'BK-1' } },
    booking: {},
    recipient: {}
  });
  const mocked = mockOrQueuedDelivery({
    notification: { channel: 'whatsapp', payload: { booking_no: 'BK-1' } },
    booking: {},
    recipient: {},
    forceMock: true
  });

  assert.equal(queued.status, 'queued');
  assert.equal(queued.payload.delivery_required, true);
  assert.equal(mocked.status, 'sent');
});
