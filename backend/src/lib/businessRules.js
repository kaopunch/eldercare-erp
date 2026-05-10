const SERVICE_TYPE_VALUES = [
  'basic_ride',
  'assisted_ride',
  'elderly_transport',
  'hospital_companion',
  'home_companion',
  'medical_coordination',
  'family_monitoring',
  'monthly_transport'
];
const SERVICE_TYPES = new Set(SERVICE_TYPE_VALUES);
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const REQUIRED_EXECUTION_CONSENTS = [
  'general_service',
  'sensitive_health',
  'family_notification',
  'photo'
];
const TRANSPORT_SERVICE_TYPES = new Set(['basic_ride', 'assisted_ride', 'elderly_transport', 'monthly_transport']);
const COMPANION_SERVICE_TYPES = new Set(['hospital_companion', 'home_companion']);
const VISIT_SUMMARY_SERVICE_TYPES = new Set([
  'hospital_companion',
  'home_companion',
  'medical_coordination',
  'family_monitoring'
]);
const DRIVER_LEVEL_RANK = {
  blacklist: -1,
  bronze: 1,
  silver: 2,
  gold: 3
};

const WORKFLOW_TEMPLATES = {
  basic_ride: {
    code: 'transport_standard_v2',
    title: 'Elderly transport workflow',
    required_events: ['driver_accepted', 'arrived_pickup', 'patient_onboarded', 'trip_started', 'arrived_dropoff', 'handover_completed', 'completed'],
    optional_events: ['identity_verified', 'pickup_condition_checked', 'family_update'],
    required_checklists: ['pre_trip'],
    summary_required: false
  },
  assisted_ride: {
    code: 'transport_assisted_v2',
    title: 'Assisted elderly transport workflow',
    required_events: ['driver_accepted', 'arrived_pickup', 'identity_verified', 'pickup_condition_checked', 'patient_onboarded', 'trip_started', 'arrived_dropoff', 'handover_completed', 'completed'],
    optional_events: ['family_update'],
    required_checklists: ['pre_trip'],
    summary_required: false
  },
  elderly_transport: {
    code: 'elderly_transport_v2',
    title: 'Elderly transport workflow',
    required_events: ['driver_accepted', 'arrived_pickup', 'patient_onboarded', 'trip_started', 'arrived_dropoff', 'handover_completed', 'completed'],
    optional_events: ['identity_verified', 'pickup_condition_checked', 'family_update'],
    required_checklists: ['pre_trip'],
    summary_required: false
  },
  monthly_transport: {
    code: 'transport_recurring_v2',
    title: 'Recurring elderly transport workflow',
    required_events: ['driver_accepted', 'arrived_pickup', 'patient_onboarded', 'trip_started', 'arrived_dropoff', 'handover_completed', 'completed'],
    optional_events: ['identity_verified', 'pickup_condition_checked', 'return_pickup', 'return_trip_started', 'return_handover_completed', 'family_update'],
    required_checklists: ['pre_trip'],
    summary_required: false
  },
  hospital_companion: {
    code: 'hospital_companion_v2',
    title: 'Hospital companion workflow',
    required_events: ['arrived_at_location', 'patient_checked_in', 'in_consultation', 'family_update', 'visit_summary_submitted', 'completed'],
    optional_events: ['lab_or_xray', 'pharmacy', 'pickup_condition_checked'],
    required_checklists: ['t24_confirmation', 't2_review'],
    summary_required: true
  },
  home_companion: {
    code: 'home_companion_v2',
    title: 'Home companion workflow',
    required_events: ['arrived_at_location', 'home_check_in', 'midpoint_update', 'home_check_out', 'family_update', 'visit_summary_submitted', 'completed'],
    optional_events: ['pickup_condition_checked'],
    required_checklists: ['pre_visit', 'home_entry'],
    summary_required: true
  },
  medical_coordination: {
    code: 'medical_coordination_v2',
    title: 'Medical coordination workflow',
    required_events: ['coordination_started', 'family_update', 'coordination_completed', 'visit_summary_submitted', 'completed'],
    optional_events: ['patient_checked_in', 'in_consultation', 'lab_or_xray', 'pharmacy'],
    required_checklists: ['pre_visit'],
    summary_required: true
  },
  family_monitoring: {
    code: 'family_monitoring_v2',
    title: 'Family monitoring workflow',
    required_events: ['monitoring_started', 'family_update', 'monitoring_completed', 'visit_summary_submitted', 'completed'],
    optional_events: [],
    required_checklists: ['pre_visit'],
    summary_required: true
  }
};

