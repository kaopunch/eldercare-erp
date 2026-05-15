const { workflowTemplateForService } = require('./businessRules');

const ACTIVE_STATUSES = new Set([
  'confirmed',
  'assigned',
  'driver_accepted',
  'arrived',
  'onboard',
  'in_progress',
  'incident_hold',
  'completed'
]);

const EVENT_ALIASES = {
  patient_onboarded: 'elder_onboard',
  completed: 'trip_completed'
};

const EVENT_LABELS = {
  confirmed: 'Booking confirmed',
  staff_assigned: 'Care team assigned',
  driver_accepted: 'Driver accepted',
  arrived_pickup: 'Arrived at pickup',
  arrived_at_location: 'Arrived at service location',
  identity_verified: 'Identity verified',
  pickup_condition_checked: 'Pickup condition checked',
  elder_onboard: 'Elder onboard',
  trip_started: 'Trip started',
  service_started: 'Service started',
  patient_checked_in: 'Checked in',
  in_consultation: 'In consultation',
  lab_or_xray: 'Lab or X-ray',
  pharmacy: 'Pharmacy completed',
  home_check_in: 'Home check-in',
  midpoint_update: 'Midpoint family update',
  home_check_out: 'Home check-out',
  coordination_started: 'Coordination started',
  coordination_update: 'Coordination update',
  coordination_completed: 'Coordination completed',
  monitoring_started: 'Monitoring started',
  monitoring_completed: 'Monitoring completed',
  family_update: 'Family updated',
  visit_summary_submitted: 'Care summary submitted',
  arrived_dropoff: 'Arrived at dropoff',
  handover_completed: 'Handover completed',
  trip_completed: 'Service completed'
};

const EVENT_MESSAGES = {
  confirmed: 'Your booking is confirmed and the team is preparing the service.',
  staff_assigned: 'A care team has been assigned for this booking.',
  driver_accepted: 'The driver has accepted the job.',
  arrived_pickup: 'The team has arrived at the pickup location.',
  arrived_at_location: 'The team has arrived at the service location.',
  identity_verified: 'Identity and booking details were checked.',
  pickup_condition_checked: 'The team recorded the pickup condition before departure.',
  elder_onboard: 'The elder is safely onboard.',
  trip_started: 'The trip has started.',
  service_started: 'The service has started.',
  patient_checked_in: 'The elder has checked in at the appointment location.',
  in_consultation: 'The elder is in consultation.',
  lab_or_xray: 'Lab or X-ray step is in progress or completed.',
  pharmacy: 'Pharmacy pickup step is completed.',
  home_check_in: 'The care assistant has checked in at home.',
  midpoint_update: 'A midpoint update was sent to the family.',
  home_check_out: 'The care assistant has checked out from the home visit.',
  coordination_started: 'Medical coordination has started.',
  coordination_update: 'The family received a coordination update.',
  coordination_completed: 'Medical coordination is completed.',
  monitoring_started: 'Family monitoring has started.',
  monitoring_completed: 'Family monitoring is completed.',
  family_update: 'A factual update was shared with the family.',
  visit_summary_submitted: 'The post-service care summary is ready or under review.',
  arrived_dropoff: 'The team has arrived at the dropoff location.',
  handover_completed: 'The handover was completed.',
  trip_completed: 'The service was completed.'
};

const EVENT_STATUS_IMPLICATIONS = {
  driver_accepted: ['driver_accepted', 'arrived', 'onboard', 'in_progress', 'completed'],
  arrived_pickup: ['arrived', 'onboard', 'in_progress', 'completed'],
  elder_onboard: ['onboard', 'in_progress', 'completed'],
  trip_started: ['in_progress', 'completed'],
  arrived_dropoff: ['completed'],
  handover_completed: ['completed'],
  trip_completed: ['completed']
};

