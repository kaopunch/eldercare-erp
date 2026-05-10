const express = require('express');
const { z } = require('zod');
const { getSupabase } = require('../db/supabase');
const {
  BusinessRuleError,
  SERVICE_TYPE_VALUES,
  ensureBookingCanBeCreated,
  ensureBookingCanBeConfirmed,
  ensureCancellationAllowed,
  ensureTripEventAllowed,
  bookingStatusForTripEvent,
  calculateQuote,
  missingRequiredConsents,
  workflowSnapshotForBooking,
  ensureVisitSummaryAllowed,
  validateNonDiagnosticText,
  ensureBookingClosureAllowed
} = require('../lib/businessRules');
const { queueCustomerNotification } = require('../lib/notifications');

const router = express.Router();

const BookingSchema = z.object({
  company_id: z.string().uuid().optional().nullable(),
  branch_id: z.string().uuid().optional().nullable(),
  customer_id: z.string().uuid(),
  elder_id: z.string().uuid(),
  service_type: z.enum(SERVICE_TYPE_VALUES),
  pickup_address: z.string().min(2),
  dropoff_address: z.string().min(2),
  pickup_at: z.string().datetime({ offset: true }),
  estimated_return_at: z.string().datetime({ offset: true }).optional().nullable(),
  appointment_at: z.string().datetime({ offset: true }).optional().nullable(),
  appointment_place: z.string().optional().nullable(),
  hospital_name: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  doctor_name: z.string().optional().nullable(),
  support_level: z.string().optional().nullable(),
  family_contact_name: z.string().optional().nullable(),
  family_contact_phone: z.string().optional().nullable(),
  preferred_communication_channel: z.string().optional().nullable(),
  special_notes: z.string().optional().nullable(),
  need_care_assistant: z.boolean().optional(),
  need_wheelchair_support: z.boolean().optional(),
  booking_source: z.string().optional().nullable(),
  quoted_price: z.number().optional(),
  final_price: z.number().optional()
});

function bookingNo() {
  return `BK${Date.now()}`;
}

function quoteNo() {
  return `QT${Date.now()}`;
}

