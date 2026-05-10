const express = require('express');
const { getSupabase } = require('../db/supabase');
const {
  ensureAssignmentAllowed,
  calculateAssignmentScore,
  assignmentReason
} = require('../lib/businessRules');

const router = express.Router();

async function getRequiredModuleIds(sb) {
  const { data, error } = await sb.from('training_modules').select('id').eq('required', true);
  if (error) throw error;
  return (data || []).map((module) => module.id);
}

async function hasCompletedRequiredTraining(sb, driverId) {
  const requiredModuleIds = await getRequiredModuleIds(sb);
  if (!requiredModuleIds.length) return true;
  const { data, error } = await sb.from('driver_training_records')
    .select('module_id')
    .eq('driver_id', driverId)
    .eq('status', 'completed')
    .in('module_id', requiredModuleIds);
  if (error) throw error;
  const completed = new Set((data || []).map((record) => record.module_id));
  return requiredModuleIds.every((moduleId) => completed.has(moduleId));
}

async function getAssignmentContext(sb, body) {
  const [booking, driver, requestedVehicle] = await Promise.all([
    sb.from('bookings').select('*').eq('id', body.booking_id).single(),
    sb.from('drivers').select('*').eq('id', body.driver_id).single(),
    body.vehicle_id
      ? sb.from('vehicles').select('*').eq('id', body.vehicle_id).single()
      : Promise.resolve({ data: null, error: null })
  ]);
  if (booking.error) throw booking.error;
  if (driver.error) throw driver.error;
  if (requestedVehicle.error) throw requestedVehicle.error;

  let vehicle = requestedVehicle.data;
  if (!vehicle) {
    const { data: vehicles, error: vehicleError } = await sb.from('vehicles')
      .select('*')
      .eq('status', 'available')
      .order('condition_score', { ascending: false });
    if (vehicleError) throw vehicleError;
    vehicle = (vehicles || []).find((item) => (
      (booking.data.need_wheelchair_support || booking.data.risk_level === 'critical') && item.vehicle_type === 'wheelchair_van'
    )) || (vehicles || [])[0] || null;
  }

  return { booking: booking.data, driver: driver.data, vehicle };
}

async function insertNotificationRows(sb, booking, assignment, driver, careAssistantId) {
  const notifications = [
    {
      booking_id: booking.id,
      assignment_id: assignment.id,
      recipient_user_id: driver.user_id || null,
      notification_type: 'assignment_created',
      payload: { assignment_id: assignment.id, booking_no: booking.booking_no }
    }
  ];

  if (careAssistantId) {
    notifications.push({
      booking_id: booking.id,
      assignment_id: assignment.id,
      recipient_user_id: careAssistantId,
      notification_type: 'care_assistant_assignment_created',
      payload: { assignment_id: assignment.id, booking_no: booking.booking_no }
    });
  }

  const { error } = await sb.from('notifications').insert(notifications);
  if (error) throw error;
}

router.get('/resources', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const [drivers, vehicles, careAssistants, dispatchers] = await Promise.all([
      sb.from('drivers').select('*').eq('status', 'active').order('full_name'),
      sb.from('vehicles').select('*').eq('status', 'available').order('condition_score', { ascending: false }),
      sb.from('app_users').select('id,full_name,phone,role,status,branch_id,company_id').in('role', ['care_assistant', 'hospital_companion', 'home_companion']).eq('status', 'active').order('full_name'),
      sb.from('app_users').select('id,full_name,phone,role,status,branch_id,company_id').eq('role', 'dispatcher').eq('status', 'active').order('created_at')
    ]);
    if (drivers.error) throw drivers.error;
    if (vehicles.error) throw vehicles.error;
    if (careAssistants.error) throw careAssistants.error;
    if (dispatchers.error) throw dispatchers.error;

    res.json({
      ok: true,
      drivers: drivers.data || [],
      vehicles: vehicles.data || [],
      care_assistants: careAssistants.data || [],
      dispatchers: dispatchers.data || [],
      default_dispatcher: (dispatchers.data || [])[0] || null
    });
  } catch (e) { next(e); }
});