function firstRelation(value) {
  return Array.isArray(value) ? value[0] : value;
}

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeEventType(type) {
  return EVENT_ALIASES[type] || type;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function workflowEventsForBooking(booking = {}) {
  const snapshotEvents = Array.isArray(booking.workflow_snapshot?.required_events)
    ? booking.workflow_snapshot.required_events
    : null;
  const templateEvents = snapshotEvents || workflowTemplateForService(booking.service_type || 'elderly_transport').required_events;
  const normalized = templateEvents.map(normalizeEventType);
  const baseline = ['confirmed', 'staff_assigned'];
  if (!normalized.includes('driver_accepted')) baseline.push('driver_accepted');
  return unique([...baseline, ...normalized]);
}

function eventByNormalizedType(events = []) {
  return events.reduce((map, event) => {
    const key = normalizeEventType(event.event_type);
    if (!map[key]) map[key] = event;
    return map;
  }, {});
}

function isTimelineStepDone(stepKey, { booking = {}, eventMap = {}, assignment = null }) {
  const status = booking.status || '';
  if (stepKey === 'confirmed') return ACTIVE_STATUSES.has(status) || Boolean(booking.confirmed_at);
  if (stepKey === 'staff_assigned') return Boolean(assignment?.id) || ['assigned', 'driver_accepted', 'arrived', 'onboard', 'in_progress', 'completed'].includes(status);
  if (eventMap[stepKey]) return true;
  if (stepKey === 'trip_completed' && status === 'completed') return true;
  return (EVENT_STATUS_IMPLICATIONS[stepKey] || []).includes(status);
}

function buildCustomerJourney({ booking = {}, events = [], assignment = null } = {}) {
  const eventMap = eventByNormalizedType(events);
  const stepKeys = workflowEventsForBooking(booking);
  const steps = stepKeys.map((key) => {
    const event = eventMap[key] || null;
    const done = isTimelineStepDone(key, { booking, eventMap, assignment });
    return {
      key,
      label: EVENT_LABELS[key] || key,
      customer_message: EVENT_MESSAGES[key] || 'The team updated this step.',
      done,
      active: false,
      event_at: event?.event_at || null,
      notes: event?.notes || null,
      payload: event?.event_payload || {}
    };
  });
  const firstOpenIndex = steps.findIndex((step) => !step.done);
  const activeIndex = firstOpenIndex === -1 ? Math.max(steps.length - 1, 0) : firstOpenIndex;
  if (steps[activeIndex]) steps[activeIndex].active = true;
  const doneCount = steps.filter((step) => step.done).length;
  const progress = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;
  const current = steps[activeIndex] || null;
  const latestCompleted = [...steps].reverse().find((step) => step.done) || null;

  return {
    progress,
    current_step_key: current?.key || null,
    current_step_label: current?.label || null,
    latest_completed_key: latestCompleted?.key || null,
    latest_completed_label: latestCompleted?.label || null,
    last_updated_at: latestCompleted?.event_at || booking.service_completed_at || booking.confirmed_at || booking.pickup_at || null,
    status_headline: current?.done ? 'Service completed' : (current?.label || 'Preparing service'),
    status_detail: current?.customer_message || 'The care team is preparing this booking.',
    steps
  };
}

function buildTrustCard({
  assignment = {},
  driver = {},
  careAssistant = {},
  vehicle = {},
  driverDocuments = [],
  driverTrainingRecords = []
} = {}) {
  const verifiedDocuments = driverDocuments.filter((doc) => doc.verified === true).length;
  const completedTraining = driverTrainingRecords.filter((record) => record.status === 'completed').length;
  const driverReady = Boolean(driver.full_name);
  const assistantReady = Boolean(careAssistant.full_name);
  const vehicleReady = Boolean(vehicle.plate_number);
  const driverCard = {
    id: driver.id || assignment.driver_id || null,
    name: driver.full_name || null,
    full_name: driver.full_name || null,
    phone: driver.phone || null,
    line_id: driver.line_id || null,
    role: 'Driver',
    detail: [
      driver.driver_level ? `${driver.driver_level} level` : null,
      driver.rating_avg ? `rating ${driver.rating_avg}` : null,
      driver.total_jobs ? `${driver.total_jobs} jobs` : null
    ].filter(Boolean).join(' / ') || null,
    driver_level: driver.driver_level || null,
    status: driver.status || null,
    rating_avg: numeric(driver.rating_avg),
    total_jobs: numeric(driver.total_jobs),
    verified_documents: verifiedDocuments,
    completed_training: completedTraining,
    badges: [
      driver.driver_level ? `${driver.driver_level} level` : null,
      verifiedDocuments ? `${verifiedDocuments} verified docs` : null,
      completedTraining ? `${completedTraining} trainings` : null,
      driver.status === 'active' ? 'active' : null
    ].filter(Boolean)
  };
  const careAssistantCard = {
    id: careAssistant.id || assignment.care_assistant_id || null,
    name: careAssistant.full_name || null,
    full_name: careAssistant.full_name || null,
    phone: careAssistant.phone || null,
    role: careAssistant.role || 'Care assistant',
    detail: [
      careAssistant.role || null,
      careAssistant.status === 'active' ? 'active' : null
    ].filter(Boolean).join(' / ') || null,
    status: careAssistant.status || null,
    badges: [
      careAssistant.role ? careAssistant.role : null,
      careAssistant.status === 'active' ? 'active' : null
    ].filter(Boolean)
  };
  const vehicleCard = {
    id: vehicle.id || assignment.vehicle_id || null,
    name: vehicle.plate_number || null,
    plate_no: vehicle.plate_number || null,
    license_plate: vehicle.plate_number || null,
    plate_number: vehicle.plate_number || null,
    vehicle_type: vehicle.vehicle_type || null,
    detail: [
      vehicle.vehicle_type || null,
      vehicle.condition_score ? `condition ${vehicle.condition_score}` : null,
      vehicle.public_transport_license_status ? `license ${vehicle.public_transport_license_status}` : null
    ].filter(Boolean).join(' / ') || null,
    status: vehicle.status || null,
    condition_score: vehicle.condition_score || null,
    public_transport_license_status: vehicle.public_transport_license_status || null,
    insurance_expiry: vehicle.insurance_expiry || null
  };

  return {
    assignment_status: assignment.status || null,
    ready: driverReady || assistantReady || vehicleReady,
    driver: driverCard,
    assistant: careAssistantCard,
    care_assistant: careAssistantCard,
    vehicle: vehicleCard,
    safety_promises: [
      'Identity, route, mobility, and consent are checked before service.',
      'Family updates are factual and avoid medical diagnosis.',
      'High-risk incidents pause completion until an admin review is finished.'
    ]
  };
}

function buildCareSummary({ booking = {}, summaries = [], familyUpdates = [] } = {}) {
  const approvedSummary = (summaries || []).find((summary) => summary.status === 'approved') || null;
  const latestUpdate = (familyUpdates || [])[0] || null;
  return {
    available: Boolean(approvedSummary),
    status: approvedSummary ? 'approved' : (booking.status === 'completed' ? 'pending_summary' : 'not_ready'),
    visit_outcome: approvedSummary?.visit_outcome || null,
    medication_pickup_status: approvedSummary?.medication_pickup_status || null,
    next_appointment: approvedSummary?.next_appointment || null,
    follow_up_requirement: approvedSummary?.follow_up_requirement || null,
    family_summary: approvedSummary?.family_summary || null,
    approved_at: approvedSummary?.approved_at || null,
    latest_family_update: latestUpdate ? {
      update_type: latestUpdate.update_type,
      channel: latestUpdate.channel,
      message: latestUpdate.message,
      sent_at: latestUpdate.sent_at,
      recipient_name: latestUpdate.recipient_name || null
    } : null
  };
}

function buildNextAction({ booking = {}, finance = {}, rating = {}, links = {}, careSummary = {}, trustCard = {} } = {}) {
  if (['cancelled', 'no_show'].includes(booking.status)) {
    return {
      key: 'contact_support',
      priority: 'medium',
      title: 'Contact support',
      body: 'This booking is not active. Contact the team if you need help.',
      action_label: 'Open status',
      action_url: links.status || null
    };
  }
  if (numeric(finance.balance) > 0 && ['confirmed', 'assigned', 'driver_accepted', 'arrived', 'onboard', 'in_progress', 'completed'].includes(booking.status)) {
    return {
      key: 'pay_balance',
      priority: 'high',
      title: 'Payment balance pending',
      body: 'Please check the invoice or payment instruction before service completion.',
      action_label: 'View payment',
      action_url: links.status || null
    };
  }
  if (!ACTIVE_STATUSES.has(booking.status)) {
    return {
      key: 'wait_team_review',
      priority: 'medium',
      title: 'Waiting for team review',
      body: 'The team is checking price, consent, risk level, and staff availability.',
      action_label: 'Refresh status',
      action_url: links.status || null
    };
  }
  if (!trustCard.ready && ['confirmed', 'assigned'].includes(booking.status)) {
    return {
      key: 'wait_staff_assignment',
      priority: 'medium',
      title: 'Care team assignment pending',
      body: 'The coordinator is matching a suitable driver, vehicle, and care assistant.',
      action_label: 'Refresh status',
      action_url: links.status || null
    };
  }
  if (booking.status === 'completed' && careSummary.available && rating.can_rate && !rating.latest) {
    return {
      key: 'rate_service',
      priority: 'high',
      title: 'Review this service',
      body: 'Your feedback helps the team improve quality and follow up quickly.',
      action_label: 'Give rating',
      action_url: links.rating || links.status || null
    };
  }
  if (booking.status === 'completed') {
    return {
      key: 'service_complete',
      priority: 'low',
      title: 'Service completed',
      body: careSummary.available ? 'The care summary is available for family review.' : 'The team is finalizing the care summary.',
      action_label: 'View summary',
      action_url: links.status || null
    };
  }
  return {
    key: 'watch_live_status',
    priority: 'low',
    title: 'Follow live status',
    body: 'This portal will show each confirmed service step as the team updates the job.',
    action_label: 'Refresh status',
    action_url: links.status || null
  };
}

function buildLineExperience({ booking = {}, lineConfigured = false, links = {} } = {}) {
  const customer = firstRelation(booking.customers) || booking.customer || {};
  const hasLineRecipient = Boolean(customer.line_id);
  return {
    configured: Boolean(lineConfigured),
    recipient_ready: hasLineRecipient,
    status: lineConfigured && hasLineRecipient
      ? 'ready'
      : (lineConfigured ? 'needs_line_id' : 'mock_or_manual'),
    customer_line_id: customer.line_id || null,
    preferred_channel: booking.preferred_communication_channel || (hasLineRecipient ? 'line' : 'phone'),
    status_url: links.status || null,
    touchpoints: [
      { key: 'booking_confirmed', label: 'Booking confirmation' },
      { key: 'staff_assigned', label: 'Care team and vehicle details' },
      { key: 'trip_started', label: 'Trip/service progress updates' },
      { key: 'summary_approved', label: 'Post-service care summary' },
      { key: 'rating_request', label: 'Rating and follow-up' }
    ]
  };
}

function buildServiceRecovery({ latestRating = null, latestQualityReview = null } = {}) {
  const ratingValue = Number(latestRating?.rating || 0);
  const reviewResult = latestQualityReview?.review_result || null;
  const active = ratingValue > 0 && ratingValue <= 2;
  return {
    active,
    status: active ? 'opened' : 'not_required',
    rating: latestRating || null,
    quality_review: latestQualityReview || null,
    review_result: reviewResult,
    title: active ? 'Service recovery opened' : 'No service recovery needed',
    body: active
      ? 'A coordinator should contact the family, review the case, and record the recovery action.'
      : 'No low-rating recovery workflow is currently active.',
    next_step: active ? 'coordinator_follow_up' : null
  };
}

module.exports = {
  buildCareSummary,
  buildCustomerJourney,
  buildLineExperience,
  buildNextAction,
  buildServiceRecovery,
  buildTrustCard,
  normalizeEventType,
  workflowEventsForBooking
};
