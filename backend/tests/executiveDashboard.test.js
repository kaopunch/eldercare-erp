const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bookingProgress,
  buildExecutiveDashboard,
  normalizeExecutiveStatus
} = require('../src/lib/executiveDashboard');
const {
  eventVisibleToActor,
  recipientRoles
} = require('../src/lib/aiVisibility');

test('normalizes executive statuses and calculates progress', () => {
  assert.equal(normalizeExecutiveStatus('assigned', 'critical'), 'monitor');
  assert.equal(normalizeExecutiveStatus('confirmed', 'low'), 'confirmed');
  assert.equal(bookingProgress({
    status: 'in_progress',
    trip_events: [
      { event_type: 'arrived_pickup' },
      { event_type: 'elder_onboard' },
      { event_type: 'trip_started' }
    ],
    trip_checklists: [{ checklist_type: 'pre_trip', completed: true }]
  }), 63);
});

test('builds executive dashboard with alerts and AI counters', () => {
  const dashboard = buildExecutiveDashboard({
    bookings: [{
      id: 'booking-1',
      booking_no: 'BK-1',
      status: 'confirmed',
      risk_level: 'high',
      need_care_assistant: true,
      customers: { full_name: 'Customer' },
      elders: { full_name: 'Elder' },
      assignments: []
    }],
    incidents: [{ booking_id: 'booking-1', status: 'open', severity: 'critical' }],
    aiTasks: [{ booking_id: 'booking-1', approval_status: 'pending', risk_level: 'high' }],
    verificationChecks: [{ booking_id: 'booking-1', status: 'pending' }],
    realtimeEvents: [{ id: 'event-1' }]
  });

  assert.equal(dashboard.summary.total_jobs, 1);
  assert.equal(dashboard.summary.need_attention, 1);
  assert.equal(dashboard.summary.critical_alerts > 0, true);
  assert.equal(dashboard.ai.open_tasks, 1);
  assert.equal(dashboard.ai.pending_checks, 1);
  assert.equal(dashboard.jobs[0].alert_count >= 4, true);
});

test('filters realtime events by recipient role and assigned actor context', () => {
  assert.deepEqual(recipientRoles({ event_payload: { recipient_roles: ['driver', 'admin'] } }), ['driver', 'admin']);
  assert.equal(eventVisibleToActor(
    { event_payload: { recipient_role: 'driver' } },
    { role: 'driver', id: 'driver-user' }
  ), true);
  assert.equal(eventVisibleToActor(
    { event_payload: { recipient_role: 'care_assistant' } },
    { role: 'driver', id: 'driver-user' }
  ), false);
  assert.equal(eventVisibleToActor(
    { booking_id: 'booking-1', event_payload: { recipient_role: 'contractor' } },
    { role: 'care_assistant', id: 'care-user' },
    { bookingIds: new Set(['booking-1']) }
  ), true);
});
