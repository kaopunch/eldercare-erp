const express = require('express');
const { getSupabase } = require('../db/supabase');
const { configured: lineConfigured, deliverNotification } = require('../lib/line');

const router = express.Router();
const ALLOWED_STATUS = new Set(['queued', 'sent', 'failed', 'read']);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function indexById(rows = []) {
  return rows.reduce((map, row) => {
    map[row.id] = row;
    return map;
  }, {});
}

async function selectByIds(sb, table, columns, ids) {
  if (!ids.length) return [];
  const { data, error } = await sb.from(table).select(columns).in('id', ids);
  if (error) throw error;
  return data || [];
}

function parseLimit(value) {
  const limit = Number(value || 100);
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.round(limit), 1), 200);
}

async function getNotification(sb, id) {
  const { data, error } = await sb.from('notifications').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function notificationContext(sb, notification) {
  const [booking, recipient] = await Promise.all([
    notification.booking_id
      ? sb.from('bookings')
        .select('id,booking_no,service_type,pickup_at,customer_id,elder_id,customers(full_name,phone,line_id,email),elders(full_name)')
        .eq('id', notification.booking_id)
        .single()
      : Promise.resolve({ data: null, error: null }),
    notification.recipient_user_id
      ? sb.from('app_users').select('id,full_name,phone,email,role').eq('id', notification.recipient_user_id).single()
      : Promise.resolve({ data: null, error: null })
  ]);
  if (booking.error) throw booking.error;
  if (recipient.error) throw recipient.error;
  return { booking: booking.data, recipient: recipient.data };
}

router.get('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseLimit(req.query.limit));

    if (req.query.status && ALLOWED_STATUS.has(req.query.status)) {
      query = query.eq('status', req.query.status);
    }
    if (req.query.booking_id) query = query.eq('booking_id', req.query.booking_id);
    if (req.query.type) query = query.eq('notification_type', req.query.type);

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const bookingIds = unique(rows.map((row) => row.booking_id));
    const assignmentIds = unique(rows.map((row) => row.assignment_id));
    const recipientIds = unique(rows.map((row) => row.recipient_user_id));

    const [bookings, assignments, recipients] = await Promise.all([
      selectByIds(sb, 'bookings', 'id,booking_no,status,customer_id,elder_id,service_type,pickup_at,customers(full_name,phone),elders(full_name)', bookingIds),
      selectByIds(sb, 'assignments', 'id,status,driver_id,care_assistant_id,drivers(full_name,phone),care_assistant:app_users!assignments_care_assistant_id_fkey(full_name,phone)', assignmentIds),
      selectByIds(sb, 'app_users', 'id,full_name,phone,role,status', recipientIds)
    ]);

    const bookingsById = indexById(bookings);
    const assignmentsById = indexById(assignments);
    const recipientsById = indexById(recipients);
    const notifications = rows.map((row) => ({
      ...row,
      booking: bookingsById[row.booking_id] || null,
      assignment: assignmentsById[row.assignment_id] || null,
      recipient: recipientsById[row.recipient_user_id] || null
    }));

    res.json({
      ok: true,
      line_configured: lineConfigured(),
      notifications
    });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const status = req.body.status || 'queued';
    if (!ALLOWED_STATUS.has(status)) {
      const error = new Error('notification status is invalid');
      error.statusCode = 422;
      error.code = 'NOTIFICATION_STATUS_INVALID';
      throw error;
    }

    const { data, error } = await sb.from('notifications').insert({
      booking_id: req.body.booking_id || null,
      assignment_id: req.body.assignment_id || null,
      recipient_user_id: req.body.recipient_user_id || null,
      channel: req.body.channel || 'in_app',
      notification_type: req.body.notification_type,
      payload: req.body.payload || {},
      status
    }).select('*').single();
    if (error) throw error;
    res.status(201).json({ ok: true, notification: data });
  } catch (e) { next(e); }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const status = req.body.status;
    if (!ALLOWED_STATUS.has(status)) {
      const error = new Error('notification status is invalid');
      error.statusCode = 422;
      error.code = 'NOTIFICATION_STATUS_INVALID';
      throw error;
    }

    const update = { status };
    if (status === 'queued') {
      update.sent_at = null;
    } else if (['sent', 'read'].includes(status)) {
      update.sent_at = req.body.sent_at || new Date().toISOString();
    }

    const { data, error } = await sb.from('notifications')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, notification: data });
  } catch (e) { next(e); }
});

router.post('/:id/send-mock', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const current = await getNotification(sb, req.params.id);
    const status = req.body.force_fail ? 'failed' : 'sent';
    const now = new Date().toISOString();
    const payload = {
      ...(current.payload || {}),
      mock_provider: 'line_mock',
      mock_delivery_id: `MOCK-${Date.now()}`,
      mock_delivery_status: status,
      mock_delivered_at: now
    };

    const update = { status, payload };
    if (status === 'sent') update.sent_at = now;
    const { data, error } = await sb.from('notifications')
      .update(update)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, notification: data });
  } catch (e) { next(e); }
});

router.post('/:id/send', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const current = await getNotification(sb, req.params.id);
    const context = await notificationContext(sb, current);
    const delivery = await deliverNotification({
      notification: current,
      context,
      forceMock: Boolean(req.body.force_mock)
    });
    const { data, error } = await sb.from('notifications')
      .update(delivery)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({
      ok: true,
      provider: delivery.payload.provider,
      line_configured: lineConfigured(),
      notification: data
    });
  } catch (e) { next(e); }
});

router.post('/:id/retry', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const current = await getNotification(sb, req.params.id);
    const payload = {
      ...(current.payload || {}),
      retry_count: Number(current.payload?.retry_count || 0) + 1,
      retry_requested_at: new Date().toISOString(),
      retry_reason: req.body.reason || 'manual_retry'
    };
    const { data, error } = await sb.from('notifications')
      .update({
        status: 'queued',
        sent_at: null,
        payload
      })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, notification: data });
  } catch (e) { next(e); }
});

module.exports = router;
