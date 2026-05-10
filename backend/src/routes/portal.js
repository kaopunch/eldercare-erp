const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { getSupabase } = require('../db/supabase');
const {
  BusinessRuleError,
  SERVICE_TYPE_VALUES,
  calculateQuote,
  ensureBookingCanBeCreated,
  workflowSnapshotForBooking
} = require('../lib/businessRules');
const { queueCustomerNotification, queueNotification } = require('../lib/notifications');

const router = express.Router();

const PortalBookingSchema = z.object({
  customer_id: z.string().uuid(),
  elder_id: z.string().uuid(),
  service_type: z.enum(SERVICE_TYPE_VALUES),
  pickup_address: z.string().min(2),
  dropoff_address: z.string().min(2),
  pickup_at: z.string().datetime({ offset: true }),
  estimated_return_at: z.string().datetime({ offset: true }).optional().nullable(),
  appointment_at: z.string().datetime({ offset: true }).optional().nullable(),
  appointment_place: z.string().optional().nullable(),
  special_notes: z.string().optional().nullable(),
  need_care_assistant: z.boolean().optional(),
  need_wheelchair_support: z.boolean().optional(),
  accept_non_emergency: z.boolean(),
  consent_ack: z.boolean().optional()
});

const PortalConsentSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  signer_name: z.string().optional().nullable(),
  general_service: z.boolean().optional(),
  sensitive_health: z.boolean().optional(),
  family_notification: z.boolean().optional(),
  photo: z.boolean().optional(),
  location_tracking: z.boolean().optional(),
  marketing: z.boolean().optional(),
  consent_text_version: z.string().optional().nullable()
});

function firstRelation(value) {
  return Array.isArray(value) ? value[0] : value;
}

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function bookingNo() {
  return `BK${Date.now()}`;
}

