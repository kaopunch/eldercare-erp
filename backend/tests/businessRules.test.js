const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyBookingRisk,
  ensureBookingCanBeCreated,
  ensureBookingCanBeConfirmed,
  ensureAssignmentAllowed,
  ensureTripEventAllowed,
  ensureIncidentCanClose,
  ensureCancellationAllowed,
  screeningResult,
  ensureDriverActivationAllowed,
  calculateQuote,
  workflowTemplateForService,
  requiredConsentTypesForService,
  missingRequiredConsents,
  ensureVisitSummaryAllowed,
  ensureBookingClosureAllowed
} = require('../src/lib/businessRules');

const elder = {
  id: 'elder-1',
  mobility_level: 'wheelchair',
  medical_notes: 'เคยล้มและเวียนหัวง่าย'
};

test('classifies high and critical booking risk from SOP conditions', () => {
  assert.equal(classifyBookingRisk({ service_type: 'basic_ride' }, { mobility_level: 'walk_independent' }), 'low');
  assert.equal(classifyBookingRisk({ service_type: 'assisted_ride' }, { mobility_level: 'walker' }), 'medium');
  assert.equal(classifyBookingRisk({ service_type: 'hospital_companion' }, { mobility_level: 'cane' }), 'high');
  assert.equal(classifyBookingRisk({ service_type: 'home_companion' }, { mobility_level: 'walk_independent' }), 'medium');
  assert.equal(classifyBookingRisk({ service_type: 'basic_ride' }, { mobility_level: 'bed_to_wheelchair' }), 'critical');
});

test('blocks assisted/hospital booking without sensitive consent', () => {
  assert.throws(() => ensureBookingCanBeCreated({
    service_type: 'assisted_ride',
    pickup_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
  }, elder, { hasSensitiveConsent: false }), /sensitive health consent/);
});

test('hospital companion requires care assistant and high risk confirmation requires approval plus quote', () => {
  assert.throws(() => ensureBookingCanBeCreated({
    service_type: 'hospital_companion',
    pickup_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    need_care_assistant: false
  }, elder, { hasSensitiveConsent: true }), /care assistant/);

  const booking = {
    service_type: 'hospital_companion',
    risk_level: 'high',
    need_care_assistant: true
  };
  assert.throws(() => ensureBookingCanBeConfirmed(booking, { hasApprovedQuote: true }), /dispatcher approval/);
  assert.throws(() => ensureBookingCanBeConfirmed(booking, { dispatcherApproved: true, hasApprovedQuote: false }), /approved quote/);
  assert.throws(() => ensureBookingCanBeConfirmed(booking, {
    dispatcherApproved: true,
    hasApprovedQuote: true,
    missingConsents: ['family_notification', 'photo']
  }), /mandatory SOP consents/);
  assert.equal(ensureBookingCanBeConfirmed(booking, { dispatcherApproved: true, hasApprovedQuote: true }), true);
});

test('assignment blocks inactive drivers, maintenance vehicles, low driver level, and missing training', () => {
  const booking = { service_type: 'hospital_companion', risk_level: 'high', need_care_assistant: true, status: 'confirmed' };
  const silverDriver = { status: 'active', driver_level: 'silver', rating_avg: 4.8 };
  const bronzeDriver = { status: 'active', driver_level: 'bronze', rating_avg: 4.8 };

  assert.throws(() => ensureAssignmentAllowed({
    booking: { ...booking, status: 'draft' },
    driver: silverDriver,
    vehicle: { status: 'available' },
    hasRequiredTraining: true,
    careAssistantId: 'ca-1'
  }), /confirmed/);

  assert.throws(() => ensureAssignmentAllowed({
    booking,
    driver: { ...silverDriver, status: 'suspended' },
    vehicle: { status: 'available' },
    hasRequiredTraining: true,
    careAssistantId: 'ca-1'
  }), /active/);

  assert.throws(() => ensureAssignmentAllowed({
    booking,
    driver: silverDriver,
    vehicle: { status: 'maintenance' },
    hasRequiredTraining: true,
    careAssistantId: 'ca-1'
  }), /available/);

  assert.throws(() => ensureAssignmentAllowed({
    booking,
    driver: bronzeDriver,
    vehicle: { status: 'available' },
    hasRequiredTraining: true,
    careAssistantId: 'ca-1'
  }), /silver/);

  assert.throws(() => ensureAssignmentAllowed({
    booking,
    driver: silverDriver,
    vehicle: { status: 'available' },
    hasRequiredTraining: false,
    careAssistantId: 'ca-1'
  }), /training/);

  assert.equal(ensureAssignmentAllowed({
    booking,
    driver: silverDriver,
    vehicle: { status: 'available' },
    hasRequiredTraining: true,
    careAssistantId: 'ca-1'
  }), true);
});

