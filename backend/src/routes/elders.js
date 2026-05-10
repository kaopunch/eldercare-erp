const express = require('express');
const { z } = require('zod');
const { getSupabase } = require('../db/supabase');
const { maskElderForRole } = require('../lib/businessRules');

const router = express.Router();

const ElderSchema = z.object({
  company_id: z.string().uuid().optional().nullable(),
  customer_id: z.string().uuid(),
  full_name: z.string().min(2),
  nickname: z.string().optional().nullable(),
  birth_date: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  mobility_level: z.enum(['walk_independent', 'cane', 'walker', 'wheelchair', 'bed_to_wheelchair']),
  medical_notes: z.string().optional().nullable(),
  allergies: z.string().optional().nullable(),
  medication_notes: z.string().optional().nullable(),
  communication_notes: z.string().optional().nullable(),
  walking_ability: z.string().optional().nullable(),
  fall_risk: z.string().optional().nullable(),
  cognitive_status: z.string().optional().nullable(),
  hearing_condition: z.string().optional().nullable(),
  vision_condition: z.string().optional().nullable(),
  emotional_condition: z.string().optional().nullable(),
  chronic_diseases: z.string().optional().nullable(),
  hospital_history: z.string().optional().nullable(),
  risk_level: z.enum(['low', 'medium', 'high', 'critical']).optional().nullable(),
  wheelchair_required: z.boolean().optional(),
  communication_note: z.string().optional().nullable(),
  emergency_contact_name: z.string().optional().nullable(),
  emergency_contact_phone: z.string().optional().nullable(),
  pdpa_sensitive_consent: z.boolean().optional()
});

async function latestSensitiveConsent(sb, elderId) {
  const { data, error } = await sb.from('pdpa_consents')
    .select('consented,consented_at')
    .eq('elder_id', elderId)
    .eq('consent_type', 'sensitive_health')
    .order('consented_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data[0]?.consented === true;
}

function hasSensitiveChange(body) {
  return ['medical_notes', 'allergies', 'medication_notes'].some((field) => Object.prototype.hasOwnProperty.call(body, field));
}

router.get('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('elders').select('*, customers(full_name,phone)').order('created_at', { ascending: false }).limit(Number(req.query.limit || 100));
    if (req.query.customer_id) query = query.eq('customer_id', req.query.customer_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, elders: data });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = ElderSchema.parse(req.body);
    const sb = getSupabase();
    const { data, error } = await sb.from('elders').insert(input).select('*').single();
    if (error) throw error;
    if (hasSensitiveChange(input)) {
      await sb.from('audit_logs').insert({
        company_id: input.company_id || null,
        actor_user_id: req.body.actor_user_id || null,
        action: 'elder_sensitive_profile_created',
        entity_type: 'elder',
        entity_id: data.id,
        payload: { fields: ['medical_notes', 'allergies', 'medication_notes'].filter((field) => input[field]) }
      });
    }
    res.status(201).json({ ok: true, elder: data });
  } catch (e) { next(e); }
});

router.get('/:id/consents', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('pdpa_consents')
      .select('*')
      .eq('elder_id', req.params.id)
      .order('consented_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, consents: data });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('elders')
      .select('*, customers(full_name,phone,line_id,relationship_to_elder)')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;

    const role = req.query.role || 'admin';
    const hasSensitiveConsent = await latestSensitiveConsent(sb, req.params.id);
    const includeSensitive = role === 'admin' || role === 'dispatcher' || role === 'care_assistant';
    const elder = maskElderForRole(data, includeSensitive ? role : 'driver', hasSensitiveConsent);

    if (includeSensitive && hasSensitiveConsent && req.query.actor_user_id) {
      await sb.from('audit_logs').insert({
        company_id: data.company_id,
        actor_user_id: req.query.actor_user_id,
        action: 'elder_sensitive_profile_viewed',
        entity_type: 'elder',
        entity_id: data.id,
        payload: { role }
      });
    }

    res.json({ ok: true, elder, sensitive_consent: hasSensitiveConsent });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data: current, error: currentError } = await sb.from('elders').select('*').eq('id', req.params.id).single();
    if (currentError) throw currentError;

    const { data, error } = await sb.from('elders').update(req.body).eq('id', req.params.id).select('*').single();
    if (error) throw error;

    if (hasSensitiveChange(req.body)) {
      await sb.from('audit_logs').insert({
        company_id: data.company_id,
        actor_user_id: req.body.actor_user_id || null,
        action: 'elder_sensitive_profile_updated',
        entity_type: 'elder',
        entity_id: data.id,
        payload: {
          fields: ['medical_notes', 'allergies', 'medication_notes'].filter((field) => Object.prototype.hasOwnProperty.call(req.body, field)),
          previous_present: {
            medical_notes: Boolean(current.medical_notes),
            allergies: Boolean(current.allergies),
            medication_notes: Boolean(current.medication_notes)
          }
        }
      });
    }

    res.json({ ok: true, elder: data });
  } catch (e) { next(e); }
});

module.exports = router;
