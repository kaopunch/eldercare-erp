const DEFAULT_VERIFICATION_CHECKS = Object.freeze([
  'identity',
  'consent',
  'route',
  'medical',
  'driver',
  'audit'
]);

const ACTIONABLE_INTENTS = new Set([
  'create_booking',
  'reschedule',
  'route_confirm',
  'route_change',
  'cancel_booking',
  'complaint',
  'incident',
  'medical_warning',
  'driver_update',
  'assignment_change'
]);

const HIGH_RISK_INTENTS = new Set([
  'create_booking',
  'reschedule',
  'route_change',
  'cancel_booking',
  'complaint',
  'incident',
  'assignment_change'
]);

const CRITICAL_INTENTS = new Set([
  'medical_warning',
  'emergency',
  'critical_incident',
  'safety_risk'
]);

const MEDICAL_WARNING_KEYWORDS = [
  'emergency',
  'urgent',
  'ambulance',
  'hospital now',
  'fall',
  'fainted',
  'chest pain',
  'หกล้ม',
  'หมดสติ',
  'เจ็บหน้าอก',
  'ฉุกเฉิน',
  'รถพยาบาล',
  'เลือด',
  '呼吸',
  '救急',
  '緊急',
  'ဆေးရုံ',
  'အရေးပေါ်'
];

function parseLimit(value, fallback = 50, max = 200) {
  const limit = Number(value || fallback);
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.round(limit), 1), max);
}

function normalizeKey(value, fallback = 'unknown') {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || fallback;
}

function normalizeChannel(value) {
  const channel = normalizeKey(value, 'in_app');
  const aliases = {
    webchat: 'web_chat',
    web: 'web_chat',
    phone_call: 'phone',
    call: 'phone'
  };
  return aliases[channel] || channel;
}

function normalizeIntent(value) {
  const intent = normalizeKey(value, 'unknown');
  const aliases = {
    booking_create: 'create_booking',
    change_route: 'route_change',
    confirm_route: 'route_confirm',
    medical: 'medical_warning',
    safety: 'safety_risk'
  };
  return aliases[intent] || intent;
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const normalized = parsed > 10 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.min(Math.max(normalized, 0), 1);
}

function includesAny(text, keywords) {
  const source = String(text || '').toLowerCase();
  return keywords.some((keyword) => source.includes(keyword.toLowerCase()));
}

function classifyConversation(input = {}) {
  const intent = normalizeIntent(input.intent || input.detected_intent);
  const confidence = normalizeConfidence(
    input.confidence ?? input.confidence_score ?? input.ai_confidence
  );
  const sourceText = [
    intent,
    input.transcript,
    input.message,
    input.summary,
    input.description
  ].filter(Boolean).join(' ');

  const reasons = [];
  let riskLevel = 'low';

  if (CRITICAL_INTENTS.has(intent) || includesAny(sourceText, MEDICAL_WARNING_KEYWORDS)) {
    riskLevel = 'critical';
    reasons.push('medical_or_safety_signal');
  } else if (confidence < 0.45) {
    riskLevel = 'high';
    reasons.push('very_low_confidence');
  } else if (HIGH_RISK_INTENTS.has(intent)) {
    riskLevel = confidence < 0.75 ? 'high' : 'medium';
    reasons.push('operational_change_intent');
  } else if (confidence < 0.75) {
    riskLevel = 'medium';
    reasons.push('low_confidence');
  }

  const requiresHumanReview = Boolean(
    input.force_human_review ||
    riskLevel !== 'low' ||
    confidence < 0.85 ||
    ACTIONABLE_INTENTS.has(intent)
  );

  return {
    intent,
    confidence,
    risk_level: riskLevel,
    requires_human_review: requiresHumanReview,
    approval_mode: riskLevel === 'low' && confidence >= 0.85 ? 'one_click' : 'manual_review',
    reasons
  };
}

function buildConversationInsert(input = {}, classification, actorUserId = null) {
  const transcript = input.transcript || input.message || input.body || '';
  const contactRole = input.contact_role || input.caller_role || null;
  const contactName = input.contact_name || input.caller_name || null;
  const contactPhone = input.contact_phone || input.caller_phone || input.phone || null;
  const payload = {
    ...(input.payload || {}),
    contact_role: contactRole,
    contact_name: contactName,
    contact_phone: contactPhone,
    language: input.language || null,
    direction: input.direction || 'inbound',
    actor_user_id: actorUserId || null,
    classification_reasons: classification.reasons
  };

  return {
    booking_id: input.booking_id || null,
    customer_id: input.customer_id || null,
    elder_id: input.elder_id || null,
    source_channel: normalizeChannel(input.source_channel || input.channel),
    caller_name: contactName,
    caller_phone: contactPhone,
    caller_line_id: input.caller_line_id || input.line_id || null,
    caller_email: input.caller_email || input.email || null,
    contact_role: contactRole,
    contact_user_id: input.contact_user_id || null,
    transcript,
    intent: classification.intent,
    confidence: classification.confidence,
    summary: input.summary || transcript.slice(0, 240) || 'AI conversation captured',
    risk_level: classification.risk_level,
    status: classification.requires_human_review ? 'needs_review' : 'auto_resolved',
    created_by: actorUserId,
    payload
  };
}