async function getLatestSensitiveConsent(sb, elderId) {
  const { data, error } = await sb.from('pdpa_consents')
    .select('consented,consented_at')
    .eq('elder_id', elderId)
    .eq('consent_type', 'sensitive_health')
    .order('consented_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data[0]?.consented === true;
}

async function getLatestConsentState(sb, elderId) {
  const { data, error } = await sb.from('pdpa_consents')
    .select('consent_type,consented,consented_at')
    .eq('elder_id', elderId)
    .order('consented_at', { ascending: false });
  if (error) throw error;
  return (data || []).reduce((state, consent) => {
    if (!Object.prototype.hasOwnProperty.call(state, consent.consent_type)) {
      state[consent.consent_type] = consent.consented === true;
    }
    return state;
  }, {});
}

async function getBooking(sb, id) {
  const { data, error } = await sb.from('bookings')
    .select('*, customers(full_name,phone), elders(full_name,mobility_level,medical_notes,communication_notes)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function createBookingWorkflow(sb, booking, generatedBy = null) {
  const snapshot = workflowSnapshotForBooking(booking);
  const { data, error } = await sb.from('booking_workflows').insert({
    booking_id: booking.id,
    service_type: booking.service_type,
    template_code: snapshot.template_code,
    required_events: snapshot.required_events,
    optional_events: snapshot.optional_events,
    required_checklists: snapshot.required_checklists,
    summary_required: snapshot.summary_required,
    generated_by: generatedBy
  }).select('*').single();
  if (error) throw error;

  await sb.from('bookings').update({
    workflow_template_code: snapshot.template_code,
    workflow_snapshot: snapshot
  }).eq('id', booking.id);

  return data;
}

async function getExistingEvents(sb, bookingId) {
  const { data, error } = await sb.from('trip_events')
    .select('event_type,event_payload,event_at')
    .eq('booking_id', bookingId)
    .order('event_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function hasCompletedPreTripChecklist(sb, bookingId) {
  const { data, error } = await sb.from('trip_checklists')
    .select('id')
    .eq('booking_id', bookingId)
    .in('checklist_type', ['pre_trip', 'pre_visit', 't24_confirmation', 't2_review'])
    .eq('completed', true)
    .limit(1);
  if (error) throw error;
  return Boolean(data.length);
}

async function insertTripEvent(sb, bookingId, body) {
  const booking = await getBooking(sb, bookingId);
  const existingEvents = await getExistingEvents(sb, bookingId);
  const hasPreTripChecklist = await hasCompletedPreTripChecklist(sb, bookingId);
  const eventPayload = body.event_payload || {};

  ensureTripEventAllowed({
    eventType: body.event_type,
    existingEvents,
    hasPreTripChecklist,
    booking,
    eventPayload
  });

  const { data, error } = await sb.from('trip_events').insert({
    booking_id: bookingId,
    assignment_id: body.assignment_id || null,
    event_type: body.event_type,
    lat: body.lat || null,
    lng: body.lng || null,
    photo_url: body.photo_url || null,
    notes: body.notes || null,
    created_by: body.created_by || null,
    event_payload: eventPayload
  }).select('*').single();
  if (error) throw error;

  const nextStatus = bookingStatusForTripEvent(body.event_type);
  if (nextStatus) {
    await sb.from('bookings').update({ status: nextStatus }).eq('id', bookingId);
  }

  if (eventPayload.severe_symptoms
    || eventPayload.emergency_condition
    || eventPayload.condition_status === 'emergency'
    || eventPayload.fall_detected
    || eventPayload.fainted
    || eventPayload.chest_pain
    || eventPayload.disoriented) {
    await sb.from('incidents').insert({
      booking_id: bookingId,
      elder_id: booking.elder_id,
      incident_type: eventPayload.fall_detected ? 'fall' : 'medical_warning',
      severity: eventPayload.severity || 'high',
      description: eventPayload.description || 'Severe condition recorded during service workflow',
      action_taken: eventPayload.action_taken || 'Operation frozen; hospital/coordinator/family notification required',
      status: 'open',
      reported_at: new Date().toISOString(),
      reported_by: body.created_by || null,
      created_by: body.created_by || null,
      customer_notified: Boolean(eventPayload.family_notified),
      emergency_contact_notified: Boolean(eventPayload.family_notified),
      family_notified_at: eventPayload.family_notified ? new Date().toISOString() : null,
      emergency_services_contacted: Boolean(eventPayload.emergency_services_contacted),
      closure_frozen: true
    });
    await sb.from('bookings').update({ status: 'incident_hold' }).eq('id', bookingId);
  }

  return data;
}

router.get('/today', async (_, res, next) => {
  try {
    const sb = getSupabase();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const { data, error } = await sb.from('bookings')
      .select('*, customers(full_name,phone), elders(full_name,mobility_level)')
      .gte('pickup_at', start.toISOString())
      .lte('pickup_at', end.toISOString())
      .order('pickup_at');
    if (error) throw error;
    res.json({ ok: true, bookings: data });
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    let query = sb.from('bookings')
      .select('*, customers(full_name,phone), elders(full_name,mobility_level), assignments(id,status,driver_id,care_assistant_id,vehicle_id,care_assistant:app_users!assignments_care_assistant_id_fkey(full_name,phone),drivers(full_name,driver_level,status),vehicles(id,plate_number,vehicle_type,status)), trip_events(event_type,event_at,event_payload), trip_checklists(checklist_type,completed,completed_at)')
      .order('pickup_at', { ascending: true })
      .limit(Number(req.query.limit || 200));
    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.risk_level) query = query.eq('risk_level', req.query.risk_level);
    if (req.query.service_type) query = query.eq('service_type', req.query.service_type);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, bookings: data });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const input = BookingSchema.parse(req.body);
    const sb = getSupabase();
    const { data: elder, error: elderError } = await sb.from('elders').select('*').eq('id', input.elder_id).single();
    if (elderError) throw elderError;

    const hasSensitiveConsent = await getLatestSensitiveConsent(sb, input.elder_id);
    const rules = ensureBookingCanBeCreated(input, elder, { hasSensitiveConsent });
    const status = ['high', 'critical'].includes(rules.risk_level) ? 'pending_dispatch_approval' : 'draft';
    const insertPayload = {
      ...input,
      booking_no: bookingNo(),
      risk_level: rules.risk_level,
      need_care_assistant: rules.need_care_assistant,
      need_wheelchair_support: Boolean(input.need_wheelchair_support),
      consent_checked: rules.consent_checked,
      status
    };

    const { data, error } = await sb.from('bookings').insert(insertPayload).select('*').single();
    if (error) throw error;
    const workflow = await createBookingWorkflow(sb, data, req.body.created_by || req.actor?.id || null);

    if (input.estimated_return_at) {
      await sb.from('booking_segments').insert([
        {
          booking_id: data.id,
          segment_type: 'outbound',
          pickup_address: input.pickup_address,
          dropoff_address: input.dropoff_address,
          scheduled_at: input.pickup_at,
          status: 'scheduled',
          sequence_no: 1
        },
        {
          booking_id: data.id,
          segment_type: 'return',
          pickup_address: input.dropoff_address,
          dropoff_address: input.pickup_address,
          scheduled_at: input.estimated_return_at,
          status: 'scheduled',
          sequence_no: 2
        }
      ]);
    }

    await queueCustomerNotification(sb, data, 'booking_requested', {
      risk_level: data.risk_level,
      service_type: data.service_type,
      workflow_template_code: workflow.template_code
    });

    res.status(201).json({ ok: true, booking: data, workflow, warnings: rules.warnings });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const booking = await getBooking(sb, req.params.id);
    const [events, quotes, assignments, payments, workflows, summaries, familyUpdates, escalations] = await Promise.all([
      sb.from('trip_events').select('*').eq('booking_id', req.params.id).order('event_at', { ascending: true }),
      sb.from('booking_quotes').select('*').eq('booking_id', req.params.id).order('created_at', { ascending: false }),
      sb.from('assignments').select('*, drivers(full_name,driver_level,status), vehicles(plate_number,vehicle_type,status)').eq('booking_id', req.params.id),
      sb.from('payments').select('*').eq('booking_id', req.params.id).order('created_at', { ascending: false }),
      sb.from('booking_workflows').select('*').eq('booking_id', req.params.id).order('generated_at', { ascending: false }),
      sb.from('visit_summaries').select('*').eq('booking_id', req.params.id).order('submitted_at', { ascending: false }),
      sb.from('family_updates').select('*').eq('booking_id', req.params.id).order('sent_at', { ascending: false }),
      sb.from('sla_escalations').select('*').eq('booking_id', req.params.id).order('triggered_at', { ascending: false })
    ]);
    if (events.error) throw events.error;
    if (quotes.error) throw quotes.error;
    if (assignments.error) throw assignments.error;
    if (payments.error) throw payments.error;
    if (workflows.error) throw workflows.error;
    if (summaries.error) throw summaries.error;
    if (familyUpdates.error) throw familyUpdates.error;
    if (escalations.error) throw escalations.error;
    res.json({
      ok: true,
      booking,
      events: events.data,
      quotes: quotes.data,
      assignments: assignments.data,
      payments: payments.data,
      workflows: workflows.data,
      visit_summaries: summaries.data,
      family_updates: familyUpdates.data,
      sla_escalations: escalations.data
    });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const current = await getBooking(sb, req.params.id);
    const updatePayload = { ...req.body };

    if (req.body.service_type || req.body.special_notes || req.body.need_wheelchair_support) {
      const merged = { ...current, ...req.body };
      const hasSensitiveConsent = await getLatestSensitiveConsent(sb, current.elder_id);
      const rules = ensureBookingCanBeCreated(merged, current.elders, { hasSensitiveConsent });
      updatePayload.risk_level = rules.risk_level;
      updatePayload.need_care_assistant = rules.need_care_assistant;
      updatePayload.consent_checked = rules.consent_checked;
    }

    const { data, error } = await sb.from('bookings').update(updatePayload).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await queueCustomerNotification(sb, data, 'booking_updated', {
      status: data.status,
      risk_level: data.risk_level,
      updated_fields: Object.keys(req.body)
    });
    res.json({ ok: true, booking: data });
  } catch (e) { next(e); }
});

