const express = require('express');
const { z } = require('zod');
const { getSupabase } = require('../db/supabase');

const router = express.Router();

const ConsentSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  elder_id: z.string().uuid(),
  consent_type: z.enum(['general_service', 'sensitive_health', 'family_notification', 'photo', 'location_tracking', 'marketing']),
  consented: z.boolean(),
  consent_text_version: z.string().optional().nullable(),
  ip_address: z.string().optional().nullable(),
  user_agent: z.string().optional().nullable(),
  actor_user_id: z.string().uuid().optional().nullable()
});

router.post('/', async (req, res, next) => {
  try {
    const input = ConsentSchema.parse(req.body);
    const sb = getSupabase();
    const { actor_user_id, ...insertPayload } = input;
    const { data, error } = await sb.from('pdpa_consents').insert(insertPayload).select('*').single();
    if (error) throw error;

    if (input.consent_type === 'sensitive_health') {
      await sb.from('elders').update({ pdpa_sensitive_consent: input.consented }).eq('id', input.elder_id);
    }

    await sb.from('audit_logs').insert({
      actor_user_id: actor_user_id || null,
      action: 'pdpa_consent_recorded',
      entity_type: 'elder',
      entity_id: input.elder_id,
      payload: {
        consent_type: input.consent_type,
        consented: input.consented,
        consent_text_version: input.consent_text_version || null
      }
    });

    res.status(201).json({ ok: true, consent: data });
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('pdpa_consents')
      .select('*, elders(full_name), customers(full_name,phone)')
      .order('consented_at', { ascending: false })
      .limit(Number(req.query.limit || 200));
    if (req.query.elder_id) query = query.eq('elder_id', req.query.elder_id);
    if (req.query.consent_type) query = query.eq('consent_type', req.query.consent_type);
    const { data, error } = await query;
    if (error) throw error;

    if (req.query.history === 'true') {
      res.json({ ok: true, consents: data });
      return;
    }

    const latest = [];
    const seen = new Set();
    for (const consent of data || []) {
      const key = `${consent.elder_id}:${consent.consent_type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(consent);
    }

    res.json({ ok: true, consents: latest });
  } catch (e) { next(e); }
});

module.exports = router;