function quoteNo() {
  return `QT${Date.now()}`;
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function portalTokenSecret() {
  return process.env.PORTAL_TOKEN_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_ANON_KEY
    || 'eldercare-local-portal-secret';
}

function signPortalToken(scope, value) {
  const body = toBase64Url(JSON.stringify({ scope, value, version: 1 }));
  const signature = crypto
    .createHmac('sha256', portalTokenSecret())
    .update(body)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${body}.${signature}`;
}

function verifyPortalToken(token, expectedScope) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) {
    const error = new Error('portal token is invalid');
    error.statusCode = 401;
    error.code = 'PORTAL_TOKEN_INVALID';
    throw error;
  }
  const expected = crypto
    .createHmac('sha256', portalTokenSecret())
    .update(body)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    const error = new Error('portal token signature is invalid');
    error.statusCode = 401;
    error.code = 'PORTAL_TOKEN_INVALID';
    throw error;
  }
  const payload = JSON.parse(fromBase64Url(body));
  const allowedScopes = Array.isArray(expectedScope) ? expectedScope : [expectedScope];
  if (!allowedScopes.includes(payload.scope) || !payload.value) {
    const error = new Error('portal token scope is invalid');
    error.statusCode = 401;
    error.code = 'PORTAL_TOKEN_SCOPE_INVALID';
    throw error;
  }
  return payload;
}

function absoluteUrl(req, path) {
  return `${req.protocol}://${req.get('host')}${path}`;
}

function bookingPortalLinks(req, bookingNo, elderId) {
  const statusToken = signPortalToken('booking_status', bookingNo);
  const ratingToken = signPortalToken('booking_rating', bookingNo);
  const consentToken = elderId ? signPortalToken('elder_consent', elderId) : null;
  const links = {
    status: `/portal/t/status/${statusToken}`,
    rating: `/portal/t/rating/${ratingToken}`,
    consent: consentToken ? `/portal/t/consent/${consentToken}` : null,
    raw_status: `/portal/status/${bookingNo}`,
    raw_rating: `/portal/rating/${bookingNo}`,
    raw_consent: elderId ? `/portal/consent/${elderId}` : null
  };
  return {
    ...links,
    absolute: Object.fromEntries(
      Object.entries(links)
        .filter(([, value]) => value)
        .map(([key, value]) => [key, absoluteUrl(req, value)])
    )
  };
}

async function consentProfilePayload(sb, elderId) {
  const { data: elder, error: elderError } = await sb.from('elders')
    .select('id,company_id,customer_id,full_name,mobility_level,pdpa_sensitive_consent,emergency_contact_name,emergency_contact_phone,customers(id,full_name,phone,line_id)')
    .eq('id', elderId)
    .single();
  if (elderError) throw elderError;
  const { data: history, error: historyError } = await sb.from('pdpa_consents')
    .select('*')
    .eq('elder_id', elderId)
    .order('consented_at', { ascending: false });
  if (historyError) throw historyError;

  const latest = {};
  for (const consent of history || []) {
    if (!latest[consent.consent_type]) latest[consent.consent_type] = consent;
  }

  return {
    elder,
    latest,
    history: history || []
  };
}

async function savePortalConsent(sb, elderId, input, req) {
  if (input.general_service !== true) {
    throw new BusinessRuleError('general service consent is required', 'GENERAL_CONSENT_REQUIRED');
  }

  const { data: elder, error: elderError } = await sb.from('elders')
    .select('id,company_id,customer_id,full_name')
    .eq('id', elderId)
    .single();
  if (elderError) throw elderError;
  if (input.customer_id && elder.customer_id && input.customer_id !== elder.customer_id) {
    throw new BusinessRuleError('elder does not belong to selected customer', 'PORTAL_CUSTOMER_ELDER_MISMATCH');
  }

  const consentTypes = ['general_service', 'sensitive_health', 'family_notification', 'photo', 'location_tracking', 'marketing'];
  const payload = consentTypes
    .filter((type) => Object.prototype.hasOwnProperty.call(input, type))
    .map((type) => ({
      customer_id: input.customer_id || elder.customer_id || null,
      elder_id: elder.id,
      consent_type: type,
      consented: Boolean(input[type]),
      consent_text_version: input.consent_text_version || 'portal-v1',
      ip_address: req.ip || null,
      user_agent: req.get('user-agent') || null
    }));

  const { data, error } = await sb.from('pdpa_consents').insert(payload).select('*');
  if (error) throw error;
  const sensitive = payload.find((row) => row.consent_type === 'sensitive_health');
  if (sensitive) await sb.from('elders').update({ pdpa_sensitive_consent: sensitive.consented }).eq('id', elder.id);

  await sb.from('audit_logs').insert({
    company_id: elder.company_id || null,
    action: 'portal_consent_submitted',
    entity_type: 'elder',
    entity_id: elder.id,
    payload: {
      elder_name: elder.full_name,
      signer_name: input.signer_name || null,
      consent_text_version: input.consent_text_version || 'portal-v1',
      consents: payload.map((row) => ({ type: row.consent_type, consented: row.consented })),
      source: 'customer_portal'
    }
  });

  const consentProfile = await consentProfilePayload(sb, elder.id);
  return { consents: data || [], consent_profile: consentProfile };
}

async function latestSensitiveConsent(sb, elderId) {
  const { data, error } = await sb.from('pdpa_consents')
    .select('consented,consented_at')
    .eq('elder_id', elderId)
    .eq('consent_type', 'sensitive_health')
    .order('consented_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.consented === true;
}

async function activePriceRule(sb, booking) {
  const { data, error } = await sb.from('service_price_rules')
    .select('*')
    .eq('service_type', booking.service_type)
    .eq('active', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).find((rule) => rule.branch_id === booking.branch_id)
    || (data || []).find((rule) => rule.company_id === booking.company_id)
    || (data || [])[0]
    || null;
}

async function createPortalQuoteIfPossible(sb, booking) {
  const priceRule = await activePriceRule(sb, booking);
  if (!priceRule) return null;
  const quote = calculateQuote({
    booking,
    priceRule,
    distanceKm: 0,
    waitingHours: 0,
    discount: 0,
    taxRate: 0
  });
  const { data, error } = await sb.from('booking_quotes').insert({
    booking_id: booking.id,
    quote_no: quoteNo(),
    subtotal: quote.subtotal,
    discount: quote.discount,
    tax: quote.tax,
    total: quote.total,
    quote_status: 'draft',
    pricing_snapshot: {
      ...quote.pricing_snapshot,
      source: 'customer_portal_request',
      note: 'Draft quote uses base pricing. Dispatcher should review distance/waiting before confirmation.'
    }
  }).select('*').single();
  if (error) throw error;
  await sb.from('bookings').update({ quoted_price: data.total }).eq('id', booking.id);
  return data;
}

async function createBookingWorkflow(sb, booking) {
  const snapshot = workflowSnapshotForBooking(booking);
  await sb.from('booking_workflows').insert({
    booking_id: booking.id,
    service_type: booking.service_type,
    template_code: snapshot.template_code,
    required_events: snapshot.required_events,
    optional_events: snapshot.optional_events,
    required_checklists: snapshot.required_checklists,
    summary_required: snapshot.summary_required
  });
  await sb.from('bookings').update({
    workflow_template_code: snapshot.template_code,
    workflow_snapshot: snapshot
  }).eq('id', booking.id);
  return snapshot;
}

function statusStepDone(booking, eventTypes, eventType) {
  const impliedByStatus = {
    driver_accepted: ['driver_accepted', 'arrived', 'onboard', 'in_progress', 'completed'],
    arrived_pickup: ['arrived', 'onboard', 'in_progress', 'completed'],
    elder_onboard: ['onboard', 'in_progress', 'completed'],
    trip_started: ['in_progress', 'completed'],
    arrived_dropoff: ['completed'],
    handover_completed: ['completed'],
    trip_completed: ['completed']
  };
  return eventTypes.has(eventType) || (impliedByStatus[eventType] || []).includes(booking.status);
}

function timelineForBooking(booking, events = []) {
  const eventTypes = new Set(events.map((event) => event.event_type));
  const eventByType = events.reduce((map, event) => {
    if (!map[event.event_type]) map[event.event_type] = event;
    return map;
  }, {});
  return [
    ['confirmed', 'Booking confirmed'],
    ['driver_accepted', 'Driver accepted'],
    ['arrived_pickup', 'Arrived pickup'],
    ['elder_onboard', 'Elder onboard'],
    ['trip_started', 'Trip started'],
    ['arrived_dropoff', 'Arrived dropoff'],
    ['handover_completed', 'Handover completed'],
    ['trip_completed', 'Trip completed']
  ].map(([key, label]) => ({
    key,
    label,
    done: key === 'confirmed'
      ? ['confirmed', 'assigned', 'driver_accepted', 'arrived', 'onboard', 'in_progress', 'completed'].includes(booking.status)
      : statusStepDone(booking, eventTypes, key),
    event_at: eventByType[key]?.event_at || null,
    notes: eventByType[key]?.notes || null
  }));
}

async function getPortalBooking(sb, bookingNo) {
  const { data, error } = await sb.from('bookings')
    .select('id,company_id,branch_id,booking_no,customer_id,elder_id,service_type,pickup_address,dropoff_address,pickup_at,estimated_return_at,appointment_at,appointment_place,status,risk_level,quoted_price,final_price,payment_status,customers(id,full_name,phone,line_id),elders(id,full_name,mobility_level,emergency_contact_name,emergency_contact_phone)')
    .eq('booking_no', bookingNo)
    .single();
  if (error) throw error;
  return data;
}

async function portalPayload(sb, bookingNo) {
  const booking = await getPortalBooking(sb, bookingNo);
  const [assignments, events, invoices, payments, refunds, ratings] = await Promise.all([
    sb.from('assignments').select('id,status,driver_id,care_assistant_id,vehicle_id,drivers(full_name,phone,driver_level),care_assistant:app_users!assignments_care_assistant_id_fkey(full_name,phone),vehicles(plate_number,vehicle_type)').eq('booking_id', booking.id).order('assigned_at', { ascending: false }),
    sb.from('trip_events').select('event_type,event_at,notes,event_payload').eq('booking_id', booking.id).order('event_at', { ascending: true }),
    sb.from('invoices').select('invoice_no,total,status,issued_at').eq('booking_id', booking.id).order('issued_at', { ascending: false }),
    sb.from('payments').select('amount,payment_method,payment_status,paid_at,transaction_ref').eq('booking_id', booking.id).order('paid_at', { ascending: false }),
    sb.from('refunds').select('amount,status,created_at').eq('booking_id', booking.id).order('created_at', { ascending: false }),
    sb.from('ratings').select('rating,comment,created_at').eq('booking_id', booking.id).order('created_at', { ascending: false })
  ]);
  if (assignments.error) throw assignments.error;
  if (events.error) throw events.error;
  if (invoices.error) throw invoices.error;
  if (payments.error) throw payments.error;
  if (refunds.error) throw refunds.error;
  if (ratings.error) throw ratings.error;

  const assignment = (assignments.data || [])[0] || {};
  const driver = firstRelation(assignment.drivers) || {};
  const careAssistant = firstRelation(assignment.care_assistant) || {};
  const vehicle = firstRelation(assignment.vehicles) || {};
  const total = numeric(booking.final_price || booking.quoted_price);
  const paid = (payments.data || [])
    .filter((payment) => !['refunded', 'partial_refunded'].includes(payment.payment_status))
    .reduce((sum, payment) => sum + numeric(payment.amount), 0);
  const refunded = (refunds.data || [])
    .filter((refund) => ['approved', 'paid'].includes(refund.status))
    .reduce((sum, refund) => sum + numeric(refund.amount), 0);

  await sb.from('audit_logs').insert({
    company_id: booking.company_id || null,
    action: 'portal_status_viewed',
    entity_type: 'booking',
    entity_id: booking.id,
    payload: {
      booking_no: booking.booking_no,
      source: 'customer_portal'
    }
  });

  return {
    booking: {
      id: booking.id,
      booking_no: booking.booking_no,
      service_type: booking.service_type,
      pickup_address: booking.pickup_address,
      dropoff_address: booking.dropoff_address,
      pickup_at: booking.pickup_at,
      estimated_return_at: booking.estimated_return_at,
      appointment_at: booking.appointment_at,
      appointment_place: booking.appointment_place,
      status: booking.status,
      risk_level: booking.risk_level,
      elder: firstRelation(booking.elders) || {},
      customer: firstRelation(booking.customers) || {}
    },
    field_team: {
      assignment_id: assignment.id || null,
      assignment_status: assignment.status || null,
      driver: {
        full_name: driver.full_name || null,
        phone: driver.phone || null,
        driver_level: driver.driver_level || null
      },
      care_assistant: {
        full_name: careAssistant.full_name || null,
        phone: careAssistant.phone || null
      },
      vehicle: {
        plate_number: vehicle.plate_number || null,
        vehicle_type: vehicle.vehicle_type || null
      }
    },
    timeline: timelineForBooking(booking, events.data || []),
    finance: {
      total,
      paid,
      refunded,
      balance: Math.max(0, Math.round((total - Math.max(0, paid - refunded)) * 100) / 100),
      latest_invoice: (invoices.data || [])[0] || null,
      payments: payments.data || []
    },
    rating: {
      can_rate: booking.status === 'completed',
      latest: (ratings.data || [])[0] || null
    }
  };
}

async function updateDriverRating(sb, driverId) {
  const { data, error } = await sb.from('ratings').select('rating').eq('driver_id', driverId);
  if (error) throw error;
  const ratings = (data || []).map((row) => Number(row.rating)).filter(Number.isFinite);
  const avg = ratings.length
    ? Math.round((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 100) / 100
    : 0;
  await sb.from('drivers').update({ rating_avg: avg }).eq('id', driverId);
  return avg;
}

async function savePortalRating(sb, bookingNo, body) {
  const ratingValue = Number(body.rating);
  if (!Number.isInteger(ratingValue) || ratingValue < 1 || ratingValue > 5) {
    const error = new Error('rating must be an integer between 1 and 5');
    error.statusCode = 422;
    error.code = 'RATING_INVALID';
    throw error;
  }

  const booking = await getPortalBooking(sb, bookingNo);
  if (booking.status !== 'completed') {
    const error = new Error('booking must be completed before rating');
    error.statusCode = 422;
    error.code = 'BOOKING_NOT_COMPLETED';
    throw error;
  }
  const { data: assignment, error: assignmentError } = await sb.from('assignments')
    .select('id,driver_id')
    .eq('booking_id', booking.id)
    .order('assigned_at', { ascending: false })
    .limit(1)
    .single();
  if (assignmentError) throw assignmentError;

  const { data: existing, error: existingError } = await sb.from('ratings')
    .select('id')
    .eq('booking_id', booking.id)
    .eq('driver_id', assignment.driver_id)
    .limit(1);
  if (existingError) throw existingError;

  const write = existing?.[0]
    ? sb.from('ratings').update({
      rating: ratingValue,
      comment: body.comment || null
    }).eq('id', existing[0].id).select('*').single()
    : sb.from('ratings').insert({
      booking_id: booking.id,
      driver_id: assignment.driver_id,
      customer_id: booking.customer_id,
      rating: ratingValue,
      comment: body.comment || null
    }).select('*').single();

  const { data: rating, error } = await write;
  if (error) throw error;
  const avg = await updateDriverRating(sb, assignment.driver_id);

  if (ratingValue <= 2) {
    await sb.from('driver_quality_reviews').insert({
      driver_id: assignment.driver_id,
      review_period_start: new Date().toISOString().slice(0, 10),
      review_period_end: new Date().toISOString().slice(0, 10),
      avg_rating: avg,
      review_result: 'low_rating_review',
      reviewed_by: null
    });
    await sb.from('drivers').update({ status: 'reviewing' }).eq('id', assignment.driver_id);
    await queueNotification(sb, {
      booking,
      type: 'quality_review_created',
      payload: {
        booking_no: booking.booking_no,
        driver_id: assignment.driver_id,
        rating: ratingValue,
        review_result: 'low_rating_review',
        source: 'customer_portal'
      }
    });
  }

  await sb.from('audit_logs').insert({
    company_id: booking.company_id || null,
    action: 'portal_rating_submitted',
    entity_type: 'booking',
    entity_id: booking.id,
    payload: {
      booking_no: booking.booking_no,
      rating: ratingValue,
      source: 'customer_portal'
    }
  });

  return { rating, driver_rating_avg: avg };
}

router.get('/options', async (_, res, next) => {
  try {
    const sb = getSupabase();
    const [customers, elders] = await Promise.all([
      sb.from('customers').select('id,company_id,full_name,phone,line_id').order('created_at', { ascending: false }).limit(100),
      sb.from('elders').select('id,company_id,customer_id,full_name,mobility_level,pdpa_sensitive_consent,emergency_contact_name,emergency_contact_phone,customers(full_name,phone)').order('created_at', { ascending: false }).limit(100)
    ]);
    if (customers.error) throw customers.error;
    if (elders.error) throw elders.error;
    res.json({
      ok: true,
      options: {
        customers: customers.data || [],
        elders: elders.data || [],
        service_types: SERVICE_TYPE_VALUES
      }
    });
  } catch (e) { next(e); }
});

router.post('/book', async (req, res, next) => {
  try {
    const input = PortalBookingSchema.parse(req.body);
    if (!input.accept_non_emergency) {
      throw new BusinessRuleError('customer must accept non-emergency service scope before booking', 'NON_EMERGENCY_ACK_REQUIRED');
    }

    const sb = getSupabase();
    const { data: elder, error: elderError } = await sb.from('elders').select('*').eq('id', input.elder_id).single();
    if (elderError) throw elderError;
    const { data: customer, error: customerError } = await sb.from('customers').select('*').eq('id', input.customer_id).single();
    if (customerError) throw customerError;
    if (elder.customer_id && elder.customer_id !== customer.id) {
      throw new BusinessRuleError('elder does not belong to selected customer', 'PORTAL_CUSTOMER_ELDER_MISMATCH');
    }

    const hasSensitiveConsent = await latestSensitiveConsent(sb, input.elder_id);
    const rules = ensureBookingCanBeCreated(input, elder, { hasSensitiveConsent });
    const status = ['high', 'critical'].includes(rules.risk_level) ? 'pending_dispatch_approval' : 'draft';
    const insertPayload = {
      company_id: elder.company_id || customer.company_id || null,
      branch_id: customer.branch_id || null,
      customer_id: input.customer_id,
      elder_id: input.elder_id,
      booking_no: bookingNo(),
      service_type: input.service_type,
      pickup_address: input.pickup_address,
      dropoff_address: input.dropoff_address,
      pickup_at: input.pickup_at,
      estimated_return_at: input.estimated_return_at || null,
      appointment_at: input.appointment_at || null,
      appointment_place: input.appointment_place || null,
      special_notes: input.special_notes || null,
      need_care_assistant: rules.need_care_assistant,
      need_wheelchair_support: Boolean(input.need_wheelchair_support),
      booking_source: 'customer_portal',
      consent_checked: rules.consent_checked,
      risk_level: rules.risk_level,
      status
    };

    const { data: booking, error } = await sb.from('bookings').insert(insertPayload).select('*').single();
    if (error) throw error;

    if (input.estimated_return_at) {
      await sb.from('booking_segments').insert([
        {
          booking_id: booking.id,
          segment_type: 'outbound',
          pickup_address: input.pickup_address,
          dropoff_address: input.dropoff_address,
          scheduled_at: input.pickup_at,
          status: 'scheduled',
          sequence_no: 1
        },
        {
          booking_id: booking.id,
          segment_type: 'return',
          pickup_address: input.dropoff_address,
          dropoff_address: input.pickup_address,
          scheduled_at: input.estimated_return_at,
          status: 'scheduled',
          sequence_no: 2
        }
      ]);
    }

    const workflow = await createBookingWorkflow(sb, booking);
    const quote = await createPortalQuoteIfPossible(sb, booking);
    await sb.from('audit_logs').insert({
      company_id: booking.company_id || null,
      action: 'portal_booking_requested',
      entity_type: 'booking',
      entity_id: booking.id,
      payload: {
        booking_no: booking.booking_no,
        service_type: booking.service_type,
        risk_level: booking.risk_level,
        source: 'customer_portal'
      }
    });
    await queueCustomerNotification(sb, booking, 'portal_booking_requested', {
      status: booking.status,
      risk_level: booking.risk_level
    });

    res.status(201).json({
      ok: true,
      booking,
      workflow,
      quote,
      warnings: rules.warnings,
      links: bookingPortalLinks(req, booking.booking_no, booking.elder_id)
    });
  } catch (e) { next(e); }
});

router.get('/consent/:elder_id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const consentProfile = await consentProfilePayload(sb, req.params.elder_id);
    res.json({
      ok: true,
      consent_profile: consentProfile
    });
  } catch (e) { next(e); }
});

router.post('/consent/:elder_id', async (req, res, next) => {
  try {
    const input = PortalConsentSchema.parse(req.body);
    const sb = getSupabase();
    const result = await savePortalConsent(sb, req.params.elder_id, input, req);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/token/booking/:booking_no', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const booking = await getPortalBooking(sb, req.params.booking_no);
    res.json({
      ok: true,
      booking_no: booking.booking_no,
      links: bookingPortalLinks(req, booking.booking_no, booking.elder_id)
    });
  } catch (e) { next(e); }
});

router.get('/token/elder/:elder_id', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const consentProfile = await consentProfilePayload(sb, req.params.elder_id);
    const token = signPortalToken('elder_consent', req.params.elder_id);
    const path = `/portal/t/consent/${token}`;
    res.json({
      ok: true,
      elder_id: req.params.elder_id,
      elder_name: consentProfile.elder.full_name,
      links: {
        consent: path,
        raw_consent: `/portal/consent/${req.params.elder_id}`,
        absolute: {
          consent: absoluteUrl(req, path),
          raw_consent: absoluteUrl(req, `/portal/consent/${req.params.elder_id}`)
        }
      }
    });
  } catch (e) { next(e); }
});

