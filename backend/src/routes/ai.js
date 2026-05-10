const express = require('express');
const { getSupabase } = require('../db/supabase');
const { publishRealtimeEvent, subscribeRealtimeEvents } = require('../lib/aiEventBus');
const { classifyWithAi } = require('../lib/aiAnalysisProvider');
const {
  assertTaskReadyForOutbound,
  buildPresenceRow,
  deliverAiNotification,
  deliverySummary
} = require('../lib/aiOutbound');
const {
  DEFAULT_VERIFICATION_CHECKS,
  areAllChecksApproved,
  buildConversationInsert,
  buildNotificationPayload,
  buildTaskInsert,
  buildVerificationCheckRows,
  hasRejectedCheck,
  normalizeChannel,
  normalizeCheckUpdates,
  parseLimit
} = require('../lib/aiRealtime');

const router = express.Router();

function validationError(message, code, details) {
  const error = new Error(message);
  error.statusCode = 422;
  error.code = code;
  error.details = details;
  return error;
}

function actorUserId(req) {
  return req.actor?.id || req.body?.actor_user_id || null;
}

function actorCompanyId(req) {
  return req.actor?.company_id || req.body?.company_id || null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function isMissingRelationError(error) {
  const message = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /relation .* does not exist/i.test(message)
    || /could not find the table/i.test(message)
    || /schema cache/i.test(message);
}

async function readLatestTable(sb, table, { limit, orderBy = 'created_at', filters = {} }) {
  let query = sb.from(table).select('*').order(orderBy, { ascending: false }).limit(limit);
  for (const [column, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') query = query.eq(column, value);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) return { rows: [], schema_missing: true };
    throw error;
  }
  return { rows: data || [], schema_missing: false };
}

async function insertAuditLog(sb, req, { action, entityType, entityId = null, payload = {}, companyId = null }) {
  const { error } = await sb.from('audit_logs').insert({
    company_id: companyId || actorCompanyId(req),
    actor_user_id: actorUserId(req),
    action,
    entity_type: entityType,
    entity_id: entityId,
    payload
  });
  if (error) throw error;
}

async function insertRealtimeEvent(sb, req, {
  bookingId = null,
  conversationId = null,
  taskId = null,
  recipientRole = null,
  deliveryStatus = 'queued',
  eventType,
  payload = {}
}) {
  const { data, error } = await sb.from('realtime_events').insert({
    booking_id: bookingId,
    conversation_id: conversationId,
    task_id: taskId,
    actor_role: req.actor?.role || null,
    recipient_role: recipientRole,
    event_type: eventType,
    event_payload: {
      ...payload,
      actor_role: req.actor?.role || null
    },
    delivery_status: deliveryStatus,
    actor_user_id: actorUserId(req)
  }).select('*').single();
  if (error) throw error;
  publishRealtimeEvent(data);
  return data;
}

function sendSse(res, event, data = {}) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function getTask(sb, id) {
  if (!isUuid(id)) throw validationError('task id must be a uuid', 'AI_TASK_ID_INVALID');
  const { data, error } = await sb.from('ai_admin_tasks').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function getVerificationChecks(sb, taskId) {
  const { data, error } = await sb.from('verification_checks')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function updatePartyPresence(sb, row) {
  if (!row.booking_id || !row.party_role) return null;
  const { data, error } = await sb.from('party_presence')
    .upsert(row, { onConflict: 'booking_id,party_role,recipient_user_id,channel' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function ensureTaskChecks(sb, task) {
  const existing = await getVerificationChecks(sb, task.id);
  if (existing.length) return existing;

  const rows = buildVerificationCheckRows({
    taskId: task.id,
    conversationId: task.conversation_id,
    bookingId: task.booking_id
  });
  const { data, error } = await sb.from('verification_checks').insert(rows).select('*');
  if (error) throw error;
  return data || [];
}

async function applyVerificationUpdates(sb, task, updates, req) {
  const verifiedAt = new Date().toISOString();
  const updated = [];

  for (const update of updates) {
    const patch = {
      status: update.status,
      notes: update.notes,
      evidence: update.evidence || {},
      verified_by: actorUserId(req),
      verified_at: update.status === 'pending' ? null : verifiedAt
    };

    let result;
    if (update.id) {
      result = await sb.from('verification_checks')
        .update(patch)
        .eq('id', update.id)
        .eq('task_id', task.id)
        .select('*');
    } else {
      result = await sb.from('verification_checks')
        .update(patch)
        .eq('task_id', task.id)
        .eq('check_type', update.check_type)
        .select('*');
    }

    if (result.error) throw result.error;

    if (result.data?.length) {
      updated.push(...result.data);
      continue;
    }

    const insert = await sb.from('verification_checks').insert({
      task_id: task.id,
      conversation_id: task.conversation_id,
      booking_id: task.booking_id,
      check_type: update.check_type,
      ...patch
    }).select('*').single();
    if (insert.error) throw insert.error;
    updated.push(insert.data);
  }

  return updated;
}

async function bookingContext(sb, bookingId) {
  if (!bookingId) return { booking: null, assignment: null };

  const [booking, assignments] = await Promise.all([
    sb.from('bookings')
      .select('id,company_id,booking_no,service_type,pickup_at,status,customer_id,elder_id,customers(full_name,phone,line_id,email),elders(full_name)')
      .eq('id', bookingId)
      .maybeSingle(),
    sb.from('assignments')
      .select('id,booking_id,driver_id,care_assistant_id,status,assigned_at,drivers(id,user_id,full_name,phone,line_id)')
      .eq('booking_id', bookingId)
      .order('assigned_at', { ascending: false })
      .limit(1)
  ]);
  if (booking.error) throw booking.error;
  if (assignments.error) throw assignments.error;

  return {
    booking: booking.data || null,
    assignment: (assignments.data || [])[0] || null
  };
}

function normalizeRecipientInput(item = {}, defaultChannel = 'in_app') {
  return {
    recipient_role: item.recipient_role || item.role || null,
    recipient_user_id: item.recipient_user_id || item.user_id || null,
    channel: normalizeChannel(item.channel || defaultChannel),
    message_template: item.message_template || null,
    message: item.message || null,
    payload: item.payload || {}
  };
}

function resolveRecipients({ body = {}, task, assignment }) {
  const defaultChannel = body.channel || 'in_app';
  if (Array.isArray(body.recipients) && body.recipients.length) {
    return body.recipients.map((item) => normalizeRecipientInput(item, defaultChannel));
  }

  const roles = Array.isArray(body.recipient_roles) && body.recipient_roles.length
    ? body.recipient_roles
    : ['customer', 'driver', 'care_assistant', 'admin'];

  return roles.map((role) => {
    const normalizedRole = String(role || '').trim();
    const recipient = { recipient_role: normalizedRole, channel: normalizeChannel(defaultChannel) };
    if (normalizedRole === 'driver') recipient.recipient_user_id = assignment?.drivers?.user_id || null;
    if (normalizedRole === 'care_assistant') recipient.recipient_user_id = assignment?.care_assistant_id || null;
    if (normalizedRole === 'admin') recipient.recipient_user_id = body.admin_user_id || task.assigned_to || null;
    if (normalizedRole === 'dispatcher') recipient.recipient_user_id = body.dispatcher_user_id || null;
    return recipient;
  });
}

router.get('/ops-center', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const limit = parseLimit(req.query.limit, 50);
    const filters = req.query.booking_id ? { booking_id: req.query.booking_id } : {};

    const [conversations, tasks, presence, checks, events] = await Promise.all([
      readLatestTable(sb, 'ai_conversations', { limit, filters }),
      readLatestTable(sb, 'ai_admin_tasks', { limit, filters }),
      readLatestTable(sb, 'party_presence', { limit, orderBy: 'updated_at', filters }),
      readLatestTable(sb, 'verification_checks', { limit, filters }),
      readLatestTable(sb, 'realtime_events', { limit, filters })
    ]);

    const tableState = {
      ai_conversations: conversations.schema_missing,
      ai_admin_tasks: tasks.schema_missing,
      party_presence: presence.schema_missing,
      verification_checks: checks.schema_missing,
      realtime_events: events.schema_missing
    };

    res.json({
      ok: true,
      schema_missing: Object.values(tableState).some(Boolean),
      missing_tables: Object.entries(tableState).filter(([, missing]) => missing).map(([table]) => table),
      conversations: conversations.rows,
      tasks: tasks.rows,
      party_presence: presence.rows,
      verification_checks: checks.rows,
      realtime_events: events.rows
    });
  } catch (e) { next(e); }
});

router.get('/stream', (req, res) => {
  const bookingId = req.query.booking_id || null;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  sendSse(res, 'hello', {
    ok: true,
    actor_role: req.actor?.role || null,
    actor_user_id: req.actor?.id || null,
    booking_id: bookingId,
    streamed_at: new Date().toISOString()
  });

  const unsubscribe = subscribeRealtimeEvents((event) => {
    if (bookingId && event.booking_id !== bookingId) return;
    sendSse(res, 'realtime_event', event);
  });
  const heartbeat = setInterval(() => {
    sendSse(res, 'heartbeat', { streamed_at: new Date().toISOString() });
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.post('/conversations', async (req, res, next) => {
  try {
    if (!req.body?.source_channel && !req.body?.channel) {
      throw validationError('source_channel is required', 'AI_SOURCE_CHANNEL_REQUIRED');
    }
    if (!req.body?.transcript && !req.body?.message && !req.body?.summary) {
      throw validationError('transcript, message, or summary is required', 'AI_TRANSCRIPT_REQUIRED');
    }
    if (req.body.booking_id && !isUuid(req.body.booking_id)) {
      throw validationError('booking_id must be a uuid', 'AI_BOOKING_ID_INVALID');
    }

    const sb = getSupabase();
    const actorId = actorUserId(req);
    const analysis = await classifyWithAi(req.body);
    const conversationInput = {
      ...req.body,
      payload: {
        ...(req.body.payload || {}),
        ai_analysis_source: analysis.analysis_source,
        ai_analysis_error: analysis.analysis_error || null
      }
    };
    const classification = analysis.classification;
    const conversationInsert = buildConversationInsert(conversationInput, classification, actorId);
    const conversationWrite = await sb.from('ai_conversations')
      .insert(conversationInsert)
      .select('*')
      .single();
    if (conversationWrite.error) throw conversationWrite.error;
    const conversation = conversationWrite.data;

    let task = null;
    let verificationChecks = [];
    if (classification.requires_human_review) {
      const taskInsert = buildTaskInsert(conversationInput, conversation, classification, actorId);
      const taskWrite = await sb.from('ai_admin_tasks').insert(taskInsert).select('*').single();
      if (taskWrite.error) throw taskWrite.error;
      task = taskWrite.data;

      const checkRows = buildVerificationCheckRows({
        taskId: task.id,
        conversationId: conversation.id,
        bookingId: conversation.booking_id
      });
      const checksWrite = await sb.from('verification_checks').insert(checkRows).select('*');
      if (checksWrite.error) throw checksWrite.error;
      verificationChecks = checksWrite.data || [];
    }

    const event = await insertRealtimeEvent(sb, req, {
      bookingId: conversation.booking_id,
      conversationId: conversation.id,
      taskId: task?.id || null,
      eventType: 'ai_conversation_created',
      payload: {
        intent: classification.intent,
        confidence: classification.confidence,
        risk_level: classification.risk_level,
        requires_human_review: classification.requires_human_review
      }
    });

    await insertAuditLog(sb, req, {
      action: 'ai_conversation_created',
      entityType: 'ai_conversation',
      entityId: conversation.id,
      payload: {
        conversation_id: conversation.id,
        task_id: task?.id || null,
        realtime_event_id: event.id,
        analysis_source: analysis.analysis_source,
        classification
      }
    });

    res.status(201).json({
      ok: true,
      conversation,
      task,
      verification_checks: verificationChecks,
      realtime_event: event,
      classification,
      analysis_source: analysis.analysis_source
    });
  } catch (e) { next(e); }
});

router.post('/tasks/:id/verify', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const task = await getTask(sb, req.params.id);
    const existingChecks = await ensureTaskChecks(sb, task);
    const checkTypes = existingChecks.map((check) => check.check_type);
    const updates = normalizeCheckUpdates(req.body?.checks, checkTypes.length ? checkTypes : DEFAULT_VERIFICATION_CHECKS);
    await applyVerificationUpdates(sb, task, updates, req);

    const finalChecks = await getVerificationChecks(sb, task.id);
    const approved = areAllChecksApproved(finalChecks);
    const rejected = hasRejectedCheck(finalChecks);
    const verifiedAt = new Date().toISOString();
    const taskPayload = {
      ...(task.payload || {}),
      verification_summary: {
        approved_checks: finalChecks.filter((check) => check.status === 'approved').length,
        total_checks: finalChecks.length,
        rejected,
        verified_at: verifiedAt
      }
    };

    const taskUpdate = {
      approval_status: approved ? 'approved' : rejected ? 'rejected' : 'pending',
      status: approved ? 'completed' : 'open',
      payload: taskPayload
    };
    const taskWrite = await sb.from('ai_admin_tasks')
      .update(taskUpdate)
      .eq('id', task.id)
      .select('*')
      .single();
    if (taskWrite.error) throw taskWrite.error;
    const updatedTask = taskWrite.data;

    let conversation = null;
    if (task.conversation_id) {
      const conversationWrite = await sb.from('ai_conversations')
        .update({ status: approved ? 'verified' : 'needs_review' })
        .eq('id', task.conversation_id)
        .select('*')
        .single();
      if (conversationWrite.error) throw conversationWrite.error;
      conversation = conversationWrite.data;
    }

    const event = await insertRealtimeEvent(sb, req, {
      bookingId: task.booking_id,
      conversationId: task.conversation_id,
      taskId: task.id,
      eventType: approved ? 'ai_task_verified' : 'ai_task_verification_updated',
      payload: {
        approval_status: updatedTask.approval_status,
        rejected,
        check_count: finalChecks.length
      }
    });

    await insertAuditLog(sb, req, {
      action: 'ai_task_verified',
      entityType: 'ai_admin_task',
      entityId: task.id,
      payload: {
        task_id: task.id,
        approval_status: updatedTask.approval_status,
        realtime_event_id: event.id,
        checks: finalChecks.map((check) => ({
          id: check.id,
          check_type: check.check_type,
          status: check.status
        }))
      }
    });

    res.json({
      ok: true,
      task: updatedTask,
      conversation,
      verification_checks: finalChecks,
      realtime_event: event
    });
  } catch (e) { next(e); }
});

router.post('/tasks/:id/notify', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const task = await getTask(sb, req.params.id);
    assertTaskReadyForOutbound(task, {
      force: Boolean(req.body?.force_unapproved_notification && ['owner', 'admin'].includes(req.actor?.role))
    });
    const { booking, assignment } = await bookingContext(sb, task.booking_id);
    const recipients = resolveRecipients({ body: req.body || {}, task, assignment });

    if (!recipients.length) {
      throw validationError('at least one recipient is required', 'AI_NOTIFY_RECIPIENT_REQUIRED');
    }

    const notificationRows = recipients.map((recipient) => ({
      booking_id: task.booking_id || null,
      assignment_id: assignment?.id || req.body?.assignment_id || null,
      recipient_user_id: recipient.recipient_user_id || null,
      channel: recipient.channel || 'in_app',
      notification_type: req.body?.notification_type || 'ai_task_update',
      payload: buildNotificationPayload({ booking, task, recipient, body: req.body || {} }),
      status: req.body?.status || 'queued'
    }));

    const notificationsWrite = await sb.from('notifications').insert(notificationRows).select('*');
    if (notificationsWrite.error) throw notificationsWrite.error;
    const notifications = notificationsWrite.data || [];
    const sendNow = req.body?.send_now !== false && req.body?.delivery_mode !== 'queue_only';
    const deliveredNotifications = [];
    const recipientEvents = [];
    const partyPresenceRows = [];
    const now = new Date().toISOString();

    for (const [index, notification] of notifications.entries()) {
      const recipient = recipients[index] || {};
      let currentNotification = notification;
      if (sendNow) {
        const delivery = await deliverAiNotification({
          notification,
          booking,
          recipient,
          forceMock: Boolean(req.body?.force_mock)
        });
        const notificationUpdate = await sb.from('notifications')
          .update(delivery)
          .eq('id', notification.id)
          .select('*')
          .single();
        if (notificationUpdate.error) throw notificationUpdate.error;
        currentNotification = notificationUpdate.data;
      }
      deliveredNotifications.push(currentNotification);

      const event = await insertRealtimeEvent(sb, req, {
        bookingId: task.booking_id,
        conversationId: task.conversation_id,
        taskId: task.id,
        recipientRole: recipient.recipient_role || null,
        deliveryStatus: currentNotification.status === 'sent'
          ? 'sent'
          : currentNotification.status === 'failed' ? 'failed' : 'queued',
        eventType: sendNow ? 'ai_task_notification_delivered' : 'ai_task_notification_queued',
        payload: {
          notification_id: currentNotification.id,
          recipient_role: recipient.recipient_role || null,
          recipient_user_id: currentNotification.recipient_user_id || null,
          channel: currentNotification.channel,
          delivery_status: currentNotification.status,
          message_template: currentNotification.payload?.message_template || null
        }
      });
      recipientEvents.push(event);

      const presenceRow = buildPresenceRow({
        task,
        recipient,
        notification: currentNotification,
        event,
        now
      });
      const presence = await updatePartyPresence(sb, presenceRow);
      if (presence) partyPresenceRows.push(presence);
    }

    const summary = deliverySummary(deliveredNotifications);

    const taskPayload = {
      ...(task.payload || {}),
      notification_sent_at: new Date().toISOString(),
      notification_ids: deliveredNotifications.map((notification) => notification.id),
      notified_roles: recipients.map((recipient) => recipient.recipient_role).filter(Boolean),
      delivery_summary: summary,
      realtime_event_ids: recipientEvents.map((event) => event.id),
      party_presence_ids: partyPresenceRows.map((presence) => presence.id)
    };
    const taskWrite = await sb.from('ai_admin_tasks')
      .update({
        status: 'completed',
        payload: taskPayload
      })
      .eq('id', task.id)
      .select('*')
      .single();
    if (taskWrite.error) throw taskWrite.error;

    const event = await insertRealtimeEvent(sb, req, {
      bookingId: task.booking_id,
      conversationId: task.conversation_id,
      taskId: task.id,
      deliveryStatus: summary.failed > 0 ? 'failed' : (summary.queued > 0 ? 'queued' : 'sent'),
      eventType: sendNow ? 'ai_task_notifications_dispatched' : 'ai_task_notifications_queued',
      payload: {
        notification_ids: deliveredNotifications.map((notification) => notification.id),
        recipient_roles: recipients.map((recipient) => recipient.recipient_role).filter(Boolean),
        delivery_summary: summary
      }
    });

    if (task.conversation_id) {
      const conversationWrite = await sb.from('ai_conversations')
        .update({ status: sendNow ? 'notified' : 'actioned' })
        .eq('id', task.conversation_id)
        .select('id');
      if (conversationWrite.error) throw conversationWrite.error;
    }

    await insertAuditLog(sb, req, {
      action: 'ai_task_notified',
      entityType: 'ai_admin_task',
      entityId: task.id,
      companyId: booking?.company_id || null,
      payload: {
        task_id: task.id,
        realtime_event_id: event.id,
        recipient_event_ids: recipientEvents.map((recipientEvent) => recipientEvent.id),
        notification_ids: deliveredNotifications.map((notification) => notification.id),
        delivery_summary: summary
      }
    });

    res.status(201).json({
      ok: true,
      task: taskWrite.data,
      notifications: deliveredNotifications,
      party_presence: partyPresenceRows,
      recipient_events: recipientEvents,
      realtime_event: event,
      delivery_summary: summary
    });
  } catch (e) { next(e); }
});

router.patch('/presence', async (req, res, next) => {
  try {
    if (!req.body?.booking_id || !isUuid(req.body.booking_id)) {
      throw validationError('booking_id must be a uuid', 'AI_BOOKING_ID_INVALID');
    }
    if (!req.body?.party_role) {
      throw validationError('party_role is required', 'AI_PARTY_ROLE_REQUIRED');
    }

    const sb = getSupabase();
    const now = new Date().toISOString();
    const row = {
      booking_id: req.body.booking_id,
      party_role: String(req.body.party_role).trim(),
      recipient_user_id: req.body.recipient_user_id || actorUserId(req),
      channel: normalizeChannel(req.body.channel || 'in_app'),
      status: req.body.status || 'online',
      last_seen_at: req.body.last_seen_at || now,
      last_acknowledged_event_id: req.body.last_acknowledged_event_id || null,
      payload: req.body.payload || {},
      updated_at: now
    };

    const presenceWrite = await sb.from('party_presence')
      .upsert(row, { onConflict: 'booking_id,party_role,recipient_user_id,channel' })
      .select('*')
      .single();
    if (presenceWrite.error) throw presenceWrite.error;

    const event = await insertRealtimeEvent(sb, req, {
      bookingId: row.booking_id,
      eventType: 'party_presence_updated',
      payload: {
        party_role: row.party_role,
        channel: row.channel,
        status: row.status
      }
    });

    await insertAuditLog(sb, req, {
      action: 'party_presence_updated',
      entityType: 'party_presence',
      entityId: presenceWrite.data.id,
      payload: {
        booking_id: row.booking_id,
        party_role: row.party_role,
        channel: row.channel,
        status: row.status,
        realtime_event_id: event.id
      }
    });

    res.json({
      ok: true,
      party_presence: presenceWrite.data,
      realtime_event: event
    });
  } catch (e) { next(e); }
});

router.get('/events', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const limit = parseLimit(req.query.limit, 50);
    let query = sb.from('realtime_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (req.query.booking_id) query = query.eq('booking_id', req.query.booking_id);
    if (req.query.event_type) query = query.eq('event_type', req.query.event_type);
    if (req.query.task_id) query = query.eq('task_id', req.query.task_id);
    if (req.query.conversation_id) query = query.eq('conversation_id', req.query.conversation_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, realtime_events: data || [] });
  } catch (e) { next(e); }
});

module.exports = router;
