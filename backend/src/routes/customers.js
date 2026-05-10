const express = require('express');
const { z } = require('zod');
const { getSupabase } = require('../db/supabase');

const router = express.Router();

const CustomerSchema = z.object({
  company_id: z.string().uuid().optional().nullable(),
  full_name: z.string().min(2),
  phone: z.string().min(6),
  line_id: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  relationship_to_elder: z.string().optional().nullable(),
  address: z.string().optional().nullable()
});

router.get('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('customers').select('*').order('created_at', { ascending: false }).limit(Number(req.query.limit || 100));
    if (req.query.company_id) query = query.eq('company_id', req.query.company_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, customers: data });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = CustomerSchema.parse(req.body);
    const sb = getSupabase();
    const { data, error } = await sb.from('customers').insert(input).select('*').single();
    if (error) throw error;
    res.status(201).json({ ok: true, customer: data });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('customers')
      .select('*, elders(*)')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json({ ok: true, customer: data });
  } catch (e) { next(e); }
});

module.exports = router;