router.post('/:id/quote', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const booking = await getBooking(sb, req.params.id);
    const { data: rules, error: rulesError } = await sb.from('service_price_rules')
      .select('*')
      .eq('service_type', booking.service_type)
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (rulesError) throw rulesError;
    const priceRule = rules.find((rule) => rule.branch_id === booking.branch_id)
      || rules.find((rule) => rule.company_id === booking.company_id)
      || rules[0];
    if (!priceRule) throw new BusinessRuleError('no active price rule for service_type', 'PRICE_RULE_REQUIRED');

    const quote = calculateQuote({
      booking,
      priceRule,
      distanceKm: req.body.distance_km,
      waitingHours: req.body.waiting_hours,
      discount: req.body.discount,
      taxRate: req.body.tax_rate,
      afterHours: req.body.after_hours,
      holiday: req.body.holiday,
      outOfArea: req.body.out_of_area
    });
    const quoteStatus = req.body.approve ? 'approved' : (req.body.quote_status || 'draft');
    const payload = {
      booking_id: req.params.id,
      quote_no: req.body.quote_no || quoteNo(),
      subtotal: quote.subtotal,
      discount: quote.discount,
      tax: quote.tax,
      total: quote.total,
      quote_status: quoteStatus,
      approved_by: quoteStatus === 'approved' ? (req.body.approved_by || null) : null,
      approved_at: quoteStatus === 'approved' ? new Date().toISOString() : null,
      expires_at: req.body.expires_at || null,
      pricing_snapshot: quote.pricing_snapshot
    };
    const { data, error } = await sb.from('booking_quotes').insert(payload).select('*').single();
    if (error) throw error;

    await sb.from('bookings').update({
      quoted_price: data.total,
      final_price: quoteStatus === 'approved' ? data.total : booking.final_price
    }).eq('id', req.params.id);

    res.status(201).json({ ok: true, quote: data });
  } catch (e) { next(e); }
});

