const test = require('node:test');
const assert = require('node:assert/strict');
const {
  publishRealtimeEvent,
  subscribeRealtimeEvents
} = require('../src/lib/aiEventBus');

const {
  DEFAULT_VERIFICATION_CHECKS,
  areAllChecksApproved,
  buildConversationInsert,
  buildTaskInsert,
  buildVerificationCheckRows,
  classifyConversation,
  normalizeCheckUpdates,
  normalizeConfidence,
  parseLimit
} = require('../src/lib/aiRealtime');

test('classifies medical and safety language as critical with human review', () => {
  const result = classifyConversation({
    intent: 'status_check',
    confidence: 0.98,
    transcript: 'ญาติแจ้งว่าผู้สูงวัยหกล้มและเจ็บหน้าอก ต้องการความช่วยเหลือด่วน'
  });

  assert.equal(result.risk_level, 'critical');
  assert.equal(result.requires_human_review, true);
  assert.equal(result.reasons.includes('medical_or_safety_signal'), true);
});

test('low confidence operational changes require manual review', () => {
  const result = classifyConversation({
    intent: 'reschedule',
    confidence: 0.52,
    transcript: 'ขอเลื่อนเวลารับผู้สูงวัย'
  });

  assert.equal(result.risk_level, 'high');
  assert.equal(result.requires_human_review, true);
  assert.equal(result.approval_mode, 'manual_review');
});

test('high confidence status checks can auto resolve', () => {
  const result = classifyConversation({
    intent: 'status_check',
    confidence: 0.96,
    transcript: 'สอบถามสถานะรถ'
  });

  assert.equal(result.risk_level, 'low');
  assert.equal(result.requires_human_review, false);
  assert.equal(result.approval_mode, 'one_click');
});

test('builds default six verification checks for a task', () => {
  const rows = buildVerificationCheckRows({
    taskId: 'task-1',
    conversationId: 'conversation-1',
    bookingId: 'booking-1'
  });

  assert.deepEqual(rows.map((row) => row.check_type), DEFAULT_VERIFICATION_CHECKS);
  assert.equal(rows.every((row) => row.status === 'pending'), true);
  assert.equal(rows[0].evidence.sequence_no, 1);
});

test('builds conversation and task rows with contact and owner metadata', () => {
  const classification = classifyConversation({
    intent: 'route_confirm',
    confidence: 0.94,
    transcript: 'ขอยืนยันคนขับและ ETA'
  });
  const conversation = buildConversationInsert({
    source_channel: 'call',
    caller_name: 'คุณพลอย',
    caller_role: 'employer',
    caller_phone: '0810000000',
    transcript: 'ขอยืนยันคนขับและ ETA'
  }, classification, 'actor-1');

  assert.equal(conversation.source_channel, 'phone');
  assert.equal(conversation.caller_name, 'คุณพลอย');
  assert.equal(conversation.contact_role, 'employer');
  assert.equal(conversation.created_by, 'actor-1');
  assert.equal(conversation.payload.contact_name, 'คุณพลอย');

  const task = buildTaskInsert({}, { ...conversation, id: 'conversation-1' }, classification, 'actor-1');
  assert.equal(task.assigned_to, 'actor-1');
  assert.equal(task.status, 'open');
  assert.equal(task.required_checks.length, DEFAULT_VERIFICATION_CHECKS.length);
});

test('normalizes verification updates from object and array shapes', () => {
  assert.deepEqual(normalizeCheckUpdates({ identity: true, consent: false }).map((row) => ({
    check_type: row.check_type,
    status: row.status
  })), [
    { check_type: 'identity', status: 'approved' },
    { check_type: 'consent', status: 'rejected' }
  ]);

  assert.deepEqual(normalizeCheckUpdates([
    { check_type: 'route', status: 'verified', notes: 'route matches booking' }
  ]), [
    {
      id: null,
      check_type: 'route',
      status: 'approved',
      evidence: {},
      notes: 'route matches booking'
    }
  ]);
});

test('approves only when every verification check is approved', () => {
  assert.equal(areAllChecksApproved([
    { status: 'approved' },
    { status: 'verified' }
  ]), true);
  assert.equal(areAllChecksApproved([
    { status: 'approved' },
    { status: 'pending' }
  ]), false);
});

test('normalizes confidence and clamps limits', () => {
  assert.equal(normalizeConfidence(93), 0.93);
  assert.equal(normalizeConfidence(-1), 0);
  assert.equal(normalizeConfidence(1.5), 1);
  assert.equal(parseLimit(500, 50, 100), 100);
  assert.equal(parseLimit('bad', 50, 100), 50);
});

test('publishes realtime AI events to subscribers', () => {
  const received = [];
  const unsubscribe = subscribeRealtimeEvents((event) => received.push(event));
  publishRealtimeEvent({ id: 'event-1', event_type: 'ai_task_verified' });
  unsubscribe();
  publishRealtimeEvent({ id: 'event-2', event_type: 'ai_task_notified' });

  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'event-1');
  assert.equal(received[0].event_type, 'ai_task_verified');
  assert.ok(received[0].streamed_at);
});