router.get('/recommend', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const bookingId = req.query.booking_id;
    const { data: booking, error: bookingError } = await sb.from('bookings').select('*').eq('id', bookingId).single();
    if (bookingError) throw bookingError;

    const [drivers, vehicles] = await Promise.all([
      sb.from('drivers').select('*').eq('status', 'active'),
      sb.from('vehicles').select('*').eq('status', 'available')
    ]);
    if (drivers.error) throw drivers.error;
    if (vehicles.error) throw vehicles.error;

    const recommendations = [];
    for (const driver of drivers.data || []) {
      const hasRequiredTraining = await hasCompletedRequiredTraining(sb, driver.id);
      const vehicle = (vehicles.data || []).find((item) => item.vehicle_type === 'wheelchair_van')
        || (vehicles.data || [])[0]
        || null;
      try {
        ensureAssignmentAllowed({
          booking,
          driver,
          vehicle,
          hasRequiredTraining,
          careAssistantId: req.query.care_assistant_id || booking.need_care_assistant ? req.query.care_assistant_id || 'recommended' : null
        });
        recommendations.push({
          driver,
          vehicle,
          assignment_score: calculateAssignmentScore({ booking, driver, vehicle, hasRequiredTraining }),
          assignment_reason: assignmentReason({ booking, driver, vehicle, hasRequiredTraining })
        });
      } catch (error) {
        recommendations.push({
          driver,
          vehicle,
          eligible: false,
          blocked_reason: error.message
        });
      }
    }

    recommendations.sort((a, b) => (b.assignment_score || 0) - (a.assignment_score || 0));
    res.json({ ok: true, booking, recommendations });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { booking, driver, vehicle } = await getAssignmentContext(sb, req.body);
    const hasRequiredTraining = await hasCompletedRequiredTraining(sb, driver.id);

    ensureAssignmentAllowed({
      booking,
      driver,
      vehicle,
      hasRequiredTraining,
      careAssistantId: req.body.care_assistant_id || null
    });

    const assignment_score = calculateAssignmentScore({ booking, driver, vehicle, hasRequiredTraining });
    const assignment_reason = req.body.assignment_reason || assignmentReason({ booking, driver, vehicle, hasRequiredTraining });
    const payload = {
      booking_id: req.body.booking_id,
      driver_id: req.body.driver_id,
      care_assistant_id: req.body.care_assistant_id || null,
      vehicle_id: vehicle?.id || null,
      assigned_by: req.body.assigned_by || null,
      assignment_score,
      assignment_reason,
      notification_payload: {
        booking_no: booking.booking_no,
        service_type: booking.service_type,
        pickup_at: booking.pickup_at,
        risk_level: booking.risk_level
      },
      status: 'assigned'
    };

    const { data: existing, error: existingError } = await sb.from('assignments')
      .select('id')
      .eq('booking_id', booking.id)
      .in('status', ['assigned', 'accepted'])
      .order('assigned_at', { ascending: false })
      .limit(1);
    if (existingError) throw existingError;

    const write = existing?.[0]
      ? sb.from('assignments').update({ ...payload, assigned_at: new Date().toISOString() }).eq('id', existing[0].id).select('*').single()
      : sb.from('assignments').insert(payload).select('*').single();

    const { data, error } = await write;
    if (error) throw error;

    await sb.from('bookings').update({ status: 'assigned' }).eq('id', booking.id);
    await insertNotificationRows(sb, booking, data, driver, req.body.care_assistant_id || null);

    res.status(201).json({ ok: true, assignment: data });
  } catch (e) { next(e); }
});

router.post('/:id/accept', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('assignments').update({
      status: 'accepted',
      accepted_at: new Date().toISOString()
    }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await sb.from('trip_events').insert({
      booking_id: data.booking_id,
      assignment_id: data.id,
      event_type: 'driver_accepted',
      created_by: req.body.created_by || null,
      event_payload: { accepted_source: req.body.accepted_source || 'driver_app' }
    });
    res.json({ ok: true, assignment: data });
  } catch (e) { next(e); }
});

router.post('/:id/reject', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('assignments').update({
      status: 'rejected',
      rejected_reason: req.body.rejected_reason || 'not specified'
    }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await sb.from('notifications').insert({
      booking_id: data.booking_id,
      assignment_id: data.id,
      notification_type: 'assignment_rejected',
      payload: { assignment_id: data.id, rejected_reason: data.rejected_reason }
    });
    res.json({ ok: true, assignment: data });
  } catch (e) { next(e); }
});

module.exports = router;
