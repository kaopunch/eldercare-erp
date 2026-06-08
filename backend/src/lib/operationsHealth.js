const STUCK_BOOKING_STATUSES = new Set([
  'draft',
  'pending_dispatch_approval',
  'confirmed',
  'assigned',
  'arrived',
  'onboard',
  'in_progress',
  'incident_hold'
]);

const ACTION_LABELS = {
  failed_notifications: 'Retry or manually send failed customer/team notifications',
  open_severe_incidents: 'Review high and critical incidents before any closure',
  pending_visit_summaries: 'Approve factual visit summaries for completion-ready jobs',
  stuck_bookings: 'Review bookings stuck in active workflow statuses',
  overdue_payments: 'Follow up payment balance and evidence before closing finance'
};

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function hoursUntil(value, now = new Date()) {
  if (!value) return null;
  const ms = new Date(value).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms / 36_000) / 100) / 10;
}

function isWithinHours(value, hours, now = new Date()) {
  const remaining = hoursUntil(value, now);
  return remaining !== null && remaining >= 0 && remaining <= hours;
}

function needsVisitSummaryApproval(booking) {
  const summaries = booking.visit_summaries || [];
  if (!['hospital_companion', 'home_companion', 'medical_coordination', 'family_monitoring'].includes(booking.service_type)) {
    return false;
  }
  return !summaries.some((summary) => summary.status === 'approved' || summary.approved_at);
}

function hasPaymentBalance(booking) {
  const target = numeric(booking.final_price || booking.quoted_price);
  if (target <= 0) return false;
  return booking.payment_status !== 'paid';
}

function pushAction(actions, key, count, severity) {
  if (count <= 0) return;
  actions.push({
    key,
    label: ACTION_LABELS[key],
    count,
    severity
  });
}

function buildOperationsHealth({
  bookings = [],
  incidents = [],
  notifications = [],
  realtimeEvents = [],
  aiTasks = [],
  now = new Date()
} = {}) {
  const bookingRows = bookings || [];
  const openIncidents = (incidents || []).filter((incident) => incident.status !== 'closed');
  const openSevereIncidents = openIncidents.filter((incident) => ['high', 'critical'].includes(incident.severity));
  const failedNotifications = (notifications || []).filter((notification) => ['failed', 'error'].includes(notification.delivery_status || notification.status));
  const failedRealtimeDeliveries = (realtimeEvents || []).filter((event) => ['failed', 'error'].includes(event.delivery_status));
  const pendingVisitSummaries = bookingRows.filter(needsVisitSummaryApproval);
  const stuckBookings = bookingRows.filter((booking) => STUCK_BOOKING_STATUSES.has(booking.status));
  const upcomingHighRisk = bookingRows.filter((booking) => ['high', 'critical'].includes(booking.risk_level) && isWithinHours(booking.pickup_at, 24, now));
  const overduePayments = bookingRows.filter((booking) => ['completed', 'confirmed'].includes(booking.status) && hasPaymentBalance(booking));
  const pendingAiApprovals = (aiTasks || []).filter((task) => ['pending', 'needs_review'].includes(task.approval_status || task.status));

  const actions = [];
  pushAction(actions, 'failed_notifications', failedNotifications.length + failedRealtimeDeliveries.length, 'high');
  pushAction(actions, 'open_severe_incidents', openSevereIncidents.length, 'critical');
  pushAction(actions, 'pending_visit_summaries', pendingVisitSummaries.length, 'medium');
  pushAction(actions, 'stuck_bookings', stuckBookings.length, 'medium');
  pushAction(actions, 'overdue_payments', overduePayments.length, 'medium');

  const criticalCount = actions.filter((action) => action.severity === 'critical').reduce((sum, action) => sum + action.count, 0);
  const highCount = actions.filter((action) => action.severity === 'high').reduce((sum, action) => sum + action.count, 0);

  return {
    status: criticalCount > 0 ? 'critical' : (highCount > 0 ? 'attention' : 'healthy'),
    generated_at: now.toISOString(),
    summary: {
      active_bookings: stuckBookings.length,
      upcoming_high_risk_24h: upcomingHighRisk.length,
      open_incidents: openIncidents.length,
      open_severe_incidents: openSevereIncidents.length,
      failed_notifications: failedNotifications.length + failedRealtimeDeliveries.length,
      pending_visit_summaries: pendingVisitSummaries.length,
      pending_ai_approvals: pendingAiApprovals.length,
      payment_followups: overduePayments.length
    },
    actions,
    watchlists: {
      stuck_bookings: stuckBookings.slice(0, 20).map((booking) => ({
        id: booking.id,
        booking_no: booking.booking_no,
        status: booking.status,
        service_type: booking.service_type,
        pickup_at: booking.pickup_at,
        hours_until_pickup: hoursUntil(booking.pickup_at, now)
      })),
      severe_incidents: openSevereIncidents.slice(0, 20).map((incident) => ({
        id: incident.id,
        booking_id: incident.booking_id,
        severity: incident.severity,
        status: incident.status
      })),
      payment_followups: overduePayments.slice(0, 20).map((booking) => ({
        id: booking.id,
        booking_no: booking.booking_no,
        status: booking.status,
        payment_status: booking.payment_status || 'unknown',
        target_amount: numeric(booking.final_price || booking.quoted_price)
      }))
    }
  };
}

module.exports = {
  buildOperationsHealth,
  needsVisitSummaryApproval
};