function buildTaskInsert(input = {}, conversation, classification, actorUserId = null) {
  const taskType = classification.intent === 'unknown' ? 'admin_review' : classification.intent;
  const summary = input.task_summary || input.summary || conversation.summary;
  return {
    conversation_id: conversation.id,
    booking_id: conversation.booking_id || input.booking_id || null,
    task_type: taskType,
    title: input.task_title || `AI review: ${taskType.replace(/_/g, ' ')}`,
    summary,
    risk_level: classification.risk_level,
    required_checks: [...DEFAULT_VERIFICATION_CHECKS],
    approval_status: 'pending',
    status: 'open',
    assigned_to: input.assigned_to || input.owner_user_id || actorUserId || null,
    payload: {
      ...(input.task_payload || {}),
      approval_mode: classification.approval_mode,
      confidence: classification.confidence,
      intent: classification.intent,
      source_channel: conversation.source_channel,
      actor_user_id: actorUserId || null
    }
  };
}

function buildVerificationCheckRows({ taskId, conversationId, bookingId }) {
  return DEFAULT_VERIFICATION_CHECKS.map((checkType, index) => ({
    task_id: taskId,
    conversation_id: conversationId,
    booking_id: bookingId || null,
    check_type: checkType,
    status: 'pending',
    evidence: {
      required: true,
      sequence_no: index + 1
    }
  }));
}

function normalizeCheckStatus(value) {
  if (value === true) return 'approved';
  if (value === false) return 'rejected';
  const status = normalizeKey(value, 'approved');
  if (['approved', 'passed', 'ok', 'verified'].includes(status)) return 'approved';
  if (['rejected', 'failed', 'blocked'].includes(status)) return 'rejected';
  if (['pending', 'open'].includes(status)) return 'pending';
  return status;
}

function normalizeCheckUpdates(checks, fallbackCheckTypes = DEFAULT_VERIFICATION_CHECKS) {
  if (!checks) {
    return fallbackCheckTypes.map((checkType) => ({
      check_type: checkType,
      status: 'approved',
      evidence: {},
      notes: null
    }));
  }

  if (Array.isArray(checks)) {
    return checks.map((item) => ({
      id: item.id || null,
      check_type: normalizeKey(item.check_type || item.type || item.name),
      status: normalizeCheckStatus(item.status ?? item.approved ?? true),
      evidence: item.evidence || item.payload || {},
      notes: item.notes || null
    })).filter((item) => item.check_type !== 'unknown' || item.id);
  }

  return Object.entries(checks).map(([checkType, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        id: value.id || null,
        check_type: normalizeKey(value.check_type || checkType),
        status: normalizeCheckStatus(value.status ?? value.approved ?? true),
        evidence: value.evidence || value.payload || {},
        notes: value.notes || null
      };
    }
    return {
      id: null,
      check_type: normalizeKey(checkType),
      status: normalizeCheckStatus(value),
      evidence: {},
      notes: null
    };
  });
}

function areAllChecksApproved(checks = []) {
  return checks.length > 0 && checks.every((check) => normalizeCheckStatus(check.status) === 'approved');
}

function hasRejectedCheck(checks = []) {
  return checks.some((check) => normalizeCheckStatus(check.status) === 'rejected');
}

function buildNotificationPayload({ booking = null, task = null, recipient = {}, body = {} }) {
  const taskPayload = task?.payload || {};
  return {
    booking_no: booking?.booking_no || body.booking_no || null,
    service_type: booking?.service_type || body.service_type || null,
    pickup_at: booking?.pickup_at || body.pickup_at || null,
    task_id: task?.id || null,
    conversation_id: task?.conversation_id || null,
    recipient_role: recipient.recipient_role || recipient.role || null,
    message_template: recipient.message_template || body.message_template || 'ai_verified_update',
    message: recipient.message || body.message || task?.summary || taskPayload.summary || null,
    source_of_truth: {
      booking_id: task?.booking_id || booking?.id || null,
      task_type: task?.task_type || null,
      approval_status: task?.approval_status || null,
      risk_level: task?.risk_level || null
    },
    ...(recipient.payload || {})
  };
}

module.exports = {
  DEFAULT_VERIFICATION_CHECKS,
  areAllChecksApproved,
  buildConversationInsert,
  buildNotificationPayload,
  buildTaskInsert,
  buildVerificationCheckRows,
  classifyConversation,
  hasRejectedCheck,
  normalizeChannel,
  normalizeCheckStatus,
  normalizeCheckUpdates,
  normalizeConfidence,
  normalizeIntent,
  parseLimit
};
