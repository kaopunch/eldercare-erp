const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildOperationsHealth,
  needsVisitSummaryApproval
} = require('../src/lib/operationsHealth');

const now = new Date('2026-06-08T06:00:00.000Z');

test('flags companion bookings that still need approved visit summaries', () => {
  assert.equal(needsVisitSummaryApproval({
    service_type: 'hospital_companion',
    visit_summaries: []
  }), true);
  assert.equal(needsVisitSummaryApproval({
    service_type: 'hospital_companion',
    visit_summaries: [{ status: 'approved' }]
  }), false);
  assert.equal(needsVisitSummaryApproval({
    service_type: 'basic_ride',
    visit_summaries: []
  }), false);
});

test('builds operations health actions from incidents, notifications, summaries, and payments', () => {
  const health = buildOperationsHealth({
    now,
    bookings: [
      {
        id: 'booking-1',
        booking_no: 'BK-1',
        status: 'confirmed',
        risk_level: 'high',
        service_type: 'hospital_companion',
        pickup_at: '2026-06-08T12:00:00.000Z',
        quoted_price: 3200,
        payment_status: 'deposit_paid',
        visit_summaries: []
      },
      {
        id: 'booking-2',
        booking_no: 'BK-2',
        status: 'completed',
        risk_level: 'low',
        service_type: 'basic_ride',
        pickup_at: '2026-06-07T12:00:00.000Z',
        final_price: 900,
        payment_status: 'paid',
        visit_summaries: []
      }
    ],
    incidents: [
      { id: 'incident-1', booking_id: 'booking-1', severity: 'critical', status: 'open' }
    ],
    notifications: [
      { id: 'notification-1', status: 'failed' }
    ],
    realtimeEvents: [
      { id: 'event-1', delivery_status: 'failed' }
    ],
    aiTasks: [
      { id: 'task-1', approval_status: 'needs_review' }
    ]
  });

  assert.equal(health.status, 'critical');
  assert.equal(health.summary.open_severe_incidents, 1);
  assert.equal(health.summary.failed_notifications, 2);
  assert.equal(health.summary.pending_visit_summaries, 1);
  assert.equal(health.summary.pending_ai_approvals, 1);
  assert.equal(health.summary.payment_followups, 1);
  assert.equal(health.watchlists.stuck_bookings[0].booking_no, 'BK-1');
});
