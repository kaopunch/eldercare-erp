const express = require('express');
const { z } = require('zod');
const { getSupabase } = require('../db/supabase');
const {
  screeningResult,
  ensureDriverActivationAllowed
} = require('../lib/businessRules');

const router = express.Router();

const ApplySchema = z.object({
  company_id: z.string().uuid().optional().nullable(),
  branch_id: z.string().uuid().optional().nullable(),
  full_name: z.string().min(2),
  phone: z.string().min(8),
  line_id: z.string().optional().nullable()
});

async function requiredTrainingComplete(sb, driverId) {
  const { data: modules, error: moduleError } = await sb.from('training_modules').select('id').eq('required', true);
  if (moduleError) throw moduleError;
  const moduleIds = (modules || []).map((module) => module.id);
  if (!moduleIds.length) return true;

  const { data: records, error: recordError } = await sb.from('driver_training_records')
    .select('module_id,status')
    .eq('driver_id', driverId)
    .eq('status', 'completed')
    .in('module_id', moduleIds);
  if (recordError) throw recordError;
  const completed = new Set((records || []).map((record) => record.module_id));
  return moduleIds.every((moduleId) => completed.has(moduleId));
}

async function latestScreening(sb, driverId) {
  const { data, error } = await sb.from('driver_screenings')
    .select('*')
    .eq('driver_id', driverId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data[0] || null;
}

router.post('/apply', async (req, res, next) => {
  try {
    const input = ApplySchema.parse(req.body);
    const sb = getSupabase();
    const { data, error } = await sb.from('drivers').insert({
      ...input,
      status: 'pending',
      driver_level: 'bronze'
    }).select('*').single();
    if (error) throw error;
    res.status(201).json({ ok: true, driver: data });
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('drivers').select('*').order('joined_at', { ascending: false }).limit(Number(req.query.limit || 100));
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, drivers: data });
  } catch (e) { next(e); }
});

router.post('/:id/documents', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('driver_documents').insert({
      driver_id: req.params.id,
      doc_type: req.body.doc_type,
      file_url: req.body.file_url || null,
      verified: Boolean(req.body.verified),
      expiry_date: req.body.expiry_date || null,
      verified_by: req.body.verified_by || null,
      verified_at: req.body.verified ? new Date().toISOString() : null
    }).select('*').single();
    if (error) throw error;
    res.status(201).json({ ok: true, document: data });
  } catch (e) { next(e); }
});

router.post('/:id/screening', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const result = screeningResult(req.body);
    const payload = {
      driver_id: req.params.id,
      document_score: req.body.document_score || 0,
      interview_score: req.body.interview_score || 0,
      behavior_score: req.body.behavior_score || 0,
      driving_test_score: req.body.driving_test_score || 0,
      result: result.result,
      notes: req.body.notes || null,
      critical_fail: Boolean(req.body.critical_fail),
      critical_fail_reason: req.body.critical_fail_reason || null,
      interview_payload: req.body.interview_payload || {},
      driving_test_payload: req.body.driving_test_payload || {},
      roleplay_payload: req.body.roleplay_payload || {},
      approved_by: result.result === 'approved' ? (req.body.approved_by || null) : null,
      approved_at: result.result === 'approved' ? new Date().toISOString() : null
    };

    const { data, error } = await sb.from('driver_screenings').insert(payload).select('*').single();
    if (error) throw error;
    const nextStatus = result.result === 'approved' ? 'training' : result.result === 'rejected' ? 'rejected' : 'screening';
    await sb.from('drivers').update({ status: nextStatus }).eq('id', req.params.id);
    res.status(201).json({ ok: true, screening: data, total_score: result.total, result: result.result });
  } catch (e) { next(e); }
});

router.post('/:id/training-attempts', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data: module, error: moduleError } = await sb.from('training_modules').select('*').eq('id', req.body.module_id).single();
    if (moduleError) throw moduleError;
    const passed = Number(req.body.score || 0) >= Number(module.pass_score || 80);

    const { data: attempt, error: attemptError } = await sb.from('training_attempts').insert({
      driver_id: req.params.id,
      module_id: req.body.module_id,
      attempt_no: req.body.attempt_no || 1,
      score: req.body.score || 0,
      answers: req.body.answers || {},
      passed
    }).select('*').single();
    if (attemptError) throw attemptError;

    const { data: record, error: recordError } = await sb.from('driver_training_records').insert({
      driver_id: req.params.id,
      module_id: req.body.module_id,
      status: passed ? 'completed' : 'failed',
      score: req.body.score || 0,
      completed_at: passed ? new Date().toISOString() : null
    }).select('*').single();
    if (recordError) throw recordError;

    res.status(201).json({ ok: true, attempt, record, passed, module_version: module.version || '1.0' });
  } catch (e) { next(e); }
});

router.post('/:id/training/:module_id/complete', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const score = Number(req.body.score || 0);
    const status = score >= 80 ? 'completed' : 'failed';
    const { data, error } = await sb.from('driver_training_records').insert({
      driver_id: req.params.id,
      module_id: req.params.module_id,
      score,
      status,
      completed_at: status === 'completed' ? new Date().toISOString() : null
    }).select('*').single();
    if (error) throw error;
    res.status(201).json({ ok: true, record: data });
  } catch (e) { next(e); }
});

router.post('/:id/activate', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const screening = await latestScreening(sb, req.params.id);
    const hasCompletedRequiredTraining = await requiredTrainingComplete(sb, req.params.id);
    ensureDriverActivationAllowed({
      hasApprovedScreening: screening?.result === 'approved',
      hasCompletedRequiredTraining,
      criticalFail: screening?.critical_fail
    });

    const { data, error } = await sb.from('drivers').update({ status: 'active' }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ ok: true, driver: data });
  } catch (e) { next(e); }
});

router.get('/:id/quality', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('driver_quality_reviews')
      .select('*')
      .eq('driver_id', req.params.id)
      .order('reviewed_at', { ascending: false })
      .limit(Number(req.query.limit || 12));
    if (error) throw error;
    res.json({ ok: true, reviews: data });
  } catch (e) { next(e); }
});

module.exports = router;
