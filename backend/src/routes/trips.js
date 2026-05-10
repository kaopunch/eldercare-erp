const express = require('express');
const { getSupabase } = require('../db/supabase');
const {
  ensureTripEventAllowed,
  bookingStatusForTripEvent
} = require('../lib/businessRules');
const { queueCustomerNotification } = require('../lib/notifications');

const router = express.Router();
const TRIP_NOTIFICATION_TYPES = {
  driver_accepted: 'trip_driver_accepted',
  arrived_pickup: 'trip_arrived_pickup',
  arrived_at_location: 'arrived_at_location',
  elder_onboard: 'trip_elder_onboard',
  patient_onboarded: 'patient_onboarded',
  trip_started: 'trip_started',
  service_started: 'service_started',
  patient_checked_in: 'patient_checked_in',
  in_consultation: 'consultation_started',
  lab_or_xray: 'lab_or_xray',
  pharmacy: 'pharmacy_completed',
  home_check_in: 'home_check_in',
  midpoint_update: 'midpoint_update',
  home_check_out: 'home_check_out',
  coordination_started: 'coordination_started',
  coordination_update: 'coordination_update',
  coordination_completed: 'coordination_completed',
  monitoring_started: 'monitoring_started',
  monitoring_completed: 'monitoring_completed',
  family_update: 'family_update',
  visit_summary_submitted: 'visit_summary_submitted',
  arrived_dropoff: 'trip_arrived_dropoff',
  handover_completed: 'trip_handover_completed',
  trip_completed: 'trip_completed',
  completed: 'service_completed'
};

async function getBooking(sb, bookingId) {
  const { data, error } = await sb.from('bookings').select('*').eq('id', bookingId).single();
  if (error) throw error;
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

async function hasCompletedPreServiceChecklist(sb, bookingId) {
  const { data, error } = await sb.from('trip_checklists')
    .select('id')
    .eq('booking_id', bookingId)
    .in('checklist_type', ['pre_trip', 'pre_visit', 't24_confirmation', 't2_review'])
    .eq('completed', true)
    .limit(1);
  if (error) throw error;
  return Boolean(data.length);
}

async function recordTripEvent(sb, bookingId, body) {
  const booking = await getBooking(sb, bookingId);
  const existingEvents = await getExistingEvents(sb, bookingId);
  const hasPreTripChecklist = await hasCompletedPreServiceChecklist(sb, bookingId);
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

  const notificationType = TRIP_NOTIFICATION_TYPES[body.event_type];
  if (notificationType) {
    await queueCustomerNotification(sb, booking, notificationType, {
      assignment_id: body.assignment_id || null,
      event_id: data.id,
      event_type: body.event_type,
      event_at: data.event_at,
      notes: body.notes || null,
      status_after_event: nextStatus || booking.status
    });
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

router.post('/:booking_id/checklist', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const completed = Boolean(req.body.completed);
    const { data, error } = await sb.from('trip_checklists').insert({
      booking_id: req.params.booking_id,
      assignment_id: req.body.assignment_id || null,
      checklist_type: req.body.checklist_type,
      items: req.body.items || [],
      completed,
      completed_by: req.body.completed_by || null,
      completed_at: completed ? new Date().toISOString() : null
    }).select('*').single();
    if (error) throw error;
    res.status(201).json({ ok: true, checklist: data });
  } catch (e) { next(e); }
});

router.post('/:booking_id/events', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const event = await recordTripEvent(sb, req.params.booking_id, req.body);
    res.status(201).json({ ok: true, event });
  } catch (e) { next(e); }
});

router.post('/:booking_id/location', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('trip_locations').insert({
      booking_id: req.params.booking_id,
      assignment_id: req.body.assignment_id || null,
      lat: req.body.lat,
      lng: req.body.lng,
      speed: req.body.speed || null,
      recorded_at: req.body.recorded_at || new Date().toISOString()
    }).select('*').single();
    if (error) throw error;
    res.status(201).json({ ok: true, location: data });
  } catch (e) { next(e); }
});

router.post('/:booking_id/complete', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const event = await recordTripEvent(sb, req.params.booking_id, {
      ...req.body,
      event_type: 'trip_completed',
      event_payload: {
        care_assistant_note: req.body.care_assistant_note || null,
        completion_note: req.body.completion_note || null,
        summary_id: req.body.summary_id || null,
        visit_summary_approved: Boolean(req.body.visit_summary_approved)
      }
    });
    res.json({ ok: true, event });
  } catch (e) { next(e); }
});

module.exports = router;