router.post('/:id/confirm', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const booking = await getBooking(sb, req.params.id);
    const { data: approvedQuotes, error: quoteError } = await sb.from('booking_quotes')
      .select('id,total')
      .eq('booking_id', req.params.id)
      .eq('quote_status', 'approved')
      .limit(1);
    if (quoteError) throw quoteError;
    const consentState = await getLatestConsentState(sb, booking.elder_id);
    const missingConsents = missingRequiredConsents(booking.service_type, consentState);

    ensureBookingCanBeConfirmed(booking, {
      hasApprovedQuote: Boolean(approvedQuotes.length),
      dispatcherApproved: req.body.dispatcher_approved || req.body.approved_by,
      missingConsents
    });

    const updatePayload = {
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      booking_confirmed: true,
      confirmation_time: new Date().toISOString(),
      coordinator_id: req.body.coordinator_id || booking.coordinator_id || null
    };
    if (req.body.approved_by) {
      updatePayload.dispatcher_approved_by = req.body.approved_by;
      updatePayload.dispatcher_approved_at = new Date().toISOString();
    }

    const { data, error } = await sb.from('bookings').update(updatePayload).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await queueCustomerNotification(sb, data, 'booking_confirmed', {
      confirmed_at: data.confirmed_at,
      approved_by: req.body.approved_by || null
    });
    res.json({ ok: true, booking: data });
  } catch (e) { next(e); }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const existingEvents = await getExistingEvents(sb, req.params.id);
    ensureCancellationAllowed({
      reasonCode: req.body.reason_code,
      evidence: req.body.evidence || {},
      existingEvents
    });

    const { data: cancellation, error } = await sb.from('booking_cancellations').insert({
      booking_id: req.params.id,
      cancelled_by_role: req.body.cancelled_by_role || null,
      cancelled_by_user_id: req.body.cancelled_by_user_id || null,
      reason_code: req.body.reason_code,
      reason_text: req.body.reason_text || null,
      fee_amount: req.body.fee_amount || 0,
      evidence: req.body.evidence || {}
    }).select('*').single();
    if (error) throw error;

    const status = req.body.reason_code === 'no_show' ? 'no_show' : 'cancelled';
    const { data: booking, error: bookingError } = await sb.from('bookings').update({ status }).eq('id', req.params.id).select('*').single();
    if (bookingError) throw bookingError;
    await queueCustomerNotification(sb, booking, 'booking_cancelled', {
      reason_code: req.body.reason_code,
      reason_text: req.body.reason_text || null,
      fee_amount: req.body.fee_amount || 0
    });

    res.json({ ok: true, booking, cancellation });
  } catch (e) { next(e); }
});