class BusinessRuleError extends Error {
  constructor(message, code = 'BUSINESS_RULE_FAILED', statusCode = 422, details = {}) {
    super(message);
    this.name = 'BusinessRuleError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function assertKnownServiceType(serviceType) {
  if (!SERVICE_TYPES.has(serviceType)) {
    throw new BusinessRuleError(`Unsupported service_type: ${serviceType}`, 'INVALID_SERVICE_TYPE');
  }
}

function workflowTemplateForService(serviceType) {
  assertKnownServiceType(serviceType);
  return WORKFLOW_TEMPLATES[serviceType] || WORKFLOW_TEMPLATES.elderly_transport;
}

function workflowSnapshotForBooking(booking = {}) {
  const template = workflowTemplateForService(booking.service_type || 'elderly_transport');
  return {
    template_code: template.code,
    title: template.title,
    service_type: booking.service_type || null,
    required_events: [...template.required_events],
    optional_events: [...template.optional_events],
    required_checklists: [...template.required_checklists],
    summary_required: template.summary_required,
    generated_at: new Date().toISOString()
  };
}

function classifyBookingRisk(input = {}, elder = {}) {
  const serviceType = input.service_type;
  const mobilityLevel = input.mobility_level || elder.mobility_level || 'walk_independent';
  const notes = [
    input.special_notes,
    input.appointment_place,
    elder.medical_notes,
    elder.communication_notes
  ].filter(Boolean).join(' ').toLowerCase();

  if (mobilityLevel === 'bed_to_wheelchair') return 'critical';
  if (/หมดสติ|หายใจลำบาก|เจ็บหน้าอก|unconscious|chest pain|breath/.test(notes)) return 'critical';
  if (serviceType === 'hospital_companion') return 'high';
  if (mobilityLevel === 'wheelchair' || input.need_wheelchair_support) return 'high';
  if (/ล้ม|fall|เวียนหัว|dizz|สับสน|confus|กลัวขึ้นรถ|panic/.test(notes)) return 'high';
  if (['monthly_transport', 'assisted_ride', 'elderly_transport', 'home_companion', 'medical_coordination', 'family_monitoring'].includes(serviceType)) return 'medium';
  if (mobilityLevel === 'cane' || mobilityLevel === 'walker') return 'medium';
  return 'low';
}

function requiresSensitiveConsent(serviceType) {
  return ['assisted_ride', 'elderly_transport', 'hospital_companion', 'home_companion', 'medical_coordination', 'family_monitoring'].includes(serviceType);
}

function requiresCareAssistant(serviceType, riskLevel, explicitNeed) {
  return Boolean(explicitNeed) || COMPANION_SERVICE_TYPES.has(serviceType) || ['high', 'critical'].includes(riskLevel);
}

function serviceRequiresVisitSummary(serviceType) {
  return VISIT_SUMMARY_SERVICE_TYPES.has(serviceType);
}

function requiredConsentTypesForService(serviceType) {
  assertKnownServiceType(serviceType);
  if (requiresSensitiveConsent(serviceType)) return [...REQUIRED_EXECUTION_CONSENTS];
  return REQUIRED_EXECUTION_CONSENTS.filter((type) => type !== 'sensitive_health');
}

function missingRequiredConsents(serviceType, consentState = {}) {
  return requiredConsentTypesForService(serviceType).filter((type) => consentState[type] !== true);
}

function isShortNotice(pickupAt, now = new Date(), minimumMinutes = 120) {
  if (!pickupAt) return false;
  const pickupTime = new Date(pickupAt).getTime();
  if (Number.isNaN(pickupTime)) return false;
  return pickupTime - now.getTime() < minimumMinutes * 60 * 1000;
}

function ensureBookingCanBeCreated(input, elder, options = {}) {
  assertKnownServiceType(input.service_type);
  if (!elder) {
    throw new BusinessRuleError('elder_id is required and must reference an existing elder', 'ELDER_REQUIRED');
  }

  if (requiresSensitiveConsent(input.service_type) && !options.hasSensitiveConsent) {
    throw new BusinessRuleError(
      'assisted_ride and hospital_companion bookings require sensitive health consent',
      'SENSITIVE_CONSENT_REQUIRED'
    );
  }

  if (input.service_type === 'hospital_companion' && input.need_care_assistant === false) {
    throw new BusinessRuleError('hospital_companion requires a care assistant', 'CARE_ASSISTANT_REQUIRED');
  }

  const riskLevel = classifyBookingRisk(input, elder);
  const needCareAssistant = requiresCareAssistant(input.service_type, riskLevel, input.need_care_assistant);
  const warnings = [];

  if (['high', 'critical'].includes(riskLevel)) {
    warnings.push('dispatcher approval required before confirmation');
  }
  if (isShortNotice(input.pickup_at, options.now, options.shortNoticeMinutes || 120)) {
    warnings.push('short notice booking');
  }

  return {
    risk_level: riskLevel,
    need_care_assistant: needCareAssistant,
    consent_checked: Boolean(options.hasSensitiveConsent),
    warnings
  };
}

function ensureBookingCanBeConfirmed(booking, options = {}) {
  if (!booking) {
    throw new BusinessRuleError('booking not found', 'BOOKING_NOT_FOUND', 404);
  }
  const riskLevel = booking.risk_level || 'low';
  const dispatcherApproved = Boolean(options.dispatcherApproved || booking.dispatcher_approved_by);

  if (['high', 'critical'].includes(riskLevel) && !dispatcherApproved) {
    throw new BusinessRuleError('high/critical booking requires dispatcher approval', 'DISPATCHER_APPROVAL_REQUIRED');
  }

  if (!options.hasApprovedQuote) {
    throw new BusinessRuleError('confirmed booking requires an approved quote', 'APPROVED_QUOTE_REQUIRED');
  }

  if (booking.service_type === 'hospital_companion' && !booking.need_care_assistant) {
    throw new BusinessRuleError('hospital_companion requires a care assistant', 'CARE_ASSISTANT_REQUIRED');
  }

  if (Array.isArray(options.missingConsents) && options.missingConsents.length) {
    throw new BusinessRuleError(
      'booking confirmation requires all mandatory SOP consents',
      'MANDATORY_CONSENT_REQUIRED',
      422,
      { missingConsents: options.missingConsents }
    );
  }

  return true;
}

function minimumDriverLevelForRisk(riskLevel) {
  if (riskLevel === 'critical') return 'gold';
  if (riskLevel === 'high') return 'silver';
  return 'bronze';
}

function ensureAssignmentAllowed({ booking, driver, vehicle, hasRequiredTraining, careAssistantId }) {
  if (!booking) throw new BusinessRuleError('booking not found', 'BOOKING_NOT_FOUND', 404);
  if (!['confirmed', 'assigned'].includes(booking.status)) {
    throw new BusinessRuleError('booking must be confirmed before assignment', 'BOOKING_NOT_CONFIRMED');
  }
  if (!driver) throw new BusinessRuleError('driver_id is required and must reference an existing driver', 'DRIVER_REQUIRED');
  if (driver.status !== 'active') {
    throw new BusinessRuleError('driver must be active before assignment', 'DRIVER_NOT_ACTIVE');
  }
  if ((driver.driver_level || 'bronze') === 'blacklist') {
    throw new BusinessRuleError('blacklisted driver cannot be assigned', 'DRIVER_BLACKLISTED');
  }
  if (vehicle && vehicle.status !== 'available') {
    throw new BusinessRuleError('vehicle must be available before assignment', 'VEHICLE_NOT_AVAILABLE');
  }

  const riskLevel = booking.risk_level || 'low';
  const requiredLevel = minimumDriverLevelForRisk(riskLevel);
  const actualRank = DRIVER_LEVEL_RANK[driver.driver_level || 'bronze'] || 0;
  const requiredRank = DRIVER_LEVEL_RANK[requiredLevel];
  if (actualRank < requiredRank) {
    throw new BusinessRuleError(
      `${riskLevel} booking requires ${requiredLevel} driver level or higher`,
      'DRIVER_LEVEL_TOO_LOW',
      422,
      { requiredLevel, actualLevel: driver.driver_level || 'bronze' }
    );
  }

  if (['high', 'critical'].includes(riskLevel) && !hasRequiredTraining) {
    throw new BusinessRuleError('high/critical booking requires completed required training', 'TRAINING_REQUIRED');
  }

  if (requiresCareAssistant(booking.service_type, riskLevel, booking.need_care_assistant) && !careAssistantId) {
    throw new BusinessRuleError('this booking requires a care assistant assignment', 'CARE_ASSISTANT_REQUIRED');
  }

  return true;
}

function calculateAssignmentScore({ booking, driver, vehicle, hasRequiredTraining }) {
  const riskLevel = booking?.risk_level || 'low';
  const rank = DRIVER_LEVEL_RANK[driver?.driver_level || 'bronze'] || 0;
  const rating = Number(driver?.rating_avg || 0);
  let score = 45 + rank * 12 + Math.min(20, rating * 4);
  if (hasRequiredTraining) score += 12;
  if (vehicle?.vehicle_type === 'wheelchair_van' && (booking?.need_wheelchair_support || riskLevel === 'critical')) score += 10;
  if (vehicle?.status === 'available') score += 4;
  if (riskLevel === 'critical' && rank >= DRIVER_LEVEL_RANK.gold) score += 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function assignmentReason({ booking, driver, vehicle, hasRequiredTraining }) {
  const parts = [
    `${booking?.risk_level || 'low'} risk`,
    `${driver?.driver_level || 'bronze'} driver`
  ];
  if (hasRequiredTraining) parts.push('required training completed');
  if (vehicle?.vehicle_type) parts.push(`${vehicle.vehicle_type} vehicle`);
  if (Number(driver?.rating_avg || 0) > 0) parts.push(`rating ${driver.rating_avg}`);
  return parts.join(', ');
}

function quoteNumberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function calculateQuote({ booking, priceRule = {}, distanceKm = 0, waitingHours = 0, discount = 0, taxRate = 0.07, afterHours = false, holiday = false, outOfArea = false }) {
  const components = {
    base_service_fee: quoteNumberValue(priceRule.base_fee),
    distance_fee: quoteNumberValue(distanceKm) * quoteNumberValue(priceRule.per_km_fee),
    waiting_fee: quoteNumberValue(waitingHours) * quoteNumberValue(priceRule.waiting_fee_per_hour),
    care_assistant_fee: booking?.need_care_assistant ? quoteNumberValue(priceRule.care_assistant_fee) : 0,
    wheelchair_support_fee: booking?.need_wheelchair_support ? quoteNumberValue(priceRule.wheelchair_fee) : 0,
    hospital_companion_fee: booking?.service_type === 'hospital_companion' ? quoteNumberValue(priceRule.hospital_companion_fee) : 0,
    out_of_area_fee: outOfArea ? quoteNumberValue(priceRule.out_of_area_fee) : 0
  };
  const multiplier = (afterHours ? quoteNumberValue(priceRule.after_hours_multiplier || 1) : 1)
    * (holiday ? quoteNumberValue(priceRule.holiday_multiplier || 1) : 1);
  const subtotalBeforeMultiplier = Object.values(components).reduce((sum, value) => sum + value, 0);
  const subtotal = Math.round(subtotalBeforeMultiplier * multiplier * 100) / 100;
  const discountAmount = quoteNumberValue(discount);
  const taxable = Math.max(0, subtotal - discountAmount);
  const tax = Math.round(taxable * quoteNumberValue(taxRate) * 100) / 100;
  const total = Math.round((taxable + tax) * 100) / 100;

  return {
    subtotal,
    discount: discountAmount,
    tax,
    total,
    pricing_snapshot: {
      service_type: booking?.service_type,
      risk_level: booking?.risk_level,
      distance_km: quoteNumberValue(distanceKm),
      waiting_hours: quoteNumberValue(waitingHours),
      after_hours: Boolean(afterHours),
      holiday: Boolean(holiday),
      out_of_area: Boolean(outOfArea),
      multiplier,
      components,
      price_rule_id: priceRule.id || null
    }
  };
}

function eventTypes(existingEvents = []) {
  return existingEvents.map((event) => typeof event === 'string' ? event : event.event_type);
}

function eventPayloads(existingEvents = []) {
  return existingEvents
    .map((event) => typeof event === 'string' ? {} : (event.event_payload || {}))
    .filter(Boolean);
}

function hasAnyEvent(types, aliases = []) {
  return aliases.some((alias) => types.includes(alias));
}

function hasSevereCondition(payload) {
  return Boolean(
    payload?.severe_symptoms
    || payload?.emergency_condition
    || payload?.block_trip_started
    || payload?.condition_status === 'emergency'
    || payload?.fainted
    || payload?.fall_detected
    || payload?.chest_pain
    || payload?.disoriented
  );
}

function ensureTripEventAllowed({ eventType, existingEvents = [], hasPreTripChecklist = false, booking = {}, eventPayload = {} }) {
  const types = eventTypes(existingEvents);
  const payloads = eventPayloads(existingEvents);
  const severeAlreadyRecorded = payloads.some(hasSevereCondition);
  const serviceType = booking.service_type || 'elderly_transport';
  const transportLike = TRANSPORT_SERVICE_TYPES.has(serviceType);
  const hasArrival = hasAnyEvent(types, ['arrived_pickup', 'arrived_at_location']);
  const hasOnboard = hasAnyEvent(types, ['elder_onboard', 'patient_onboarded']);
  const hasCompletion = hasAnyEvent(types, ['trip_completed', 'completed']);

  if (['arrived_pickup', 'arrived_at_location'].includes(eventType) && transportLike && !hasPreTripChecklist) {
    throw new BusinessRuleError('pre_trip checklist must be completed before arrival', 'PRE_TRIP_CHECKLIST_REQUIRED');
  }

  if (['elder_onboard', 'patient_onboarded'].includes(eventType) && !hasArrival) {
    throw new BusinessRuleError('arrival must happen before patient onboarded', 'EVENT_ORDER_INVALID');
  }
  if (eventType === 'trip_started') {
    if (!hasOnboard) {
      throw new BusinessRuleError('patient onboarding must happen before trip_started', 'EVENT_ORDER_INVALID');
    }
    if (hasSevereCondition(eventPayload) || severeAlreadyRecorded) {
      throw new BusinessRuleError('trip_started is blocked because severe symptoms were recorded', 'TRIP_BLOCKED_BY_CONDITION');
    }
  }
  if (eventType === 'patient_checked_in' && !hasAnyEvent(types, ['arrived_at_location'])) {
    throw new BusinessRuleError('arrived_at_location must happen before patient_checked_in', 'EVENT_ORDER_INVALID');
  }
  if (['in_consultation', 'lab_or_xray', 'pharmacy'].includes(eventType) && !hasAnyEvent(types, ['patient_checked_in'])) {
    throw new BusinessRuleError('patient_checked_in must happen before hospital workflow events', 'EVENT_ORDER_INVALID');
  }
  if (eventType === 'home_check_in' && !hasAnyEvent(types, ['arrived_at_location'])) {
    throw new BusinessRuleError('arrived_at_location must happen before home_check_in', 'EVENT_ORDER_INVALID');
  }
  if (['midpoint_update', 'home_check_out'].includes(eventType) && !hasAnyEvent(types, ['home_check_in'])) {
    throw new BusinessRuleError('home_check_in must happen before home companion updates', 'EVENT_ORDER_INVALID');
  }
  if (eventType === 'coordination_completed' && !hasAnyEvent(types, ['coordination_started'])) {
    throw new BusinessRuleError('coordination_started must happen before coordination_completed', 'EVENT_ORDER_INVALID');
  }
  if (eventType === 'monitoring_completed' && !hasAnyEvent(types, ['monitoring_started'])) {
    throw new BusinessRuleError('monitoring_started must happen before monitoring_completed', 'EVENT_ORDER_INVALID');
  }
  if (eventType === 'handover_completed' && !types.includes('arrived_dropoff')) {
    throw new BusinessRuleError('arrived_dropoff must happen before handover_completed', 'EVENT_ORDER_INVALID');
  }
  if (['trip_completed', 'completed'].includes(eventType)) {
    if (hasCompletion) {
      throw new BusinessRuleError('booking already has a completion event', 'EVENT_DUPLICATE_COMPLETION');
    }
    const template = workflowTemplateForService(serviceType);
    const transportCompletion = transportLike || hasAnyEvent(types, ['arrived_dropoff', 'handover_completed']);
    const hasRequiredHandover = hasAnyEvent(types, ['handover_completed']);
    const hasServiceSummaryEvent = hasAnyEvent(types, ['visit_summary_submitted'])
      || Boolean(eventPayload.summary_id)
      || Boolean(eventPayload.visit_summary_approved);

    if (transportCompletion && !hasRequiredHandover) {
      throw new BusinessRuleError('handover_completed must happen before completion', 'EVENT_ORDER_INVALID');
    }
    if (template.summary_required && !hasServiceSummaryEvent) {
      throw new BusinessRuleError('visit summary must be submitted before completion', 'VISIT_SUMMARY_REQUIRED');
    }
    const hasCareAssistantNote = Boolean(eventPayload.care_assistant_note)
      || payloads.some((payload) => Boolean(payload.care_assistant_note));
    if (booking.service_type === 'hospital_companion' && !hasCareAssistantNote) {
      throw new BusinessRuleError('hospital_companion completion requires care assistant note', 'CARE_ASSISTANT_NOTE_REQUIRED');
    }
  }
  return true;
}

function bookingStatusForTripEvent(eventType) {
  return {
    arrived_at_location: 'arrived',
    arrived_pickup: 'arrived',
    elder_onboard: 'onboard',
    patient_onboarded: 'onboard',
    trip_started: 'in_progress',
    service_started: 'in_progress',
    coordination_started: 'in_progress',
    monitoring_started: 'in_progress',
    trip_completed: 'completed',
    completed: 'completed'
  }[eventType] || null;
}

function ensureIncidentCanClose({ incident, actorRole, actionTaken, resolvedBy }) {
  if (!incident) throw new BusinessRuleError('incident not found', 'INCIDENT_NOT_FOUND', 404);
  if (['high', 'critical'].includes(incident.severity) && actorRole === 'driver') {
    throw new BusinessRuleError('driver cannot close high/critical incidents', 'INCIDENT_CLOSE_FORBIDDEN', 403);
  }
  if (!actionTaken && !incident.action_taken) {
    throw new BusinessRuleError('incident close requires action_taken', 'ACTION_TAKEN_REQUIRED');
  }
  if (!resolvedBy && !incident.resolved_by) {
    throw new BusinessRuleError('incident close requires resolved_by', 'RESOLVED_BY_REQUIRED');
  }
  return true;
}

function driverStatusAfterIncident(severity) {
  if (severity === 'critical') return 'suspended';
  if (severity === 'high') return 'reviewing';
  return null;
}

function ensureCancellationAllowed({ reasonCode, evidence = {}, existingEvents = [] }) {
  if (!reasonCode) {
    throw new BusinessRuleError('cancellation requires reason_code', 'CANCELLATION_REASON_REQUIRED');
  }
  const types = eventTypes(existingEvents);
  const hasEvidence = evidence && Object.keys(evidence).length > 0;
  if (reasonCode === 'no_show' && !types.includes('arrived_pickup') && !hasEvidence) {
    throw new BusinessRuleError('no_show requires arrived_pickup event or evidence', 'NO_SHOW_EVIDENCE_REQUIRED');
  }
  return true;
}

function screeningResult(input = {}) {
  const total = ['document_score', 'interview_score', 'behavior_score', 'driving_test_score']
    .reduce((sum, key) => sum + quoteNumberValue(input[key]), 0);
  if (input.critical_fail) return { total, result: 'rejected' };
  return { total, result: total >= 75 ? 'approved' : 'retest' };
}

function ensureDriverActivationAllowed({ hasApprovedScreening, hasCompletedRequiredTraining, criticalFail }) {
  if (criticalFail) {
    throw new BusinessRuleError('driver with critical_fail cannot be activated', 'DRIVER_CRITICAL_FAIL');
  }
  if (!hasApprovedScreening) {
    throw new BusinessRuleError('driver activation requires approved screening', 'SCREENING_REQUIRED');
  }
  if (!hasCompletedRequiredTraining) {
    throw new BusinessRuleError('driver activation requires completed required training', 'TRAINING_REQUIRED');
  }
  return true;
}

function validateNonDiagnosticText(text, field = 'text') {
  const value = String(text || '').toLowerCase();
  if (!value) return true;
  const diagnosticPattern = /วินิจฉัย|ตีความผล|ปรับยา|เปลี่ยนยา|สั่งยา|diagnos|interpret.*result|change.*medication|prescrib|recommend.*treatment/;
  if (diagnosticPattern.test(value)) {
    throw new BusinessRuleError(
      `${field} must stay factual and non-diagnostic`,
      'MEDICAL_DIAGNOSIS_NOT_ALLOWED',
      422,
      { field }
    );
  }
  return true;
}

function ensureVisitSummaryAllowed(summary = {}) {
  ['visit_outcome', 'family_summary', 'follow_up_requirement'].forEach((field) => {
    validateNonDiagnosticText(summary[field], field);
  });
  if (!summary.visit_outcome) {
    throw new BusinessRuleError('visit summary requires visit_outcome', 'VISIT_OUTCOME_REQUIRED');
  }
  if (!summary.family_summary) {
    throw new BusinessRuleError('visit summary requires family_summary', 'FAMILY_SUMMARY_REQUIRED');
  }
  return true;
}

function ensureBookingClosureAllowed({
  booking,
  events = [],
  latestApprovedSummary = null,
  openIncidents = [],
  familyNotified = false
} = {}) {
  if (!booking) throw new BusinessRuleError('booking not found', 'BOOKING_NOT_FOUND', 404);
  const eventTypeSet = new Set(eventTypes(events));
  const template = workflowTemplateForService(booking.service_type || 'elderly_transport');
  const severeOpenIncidents = openIncidents.filter((incident) => ['high', 'critical'].includes(incident.severity));

  if (severeOpenIncidents.length) {
    throw new BusinessRuleError(
      'booking closure is blocked by unresolved high severity incident',
      'OPEN_HIGH_INCIDENT_BLOCKS_CLOSURE',
      422,
      { incidentIds: severeOpenIncidents.map((incident) => incident.id).filter(Boolean) }
    );
  }

  const ignoredForCompletion = new Set(['completed', 'trip_completed']);
  const missingEvents = template.required_events
    .filter((eventType) => !ignoredForCompletion.has(eventType))
    .filter((eventType) => !eventTypeSet.has(eventType));
  if (missingEvents.length) {
    throw new BusinessRuleError(
      'booking closure requires mandatory workflow events',
      'WORKFLOW_EVENTS_INCOMPLETE',
      422,
      { missingEvents }
    );
  }

  if (template.summary_required && !latestApprovedSummary) {
    throw new BusinessRuleError('booking closure requires an approved visit summary', 'APPROVED_VISIT_SUMMARY_REQUIRED');
  }

  if (!familyNotified) {
    throw new BusinessRuleError('booking closure requires documented family notification', 'FAMILY_NOTIFICATION_REQUIRED');
  }

  return true;
}

function maskElderForRole(elder, role, hasSensitiveConsent) {
  if (!elder) return elder;
  const masked = { ...elder };
  const mustMask = !hasSensitiveConsent || ['driver', 'finance'].includes(role);
  if (mustMask) {
    masked.medical_notes = null;
    masked.allergies = null;
    masked.medication_notes = null;
  }
  return masked;
}

module.exports = {
  BusinessRuleError,
  SERVICE_TYPE_VALUES,
  SERVICE_TYPES,
  RISK_LEVELS,
  WORKFLOW_TEMPLATES,
  workflowTemplateForService,
  workflowSnapshotForBooking,
  classifyBookingRisk,
  requiresSensitiveConsent,
  requiresCareAssistant,
  serviceRequiresVisitSummary,
  requiredConsentTypesForService,
  missingRequiredConsents,
  isShortNotice,
  ensureBookingCanBeCreated,
  ensureBookingCanBeConfirmed,
  ensureAssignmentAllowed,
  calculateAssignmentScore,
  assignmentReason,
  calculateQuote,
  ensureTripEventAllowed,
  bookingStatusForTripEvent,
  ensureIncidentCanClose,
  driverStatusAfterIncident,
  ensureCancellationAllowed,
  screeningResult,
  ensureDriverActivationAllowed,
  validateNonDiagnosticText,
  ensureVisitSummaryAllowed,
  ensureBookingClosureAllowed,
  maskElderForRole
};