router.get('/status-token/:token', async (req, res, next) => {
  try {
    const token = verifyPortalToken(req.params.token, ['booking_status', 'booking_rating']);
    const sb = getSupabase();
    const payload = await portalPayload(sb, token.value);
    res.json({ ok: true, portal: payload });
  } catch (e) { next(e); }
});

router.post('/status-token/:token/rating', async (req, res, next) => {
  try {
    const token = verifyPortalToken(req.params.token, 'booking_rating');
    const sb = getSupabase();
    const result = await savePortalRating(sb, token.value, req.body);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/consent-token/:token', async (req, res, next) => {
  try {
    const token = verifyPortalToken(req.params.token, 'elder_consent');
    const sb = getSupabase();
    const consentProfile = await consentProfilePayload(sb, token.value);
    res.json({ ok: true, consent_profile: consentProfile });
  } catch (e) { next(e); }
});

router.post('/consent-token/:token', async (req, res, next) => {
  try {
    const token = verifyPortalToken(req.params.token, 'elder_consent');
    const input = PortalConsentSchema.parse(req.body);
    const sb = getSupabase();
    const result = await savePortalConsent(sb, token.value, input, req);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/status/:booking_no', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const payload = await portalPayload(sb, req.params.booking_no);
    res.json({ ok: true, portal: payload });
  } catch (e) { next(e); }
});

router.post('/status/:booking_no/rating', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const result = await savePortalRating(sb, req.params.booking_no, req.body);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