router.post('/:id/segments', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const segments = Array.isArray(req.body.segments) ? req.body.segments : [req.body];
    const payload = segments.map((segment, index) => ({
      booking_id: req.params.id,
      segment_type: segment.segment_type,
      pickup_address: segment.pickup_address,
      dropoff_address: segment.dropoff_address,
      scheduled_at: segment.scheduled_at || null,
      status: segment.status || 'scheduled',
      sequence_no: segment.sequence_no || index + 1
    }));
    const { data, error } = await sb.from('booking_segments').insert(payload).select('*');
    if (error) throw error;
    res.status(201).json({ ok: true, segments: data });
  } catch (e) { next(e); }
});

router.post('/:id/events', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const event = await insertTripEvent(sb, req.params.id, req.body);
    res.status(201).json({ ok: true, event });
  } catch (e) { next(e); }
});

router.post('/:id/family-updates', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const booking = await getBooking(sb, req.params.id);
    const message = req.body.message || req.body.family_summary || '';
    validateNonDiagnosticText(message, 'family_update.message');

    const { data: update, error } = await sb.from('family_updates').insert({
      booking_id: req.params.id,
      elder_id: booking.elder_id,
      update_type: req.body.update_type || 'family_update',
      channel: req.body.channel || booking.preferred_communication_channel || 'in_app',
      message,
      factual_only: req.body.factual_only !== false,
      sent_by: req.body.sent_by || req.actor?.id || null,
      sent_at: req.body.sent_at || new Date().toISOString(),
      recipient_name: req.body.recipient_name || booking.family_contact_name || null,
      recipient_contact: req.body.recipient_contact || booking.family_contact_phone || null,
      payload: req.body.payload || {}
    }).select('*').single();
    if (error) throw error;

    await sb.from('trip_events').insert({
      booking_id: req.params.id,
      event_type: 'family_update',
      notes: message,
      created_by: req.body.sent_by || req.actor?.id || null,
      event_payload: {
        update_id: update.id,
        update_type: update.update_type,
        channel: update.channel
      }
    });
    await sb.from('bookings').update({ family_notified_at: update.sent_at }).eq('id', req.params.id);
    await queueCustomerNotification(sb, booking, update.update_type, {
      update_id: update.id,
      message,
      channel: update.channel
    });

    res.status(201).json({ ok: true, family_update: update });
  } catch (e) { next(e); }
});

router.post('/:id/visit-summary', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const booking = await getBooking(sb, req.params.id);
    ensureVisitSummaryAllowed(req.body);
    const approved = req.body.status === 'approved' || Boolean(req.body.approved_by);
    const { data: summary, error } = await sb.from('visit_summaries').insert({
      booking_id: req.params.id,
      elder_id: booking.elder_id,
      prepared_by: req.body.prepared_by || req.actor?.id || null,
      visit_outcome: req.body.visit_outcome,
      medication_pickup_status: req.body.medication_pickup_status || null,
      next_appointment: req.body.next_appointment || null,
      follow_up_requirement: req.body.follow_up_requirement || null,
      family_summary: req.body.family_summary,
      staff_concern: req.body.staff_concern || null,
      hidden_operational_note: req.body.hidden_operational_note || null,
      status: approved ? 'approved' : (req.body.status || 'submitted'),
      approved_by: approved ? (req.body.approved_by || req.actor?.id || null) : null,
      approved_at: approved ? new Date().toISOString() : null
    }).select('*').single();
    if (error) throw error;

    await sb.from('trip_events').insert({
      booking_id: req.params.id,
      event_type: 'visit_summary_submitted',
      notes: summary.family_summary,
      created_by: summary.prepared_by,
      event_payload: {
        summary_id: summary.id,
        summary_status: summary.status,
        approved: summary.status === 'approved'
      }
    });

    if (summary.status === 'approved') {
      await queueCustomerNotification(sb, booking, 'summary_approved', {
        summary_id: summary.id,
        family_summary: summary.family_summary,
        follow_up_requirement: summary.follow_up_requirement
      });
    }

    res.status(201).json({ ok: true, visit_summary: summary });
  } catch (e) { next(e); }
});

