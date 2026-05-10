const STATUS_ORDER = ['confirmed', 'assigned', 'monitor', 'completed'];

const TRIP_PROGRESS_EVENTS = [
  'driver_accepted',
  'pre_trip',
  'arrived_pickup',
  'patient_onboarded',
  'trip_started',
  'arrived_dropoff',
  'handover_completed',
  'completed'
];

const SERVICE_PROGRESS_EVENTS = {
  hospital_companion: ['t24_confirmation', 't2_review', 'arrived_at_location', 'patient_checked_in', 'in_consultation', 'family_update', 'visit_summary_submitted', 'completed'],
  home_companion: ['pre_visit', 'arrived_at_location', 'home_check_in', 'midpoint_update', 'home_check_out', 'family_update', 'visit_summary_submitted', 'completed'],
  medical_coordination: ['pre_visit', 'coordination_started', 'family_update', 'coordination_completed', 'visit_summary_submitted', 'completed'],
  family_monitoring: ['pre_visit', 'monitoring_started', 'family_update', 'monitoring_completed', 'visit_summary_submitted', 'completed']
};

function relationFirst(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function normalizeExecutiveStatus(status, riskLevel) {
  const map = {
    draft: 'confirmed',
    pending_quote: 'confirmed',
    quote_draft: 'confirmed',
    quoted: 'confirmed',
    pending_customer_confirmation: 'confirmed',
    pending_dispatch_approval: 'confirmed',
    customer_confirmed: 'confirmed',
    confirmed: 'confirmed',
    assigned: riskLevel === 'high' || riskLevel === 'critical' ? 'monitor' : 'assigned',
    driver_accepted: 'assigned',
    arrived: 'monitor',
    onboard: 'monitor',
    en_route_pickup: 'monitor',
    passenger_onboard: 'monitor',
    in_progress: 'monitor',
    incident_hold: 'monitor',
    completed: 'completed',
    closed: 'completed'
  };
  return map[status] || status || 'confirmed';
}

function eventTypesForBooking(booking = {}) {
  const events = (booking.trip_events || []).map((event) => event.event_type).filter(Boolean);
  if ((booking.trip_checklists || []).some((checklist) => checklist.checklist_type === 'pre_trip' && checklist.completed)) {
    events.push('pre_trip');
  }
  if ((booking.trip_checklists || []).some((checklist) => checklist.checklist_type === 'pre_visit' && checklist.completed)) events.push('pre_visit');
  if ((booking.trip_checklists || []).some((checklist) => checklist.checklist_type === 't24_confirmation' && checklist.completed)) events.push('t24_confirmation');
  if ((booking.trip_checklists || []).some((checklist) => checklist.checklist_type === 't2_review' && checklist.completed)) events.push('t2_review');
  if (['driver_accepted', 'arrived', 'onboard', 'in_progress', 'completed'].includes(booking.status)) {
    events.push('driver_accepted');
  }
  if (['arrived', 'onboard', 'in_progress', 'completed'].includes(booking.status)) events.push('arrived_pickup');
  if (['onboard', 'in_progress', 'completed'].includes(booking.status)) events.push('patient_onboarded', 'elder_onboard');
  if (['in_progress', 'completed'].includes(booking.status)) events.push('trip_started');
  if (booking.status === 'completed') events.push('arrived_dropoff', 'handover_completed', 'trip_completed', 'completed');
  if (events.includes('elder_onboard')) events.push('patient_onboarded');
  if (events.includes('trip_completed')) events.push('completed');
  return [...new Set(events)];
}

function bookingProgress(booking = {}) {
  const events = eventTypesForBooking(booking);
  const progressEvents = SERVICE_PROGRESS_EVENTS[booking.service_type] || TRIP_PROGRESS_EVENTS;
  const completed = progressEvents.filter((eventType) => events.includes(eventType)).length;
  const eventProgress = Math.round((completed / progressEvents.length) * 100);
  const normalizedStatus = normalizeExecutiveStatus(booking.status, booking.risk_level);
  const minimumByStatus = {
    confirmed: 20,
    assigned: 45,
    monitor: 60,
    completed: 100
  };
  return Math.min(100, Math.max(eventProgress, minimumByStatus[normalizedStatus] || 0));
}

function latestAssignment(booking = {}) {
  const assignments = Array.isArray(booking.assignments) ? booking.assignments : [];
  return assignments[0] || {};
}

function groupedByBooking(rows = []) {
  return rows.reduce((memo, row) => {
    if (!row.booking_id) return memo;
    if (!memo[row.booking_id]) memo[row.booking_id] = [];
    memo[row.booking_id].push(row);
    return memo;
  }, {});
}

function alertItem(code, severity, label) {
  return { code, severity, label };
}

function bookingAlerts({ booking, incidents = [], aiTasks = [], checks = [] }) {
  const assignment = latestAssignment(booking);
  const alerts = [];
  const openIncidents = incidents.filter((incident) => incident.status !== 'closed');
  const openAiTasks = aiTasks.filter((task) => !['approved', 'completed', 'cancelled'].includes(task.approval_status));
  const pendingChecks = checks.filter((check) => ['pending', 'failed', 'rejected', 'warning'].includes(check.status));
  const summaryRequired = ['hospital_companion', 'home_companion', 'medical_coordination', 'family_monitoring'].includes(booking.service_type);
  const hasApprovedSummary = (booking.visit_summaries || []).some((summary) => summary.status === 'approved');
  const familyNotified = Boolean(booking.family_notified_at || (booking.family_updates || []).length);

  if (!assignment.driver_id) alerts.push(alertItem('no_driver', 'critical', 'Driver not assigned'));
  if (booking.need_care_assistant && !assignment.care_assistant_id) {
    alerts.push(alertItem('no_assistant', 'warn', 'Care assistant not assigned'));
  }
  if (['high', 'critical'].includes(booking.risk_level)) {
    alerts.push(alertItem('high_risk', booking.risk_level === 'critical' ? 'critical' : 'warn', 'High-risk booking'));
  }
  if (booking.status === 'incident_hold' || openIncidents.length) {
    const severe = openIncidents.some((incident) => ['high', 'critical'].includes(incident.severity));
    alerts.push(alertItem('open_incident', severe ? 'critical' : 'warn', 'Open incident linked'));
  }
  if (summaryRequired && !hasApprovedSummary && ['in_progress', 'incident_hold', 'completed'].includes(booking.status)) {
    alerts.push(alertItem('summary_required', booking.status === 'completed' ? 'critical' : 'warn', 'Visit summary approval required'));
  }
  if (!familyNotified && ['in_progress', 'incident_hold', 'completed'].includes(booking.status)) {
    alerts.push(alertItem('family_update_missing', booking.status === 'completed' ? 'critical' : 'warn', 'Family update not documented'));
  }
  if (openAiTasks.length) alerts.push(alertItem('ai_review', 'warn', 'AI review pending'));
  if (pendingChecks.length) alerts.push(alertItem('verification_pending', 'warn', 'Verification checks pending'));

  const severity = alerts.some((item) => item.severity === 'critical') ? 'critical' : (alerts.length ? 'warn' : 'ok');
  return { items: alerts, severity };
}

function buildExecutiveDashboard({
  bookings = [],
  incidents = [],
  aiTasks = [],
  verificationChecks = [],
  realtimeEvents = []
} = {}) {
  const incidentsByBooking = groupedByBooking(incidents);
  const tasksByBooking = groupedByBooking(aiTasks);
  const checksByBooking = groupedByBooking(verificationChecks);
  const totalJobs = bookings.length;
  const denominator = totalJobs || 1;

  const jobs = bookings.map((booking) => {
    const elder = relationFirst(booking.elders) || {};
    const customer = relationFirst(booking.customers) || {};
    const assignment = latestAssignment(booking);
    const driver = relationFirst(assignment.drivers) || {};
    const careAssistant = relationFirst(assignment.care_assistant) || {};
    const alerts = bookingAlerts({
      booking,
      incidents: incidentsByBooking[booking.id] || [],
      aiTasks: tasksByBooking[booking.id] || [],
      checks: checksByBooking[booking.id] || []
    });
    const progress = bookingProgress(booking);
    const normalizedStatus = normalizeExecutiveStatus(booking.status, booking.risk_level);
    return {
      booking_id: booking.id,
      booking_no: booking.booking_no || booking.id,
      pickup_at: booking.pickup_at || null,
      elder_name: elder.full_name || '-',
      customer_name: customer.full_name || '-',
      service_type: booking.service_type || null,
      raw_status: booking.status || null,
      status: normalizedStatus,
      risk_level: booking.risk_level || 'low',
      progress,
      driver_name: driver.full_name || null,
      care_assistant_name: careAssistant.full_name || null,
      alert_count: alerts.items.length,
      alert_severity: alerts.severity,
      alerts: alerts.items
    };
  });

  const progressSum = jobs.reduce((sum, job) => sum + job.progress, 0);
  const needAttention = jobs.filter((job) => job.alert_count > 0).length;
  const assignedJobs = jobs.filter((job) => job.driver_name).length;

  const statusChart = STATUS_ORDER.map((status) => {
    const count = jobs.filter((job) => job.status === status).length;
    return {
      status,
      count,
      percent: Math.round((count / denominator) * 100)
    };
  });

  const alerts = jobs.flatMap((job) => job.alerts.map((alert) => ({
    booking_id: job.booking_id,
    booking_no: job.booking_no,
    pickup_at: job.pickup_at,
    elder_name: job.elder_name,
    status: job.status,
    code: alert.code,
    severity: alert.severity,
    label: alert.label
  })));

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total_jobs: totalJobs,
      avg_progress: Math.round(progressSum / denominator),
      on_track: Math.max(0, totalJobs - needAttention),
      need_attention: needAttention,
      assigned_rate: Math.round((assignedJobs / denominator) * 100),
      critical_alerts: alerts.filter((alert) => alert.severity === 'critical').length
    },
    status_chart: statusChart,
    jobs,
    alerts,
    ai: {
      open_tasks: aiTasks.filter((task) => !['approved', 'completed', 'cancelled'].includes(task.approval_status)).length,
      high_risk_tasks: aiTasks.filter((task) => ['high', 'critical'].includes(task.risk_level)).length,
      pending_checks: verificationChecks.filter((check) => ['pending', 'failed', 'rejected', 'warning'].includes(check.status)).length,
      realtime_events: realtimeEvents.length
    }
  };
}

module.exports = {
  STATUS_ORDER,
  bookingProgress,
  buildExecutiveDashboard,
  normalizeExecutiveStatus
};