test('trip event ordering enforces checklist, pickup, onboard, handover, and condition blocks', () => {
  assert.throws(() => ensureTripEventAllowed({
    eventType: 'arrived_pickup',
    existingEvents: [],
    hasPreTripChecklist: false
  }), /pre_trip/);

  assert.throws(() => ensureTripEventAllowed({
    eventType: 'elder_onboard',
    existingEvents: [],
    hasPreTripChecklist: true
  }), /arrival/);

  assert.throws(() => ensureTripEventAllowed({
    eventType: 'trip_started',
    existingEvents: ['arrived_pickup', 'pickup_condition_checked', 'elder_onboard'],
    hasPreTripChecklist: true,
    eventPayload: { severe_symptoms: true }
  }), /blocked/);

  assert.throws(() => ensureTripEventAllowed({
    eventType: 'trip_completed',
    existingEvents: ['arrived_pickup', 'elder_onboard', 'trip_started'],
    hasPreTripChecklist: true
  }), /handover_completed/);

  assert.throws(() => ensureTripEventAllowed({
    eventType: 'trip_completed',
    existingEvents: ['arrived_pickup', 'elder_onboard', 'trip_started', 'arrived_dropoff', 'handover_completed'],
    hasPreTripChecklist: true,
    booking: { service_type: 'hospital_companion' },
    eventPayload: { visit_summary_approved: true }
  }), /care assistant note/);
});

test('SOP v2 workflow templates and closure rules enforce summary, family update, and incident blocks', () => {
  const hospitalWorkflow = workflowTemplateForService('hospital_companion');
  assert.equal(hospitalWorkflow.summary_required, true);
  assert.deepEqual(requiredConsentTypesForService('home_companion'), [
    'general_service',
    'sensitive_health',
    'family_notification',
    'photo'
  ]);
  assert.deepEqual(missingRequiredConsents('hospital_companion', {
    general_service: true,
    sensitive_health: true
  }), ['family_notification', 'photo']);

  assert.throws(() => ensureVisitSummaryAllowed({
    visit_outcome: 'Completed',
    family_summary: 'We diagnose pneumonia'
  }), /non-diagnostic/);

  const booking = { service_type: 'hospital_companion' };
  const events = [
    'arrived_at_location',
    'patient_checked_in',
    'in_consultation',
    'family_update',
    'visit_summary_submitted'
  ];
  assert.throws(() => ensureBookingClosureAllowed({
    booking,
    events,
    latestApprovedSummary: { id: 'summary-1' },
    familyNotified: true,
    openIncidents: [{ id: 'incident-1', severity: 'high' }]
  }), /unresolved high severity incident/);
  assert.equal(ensureBookingClosureAllowed({
    booking,
    events,
    latestApprovedSummary: { id: 'summary-1' },
    familyNotified: true,
    openIncidents: []
  }), true);
});

test('incident close and no-show rules protect audit trail', () => {
  assert.throws(() => ensureIncidentCanClose({
    incident: { severity: 'high', action_taken: 'called family' },
    actorRole: 'driver',
    resolvedBy: 'admin-1'
  }), /driver cannot close/);

  assert.throws(() => ensureCancellationAllowed({
    reasonCode: 'no_show',
    evidence: {},
    existingEvents: []
  }), /no_show/);

  assert.equal(ensureCancellationAllowed({
    reasonCode: 'no_show',
    evidence: { call_attempts: 3 },
    existingEvents: []
  }), true);
});

test('screening and activation enforce critical fail, approval, and required training', () => {
  assert.deepEqual(screeningResult({
    document_score: 20,
    interview_score: 25,
    behavior_score: 25,
    driving_test_score: 30
  }), { total: 100, result: 'approved' });

  assert.deepEqual(screeningResult({
    document_score: 20,
    interview_score: 25,
    behavior_score: 25,
    driving_test_score: 30,
    critical_fail: true
  }), { total: 100, result: 'rejected' });

  assert.throws(() => ensureDriverActivationAllowed({
    hasApprovedScreening: true,
    hasCompletedRequiredTraining: false,
    criticalFail: false
  }), /training/);
});

test('quote calculation keeps a pricing snapshot', () => {
  const quote = calculateQuote({
    booking: {
      service_type: 'hospital_companion',
      risk_level: 'high',
      need_care_assistant: true,
      need_wheelchair_support: true
    },
    priceRule: {
      id: 'rule-1',
      base_fee: 1000,
      per_km_fee: 30,
      waiting_fee_per_hour: 200,
      care_assistant_fee: 500,
      wheelchair_fee: 300,
      hospital_companion_fee: 700,
      after_hours_multiplier: 1.2,
      holiday_multiplier: 1.4
    },
    distanceKm: 10,
    waitingHours: 2,
    afterHours: true,
    discount: 100
  });

  assert.equal(quote.pricing_snapshot.components.base_service_fee, 1000);
  assert.equal(quote.pricing_snapshot.components.distance_fee, 300);
  assert.equal(quote.pricing_snapshot.price_rule_id, 'rule-1');
  assert.equal(quote.total > 0, true);
});
