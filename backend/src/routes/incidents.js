const express = require('express');
const { getSupabase } = require('../db/supabase');
const {
  ensureIncidentCanClose,
  driverStatusAfterIncident
} = require('../lib/businessRules');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const severity = req.body.severity;
    const { data, error } = await sb.from('incidents').insert({
      ...req.body,
      reported_at: req.body.reported_at || new Date().toISOString(),
      reported_by: req.body.reported_by || req.body.created_by || null,
      status: req.body.status || 'open'
    }).select('*').single();
    if (error) throw error;

    if (req.body.booking_id && ['high', 'critical'].includes(severity)) {
      await sb.from('bookings').update({ status: 'incident_hold' }).eq('id', req.body.booking_id);
      await sb.from('sla_escalations').insert({
        booking_id: req.body.booking_id,
        incident_id: data.id,
        escalation_type: 'high_incident',
        severity,
        status: 'open',
        payload: {
          incident_type: req.body.incident_type,
          family_notified: Boolean(req.body.customer_notified || req.body.emergency_contact_notified)
        }
      });
    }

    const nextDriverStatus = driverStatusAfterIncident(severity);
    if (nextDriverStatus && req.body.driver_id) {
      await sb.from('drivers').update({ status: nextDriverStatus }).eq('id', req.body.driver_id);
    }

    if (['high', 'critical'].includes(severity)) {
      await sb.from('notifications').insert({
        booking_id: req.body.booking_id || null,
        notification_type: 'incident_escalation',
        payload: {
          incident_id: data.id,
          severity,
          incident_type: req.body.incident_type,
          emergency_contact_notified: Boolean(req.body.emergency_contact_notified)
        }
      });
    }

    res.status(201).json({ ok: true, incident: data });
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('incidents').select('*').order('created_at', { ascending: false }).limit(Number(req.query.limit || 100));
    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.severity) query = query.eq('severity', req.query.severity);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, incidents: data });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('incidents').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json({ ok: true, incident: data });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('incidents').update(req.body).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ ok: true, incident: data });
  } catch (e) { next(e); }
});

router.post('/:id/close', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data: incident, error: incidentError } = await sb.from('incidents').select('*').eq('id', req.params.id).single();
    if (incidentError) throw incidentError;

    ensureIncidentCanClose({
      incident,
      actorRole: req.body.actor_role,
      actionTaken: req.body.action_taken,
      resolvedBy: req.body.resolved_by
    });

    const { data, error } = await sb.from('incidents').update({
      status: 'closed',
      action_taken: req.body.action_taken || incident.action_taken,
      resolved_by: req.body.resolved_by || incident.resolved_by,
      resolved_at: new Date().toISOString(),
      root_cause: req.body.root_cause || incident.root_cause,
      preventive_action: req.body.preventive_action || incident.preventive_action,
      customer_notified: Boolean(req.body.customer_notified || incident.customer_notified),
      emergency_contact_notified: Boolean(req.body.emergency_contact_notified || incident.emergency_contact_notified),
      regulatory_report_required: Boolean(req.body.regulatory_report_required || incident.regulatory_report_required)
    }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await sb.from('sla_escalations').update({
      status: 'resolved',
      resolved_by: req.body.resolved_by || incident.resolved_by || null,
      resolved_at: new Date().toISOString()
    }).eq('incident_id', req.params.id).neq('status', 'resolved');
    res.json({ ok: true, incident: data });
  } catch (e) { next(e); }
});

module.exports = router;
