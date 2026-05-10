const express = require('express');
const { z } = require('zod');
const { getSupabase } = require('../db/supabase');
const {
  SERVICE_TYPE_VALUES,
  WORKFLOW_TEMPLATES,
  workflowSnapshotForBooking
} = require('../lib/businessRules');

const router = express.Router();

const NullableUuid = z.string().uuid().optional().nullable();

const LeadSchema = z.object({
  company_id: NullableUuid,
  branch_id: NullableUuid,
  lead_source: z.string().optional().nullable(),
  contact_name: z.string().min(2),
  contact_phone: z.string().optional().nullable(),
  elder_name: z.string().optional().nullable(),
  service_interest: z.string().optional().nullable(),
  preferred_date: z.string().datetime({ offset: true }).optional().nullable(),
  urgency_level: z.enum(['low', 'normal', 'urgent', 'critical']).optional(),
  status: z.enum(['new', 'contacted', 'qualified', 'converted', 'closed']).optional(),
  assigned_coordinator_id: NullableUuid,
  customer_id: NullableUuid,
  elder_id: NullableUuid,
  notes: z.string().optional().nullable()
});

const AssessmentSchema = z.object({
  elder_id: z.string().uuid(),
  assessed_by: NullableUuid,
  walking_ability: z.string().optional().nullable(),
  fall_risk: z.string().optional().nullable(),
  cognitive_status: z.string().optional().nullable(),
  hearing_condition: z.string().optional().nullable(),
  vision_condition: z.string().optional().nullable(),
  emotional_condition: z.string().optional().nullable(),
  chronic_diseases: z.string().optional().nullable(),
  allergies: z.string().optional().nullable(),
  current_medication: z.string().optional().nullable(),
  hospital_history: z.string().optional().nullable(),
  wheelchair_required: z.boolean().optional(),
  communication_note: z.string().optional().nullable(),
  support_requirement: z.record(z.any()).optional(),
  risk_level: z.enum(['low', 'medium', 'high', 'critical']).optional().nullable()
});

const BranchChecklistSchema = z.object({
  branch_id: z.string().uuid(),
  checklist_type: z.enum(['opening', 'closing']),
  checklist_date: z.string().date().optional(),
  items: z.array(z.any()).optional(),
  completed: z.boolean().optional(),
  completed_by: NullableUuid,
  unresolved_issues: z.array(z.any()).optional()
});

router.get('/v2/templates', (_, res) => {
  res.json({
    ok: true,
    version: '2.0',
    service_types: SERVICE_TYPE_VALUES,
    templates: WORKFLOW_TEMPLATES
  });
});

router.get('/v2/templates/:service_type', (req, res, next) => {
  try {
    const snapshot = workflowSnapshotForBooking({ service_type: req.params.service_type });
    res.json({ ok: true, workflow: snapshot });
  } catch (e) { next(e); }
});

router.post('/leads', async (req, res, next) => {
  try {
    const input = LeadSchema.parse(req.body);
    const sb = getSupabase();
    const { data, error } = await sb.from('leads').insert(input).select('*').single();
    if (error) throw error;
    await sb.from('audit_logs').insert({
      company_id: data.company_id || null,
      actor_user_id: req.actor?.id || null,
      action: 'lead.created',
      entity_type: 'lead',
      entity_id: data.id,
      payload: {
        lead_source: data.lead_source,
        service_interest: data.service_interest,
        urgency_level: data.urgency_level
      }
    });
    res.status(201).json({ ok: true, lead: data });
  } catch (e) { next(e); }
});

router.post('/elder-assessments', async (req, res, next) => {
  try {
    const input = AssessmentSchema.parse(req.body);
    const sb = getSupabase();
    const { data, error } = await sb.from('elder_assessments').insert({
      ...input,
      support_requirement: input.support_requirement || {}
    }).select('*').single();
    if (error) throw error;

    await sb.from('elders').update({
      walking_ability: input.walking_ability || null,
      fall_risk: input.fall_risk || null,
      cognitive_status: input.cognitive_status || null,
      hearing_condition: input.hearing_condition || null,
      vision_condition: input.vision_condition || null,
      emotional_condition: input.emotional_condition || null,
      chronic_diseases: input.chronic_diseases || null,
      allergies: input.allergies || null,
      medication_notes: input.current_medication || null,
      hospital_history: input.hospital_history || null,
      wheelchair_required: Boolean(input.wheelchair_required),
      communication_note: input.communication_note || null,
      risk_level: input.risk_level || null
    }).eq('id', input.elder_id);

    await sb.from('audit_logs').insert({
      actor_user_id: req.actor?.id || input.assessed_by || null,
      action: 'elder.assessment_recorded',
      entity_type: 'elder',
      entity_id: input.elder_id,
      payload: {
        assessment_id: data.id,
        risk_level: data.risk_level,
        wheelchair_required: data.wheelchair_required
      }
    });
    res.status(201).json({ ok: true, assessment: data });
  } catch (e) { next(e); }
});

router.get('/branch-checklists', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('branch_operation_checklists').select('*').order('created_at', { ascending: false }).limit(Number(req.query.limit || 100));
    if (req.query.branch_id) query = query.eq('branch_id', req.query.branch_id);
    if (req.query.checklist_type) query = query.eq('checklist_type', req.query.checklist_type);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, checklists: data || [] });
  } catch (e) { next(e); }
});

router.post('/branch-checklists', async (req, res, next) => {
  try {
    const input = BranchChecklistSchema.parse(req.body);
    const completed = Boolean(input.completed);
    const sb = getSupabase();
    const { data, error } = await sb.from('branch_operation_checklists').insert({
      branch_id: input.branch_id,
      checklist_type: input.checklist_type,
      checklist_date: input.checklist_date || new Date().toISOString().slice(0, 10),
      items: input.items || [],
      completed,
      completed_by: input.completed_by || req.actor?.id || null,
      completed_at: completed ? new Date().toISOString() : null,
      unresolved_issues: input.unresolved_issues || []
    }).select('*').single();
    if (error) throw error;
    res.status(201).json({ ok: true, checklist: data });
  } catch (e) { next(e); }
});

router.get('/sla-escalations', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('sla_escalations').select('*').order('triggered_at', { ascending: false }).limit(Number(req.query.limit || 100));
    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.booking_id) query = query.eq('booking_id', req.query.booking_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, escalations: data || [] });
  } catch (e) { next(e); }
});

router.patch('/sla-escalations/:id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const status = req.body.status || 'acknowledged';
    const payload = { status };
    if (status === 'acknowledged') {
      payload.acknowledged_by = req.body.acknowledged_by || req.actor?.id || null;
      payload.acknowledged_at = new Date().toISOString();
    }
    if (status === 'resolved') {
      payload.resolved_by = req.body.resolved_by || req.actor?.id || null;
      payload.resolved_at = new Date().toISOString();
    }
    const { data, error } = await sb.from('sla_escalations').update(payload).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ ok: true, escalation: data });
  } catch (e) { next(e); }
});

module.exports = router;
