const express = require('express');
const { getSupabase } = require('../db/supabase');
const { maskElderForRole } = require('../lib/businessRules');

const router = express.Router();
const ALLOWED_PROFILE_ROLES = new Set(['dispatcher', 'care_assistant', 'driver', 'finance', 'admin']);

function parseLimit(value) {
  const limit = Number(value || 100);
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.round(limit), 1), 200);
}

router.get('/audit-logs', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseLimit(req.query.limit));
    if (req.query.action) query = query.eq('action', req.query.action);
    if (req.query.entity_type) query = query.eq('entity_type', req.query.entity_type);

    const { data, error } = await query;
    if (error) throw error;

    const actorIds = [...new Set((data || []).map((row) => row.actor_user_id).filter(Boolean))];
    const actors = actorIds.length
      ? await sb.from('app_users').select('id,full_name,role').in('id', actorIds)
      : { data: [], error: null };
    if (actors.error) throw actors.error;
    const actorsById = (actors.data || []).reduce((map, actor) => {
      map[actor.id] = actor;
      return map;
    }, {});

    res.json({
      ok: true,
      audit_logs: (data || []).map((row) => ({
        ...row,
        actor: actorsById[row.actor_user_id] || null
      }))
    });
  } catch (e) { next(e); }
});

router.get('/summary', async (_, res, next) => {
  try {
    const sb = getSupabase();
    const [consents, audits] = await Promise.all([
      sb.from('pdpa_consents').select('consent_type,consented'),
      sb.from('audit_logs').select('action,created_at').order('created_at', { ascending: false }).limit(500)
    ]);
    if (consents.error) throw consents.error;
    if (audits.error) throw audits.error;

    const activeSensitive = (consents.data || []).filter((row) => row.consent_type === 'sensitive_health' && row.consented).length;
    const deniedSensitive = (consents.data || []).filter((row) => row.consent_type === 'sensitive_health' && !row.consented).length;
    const sensitiveAccess = (audits.data || []).filter((row) => row.action === 'sensitive_profile_accessed').length;
    const portalViews = (audits.data || []).filter((row) => row.action === 'portal_status_viewed').length;
    res.json({
      ok: true,
      summary: {
        active_sensitive_consents: activeSensitive,
        denied_sensitive_consents: deniedSensitive,
        sensitive_access_count: sensitiveAccess,
        portal_view_count: portalViews
      }
    });
  } catch (e) { next(e); }
});

router.get('/elders/:id/profile', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const requestedRole = String(req.query.role || 'dispatcher');
    const role = ALLOWED_PROFILE_ROLES.has(requestedRole) ? requestedRole : 'dispatcher';
    const purpose = req.query.purpose || 'minimum_needed_profile';
    const { data: elder, error: elderError } = await sb.from('elders')
      .select('id,company_id,customer_id,full_name,mobility_level,medical_notes,allergies,medication_notes,communication_notes,pdpa_sensitive_consent,emergency_contact_name,emergency_contact_phone,customers(id,full_name,phone,line_id)')
      .eq('id', req.params.id)
      .single();
    if (elderError) throw elderError;

    const masked = maskElderForRole(elder, role, elder.pdpa_sensitive_consent === true);
    if (role === 'finance') {
      masked.communication_notes = null;
      masked.emergency_contact_name = null;
      masked.emergency_contact_phone = null;
    }
    const sensitiveFields = ['medical_notes', 'allergies', 'medication_notes', 'communication_notes'];
    const maskedFields = sensitiveFields.filter((field) => elder[field] && !masked[field]);
    const visibleSensitiveFields = sensitiveFields.filter((field) => elder[field] && masked[field]);
    const action = visibleSensitiveFields.length ? 'sensitive_profile_accessed' : 'masked_profile_viewed';

    const { data: auditLog, error: auditError } = await sb.from('audit_logs').insert({
      company_id: elder.company_id || null,
      actor_user_id: req.query.actor_user_id || null,
      action,
      entity_type: 'elder',
      entity_id: elder.id,
      payload: {
        elder_name: elder.full_name,
        viewer_role: role,
        purpose,
        access_level: visibleSensitiveFields.length ? 'sensitive_allowed' : 'minimum_needed_masked',
        masked_fields: maskedFields,
        visible_sensitive_fields: visibleSensitiveFields
      }
    }).select('*').single();
    if (auditError) throw auditError;

    res.json({
      ok: true,
      profile: masked,
      role,
      policy: {
        has_sensitive_consent: elder.pdpa_sensitive_consent === true,
        masked_fields: maskedFields,
        visible_sensitive_fields: visibleSensitiveFields,
        audit_action: action
      },
      audit_log: auditLog
    });
  } catch (e) { next(e); }
});

router.post('/access', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data: elder, error: elderError } = await sb.from('elders')
      .select('id,company_id,full_name')
      .eq('id', req.body.elder_id)
      .single();
    if (elderError) throw elderError;

    const { data, error } = await sb.from('audit_logs').insert({
      company_id: elder.company_id || req.body.company_id || null,
      actor_user_id: req.body.actor_user_id || null,
      action: 'sensitive_profile_accessed',
      entity_type: 'elder',
      entity_id: elder.id,
      payload: {
        elder_name: elder.full_name,
        viewer_role: req.body.viewer_role || 'dispatcher',
        purpose: req.body.purpose || 'service_operation',
        access_level: req.body.access_level || 'minimum_needed'
      }
    }).select('*').single();
    if (error) throw error;
    res.status(201).json({ ok: true, audit_log: data });
  } catch (e) { next(e); }
});

module.exports = router;
