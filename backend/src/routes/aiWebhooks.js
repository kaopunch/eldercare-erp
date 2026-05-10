const express = require('express');
const { getSupabase } = require('../db/supabase');
const { publishRealtimeEvent } = require('../lib/aiEventBus');
const { classifyWithAi } = require('../lib/aiAnalysisProvider');
const {
  buildConversationInsert,
  buildTaskInsert,
  buildVerificationCheckRows
} = require('../lib/aiRealtime');
const {
  assertWebhookAuthorized,
  normalizeInboundMessages
} = require('../lib/aiChannels');

const router = express.Router();

async function insertAuditLog(sb, { action, entityType, entityId = null, payload = {} }) {
  const { error } = await sb.from('audit_logs').insert({
    action,
    entity_type: entityType,
    entity_id: entityId,
    payload
  });
  if (error) throw error;
}

async function insertRealtimeEvent(sb, {
  bookingId = null,
  conversationId = null,
  taskId = null,
  eventType,
  payload = {}
}) {
  const { data, error } = await sb.from('realtime_events').insert({
    booking_id: bookingId,
    conversation_id: conversationId,
    task_id: taskId,
    actor_role: 'external_webhook',
    event_type: eventType,
    event_payload: payload
  }).select('*').single();
  if (error) throw error;
  publishRealtimeEvent(data);
  return data;
}

async function createAiOpsRecords(sb, inbound) {
  const analysis = await classifyWithAi(inbound);
  const conversationInput = {
    ...inbound,
    payload: {
      ...(inbound.payload || {}),
      ai_analysis_source: analysis.analysis_source,
      ai_analysis_error: analysis.analysis_error || null
    }
  };
  const conversationWrite = await sb.from('ai_conversations')
    .insert(buildConversationInsert(conversationInput, analysis.classification, null))
    .select('*')
    .single();
  if (conversationWrite.error) throw conversationWrite.error;
  const conversation = conversationWrite.data;

  let task = null;
  let verificationChecks = [];
  if (analysis.classification.requires_human_review) {
    const taskWrite = await sb.from('ai_admin_tasks')
      .insert(buildTaskInsert(conversationInput, conversation, analysis.classification, null))
      .select('*')
      .single();
    if (taskWrite.error) throw taskWrite.error;
    task = taskWrite.data;

    const checksWrite = await sb.from('verification_checks')
      .insert(buildVerificationCheckRows({
        taskId: task.id,
        conversationId: conversation.id,
        bookingId: conversation.booking_id
      }))
      .select('*');
    if (checksWrite.error) throw checksWrite.error;
    verificationChecks = checksWrite.data || [];
  }

  const realtimeEvent = await insertRealtimeEvent(sb, {
    bookingId: conversation.booking_id,
    conversationId: conversation.id,
    taskId: task?.id || null,
    eventType: 'ai_inbound_message_received',
    payload: {
      source_channel: conversation.source_channel,
      intent: conversation.intent,
      confidence: conversation.confidence,
      risk_level: conversation.risk_level,
      analysis_source: analysis.analysis_source
    }
  });

  await insertAuditLog(sb, {
    action: 'ai_inbound_webhook_received',
    entityType: 'ai_conversation',
    entityId: conversation.id,
    payload: {
      conversation_id: conversation.id,
      task_id: task?.id || null,
      realtime_event_id: realtimeEvent.id,
      source_channel: conversation.source_channel,
      provider_message_id: inbound.payload?.provider_message_id || null,
      analysis_source: analysis.analysis_source
    }
  });

  return {
    conversation,
    task,
    verification_checks: verificationChecks,
    realtime_event: realtimeEvent,
    classification: analysis.classification
  };
}

async function handleInbound(req, res, next) {
  try {
    const auth = assertWebhookAuthorized(req);
    const channel = req.params.channel || req.body?.channel || req.body?.source_channel || 'in_app';
    const inboundMessages = normalizeInboundMessages(channel, req.body || {});
    if (!inboundMessages.length) {
      return res.status(202).json({
        ok: true,
        accepted: 0,
        ignored: true,
        reason: 'no_supported_text_message',
        webhook_secret_configured: auth.configured
      });
    }

    const sb = getSupabase();
    const records = [];
    for (const inbound of inboundMessages) {
      records.push(await createAiOpsRecords(sb, inbound));
    }

    return res.status(201).json({
      ok: true,
      accepted: records.length,
      webhook_secret_configured: auth.configured,
      conversations: records.map((record) => record.conversation),
      tasks: records.map((record) => record.task).filter(Boolean),
      realtime_events: records.map((record) => record.realtime_event)
    });
  } catch (e) {
    return next(e);
  }
}

router.post('/', handleInbound);
router.post('/:channel', handleInbound);

module.exports = router;
