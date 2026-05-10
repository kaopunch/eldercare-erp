
const express = require('express');
const { getSupabase } = require('../db/supabase');
const { buildExecutiveDashboard } = require('../lib/executiveDashboard');
const router = express.Router();

router.get('/summary', async (_, res, next) => {
  try {
    const sb = getSupabase();
    const [drivers, bookings, incidents, aiTasks, verificationChecks, realtimeEvents] = await Promise.all([
      sb.from('drivers').select('id,status,rating_avg,total_jobs'),
      sb.from('bookings')
        .select('id,booking_no,status,risk_level,service_type,final_price,quoted_price,pickup_at,need_care_assistant,family_notified_at,customers(full_name),elders(full_name),assignments(id,status,driver_id,care_assistant_id,drivers(full_name,user_id),care_assistant:app_users!assignments_care_assistant_id_fkey(full_name)),trip_events(event_type,event_at),trip_checklists(checklist_type,completed,completed_at),visit_summaries(status,approved_at),family_updates(id,sent_at)')
        .order('pickup_at', { ascending: true }),
      sb.from('incidents').select('id,booking_id,severity,status'),
      sb.from('ai_admin_tasks').select('id,booking_id,risk_level,approval_status,status'),
      sb.from('verification_checks').select('id,booking_id,task_id,status,check_type'),
      sb.from('realtime_events').select('id,booking_id,event_type,delivery_status,created_at').order('created_at', { ascending: false }).limit(200)
    ]);
    if (drivers.error) throw drivers.error;
    if (bookings.error) throw bookings.error;
    if (incidents.error) throw incidents.error;
    if (aiTasks.error && !['42P01', 'PGRST205'].includes(aiTasks.error.code)) throw aiTasks.error;
    if (verificationChecks.error && !['42P01', 'PGRST205'].includes(verificationChecks.error.code)) throw verificationChecks.error;
    if (realtimeEvents.error && !['42P01', 'PGRST205'].includes(realtimeEvents.error.code)) throw realtimeEvents.error;

    const revenue = bookings.data.reduce((sum, b) => sum + Number(b.final_price || b.quoted_price || 0), 0);
    res.json({
      ok: true,
      summary: {
        active_drivers: drivers.data.filter(d => d.status === 'active').length,
        pending_drivers: drivers.data.filter(d => d.status !== 'active').length,
        total_bookings: bookings.data.length,
        waiting_assignment: bookings.data.filter(b => ['draft','pending_dispatch_approval','confirmed'].includes(b.status)).length,
        high_risk_bookings: bookings.data.filter(b => ['high','critical'].includes(b.risk_level)).length,
        incident_hold_bookings: bookings.data.filter(b => b.status === 'incident_hold').length,
        open_incidents: incidents.data.filter(i => i.status !== 'closed').length,
        escalation_incidents: incidents.data.filter(i => i.status !== 'closed' && ['high','critical'].includes(i.severity)).length,
        revenue
      },
      executive: buildExecutiveDashboard({
        bookings: bookings.data || [],
        incidents: incidents.data || [],
        aiTasks: aiTasks.error ? [] : aiTasks.data || [],
        verificationChecks: verificationChecks.error ? [] : verificationChecks.data || [],
        realtimeEvents: realtimeEvents.error ? [] : realtimeEvents.data || []
      })
    });
  } catch (e) { next(e); }
});

module.exports = router;