router.post('/:id/visit-summary/:summary_id/approve', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const booking = await getBooking(sb, req.params.id);
    const { data: summary, error } = await sb.from('visit_summaries').update({
      status: 'approved',
      approved_by: req.body.approved_by || req.actor?.id || null,
      approved_at: new Date().toISOString(),
      rejected_reason: null
    }).eq('id', req.params.summary_id).eq('booking_id', req.params.id).select('*').single();
    if (error) throw error;
    await queueCustomerNotification(sb, booking, 'summary_approved', {
      summary_id: summary.id,
      family_summary: summary.family_summary,
      follow_up_requirement: summary.follow_up_requirement
    });
    res.json({ ok: true, visit_summary: summary });
  } catch (e) { next(e); }
});

async function completionContext(sb, bookingId) {
  const booking = await getBooking(sb, bookingId);
  const [events, summaries, incidents, updates] = await Promise.all([
    sb.from('trip_events').select('*').eq('booking_id', bookingId).order('event_at', { ascending: true }),
    sb.from('visit_summaries').select('*').eq('booking_id', bookingId).eq('status', 'approved').order('approved_at', { ascending: false }).limit(1),
    sb.from('incidents').select('*').eq('booking_id', bookingId).neq('status', 'closed'),
    sb.from('family_updates').select('*').eq('booking_id', bookingId).order('sent_at', { ascending: false }).limit(1)
  ]);
  if (events.error) throw events.error;
  if (summaries.error) throw summaries.error;
  if (incidents.error) throw incidents.error;
  if (updates.error) throw updates.error;
  return {
    booking,
    events: events.data || [],
    latestApprovedSummary: summaries.data?.[0] || null,
    openIncidents: incidents.data || [],
    familyNotified: Boolean(booking.family_notified_at || updates.data?.length)
  };
}

router.get('/:id/compliance', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const context = await completionContext(sb, req.params.id);
    try {
      ensureBookingClosureAllowed(context);
      res.json({ ok: true, ready_to_close: true, blockers: [], context });
    } catch (error) {
      if (!(error instanceof BusinessRuleError)) throw error;
      res.json({
        ok: true,
        ready_to_close: false,
        blockers: [{
          code: error.code,
          message: error.message,
          details: error.details || {}
        }],
        context
      });
    }
  } catch (e) { next(e); }
});

router.post('/:id/complete', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const context = await completionContext(sb, req.params.id);
    ensureBookingClosureAllowed(context);

    const { data: event, error: eventError } = await sb.from('trip_events').insert({
      booking_id: req.params.id,
      event_type: 'completed',
      notes: req.body.notes || 'SOP completion checks passed',
      created_by: req.body.completed_by || req.actor?.id || null,
      event_payload: {
        summary_id: context.latestApprovedSummary?.id || null,
        family_notified: context.familyNotified,
        completion_source: 'booking_completion_endpoint'
      }
    }).select('*').single();
    if (eventError) throw eventError;

    const { data: booking, error } = await sb.from('bookings').update({
      status: 'completed',
      service_completed_at: new Date().toISOString(),
      completion_blocked_reason: null
    }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await queueCustomerNotification(sb, booking, 'service_completed', {
      event_id: event.id,
      summary_id: context.latestApprovedSummary?.id || null
    });
    res.json({ ok: true, booking, event });
  } catch (e) {
    if (e instanceof BusinessRuleError) {
      try {
        const sb = getSupabase();
        await sb.from('bookings').update({ completion_blocked_reason: e.message }).eq('id', req.params.id);
      } catch (_) {
        // Keep the original rule error.
      }
    }
    next(e);
  }
});

module.exports = router;
