const express = require('express');
const { getSupabase } = require('../db/supabase');
const { queueNotification } = require('../lib/notifications');

const router = express.Router();

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function groupBy(rows = [], key) {
  return rows.reduce((groups, row) => {
    const value = row[key];
    if (!value) return groups;
    if (!groups[value]) groups[value] = [];
    groups[value].push(row);
    return groups;
  }, {});
}

function indexById(rows = []) {
  return rows.reduce((map, row) => {
    map[row.id] = row;
    return map;
  }, {});
}

function average(values = []) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value));
  if (!clean.length) return 0;
  return Math.round((clean.reduce((sum, value) => sum + value, 0) / clean.length) * 100) / 100;
}

function currentMonthPeriod() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    review_period_start: start.toISOString().slice(0, 10),
    review_period_end: end.toISOString().slice(0, 10)
  };
}

function driverReviewResult({ jobsCompleted, avgRating, onTimeRate, incidentCount, complaintCount, highIncidentCount }) {
  if (highIncidentCount >= 1) return 'immediate_review';
  if (avgRating > 0 && avgRating < 3.5) return 'suspend_review';
  if (complaintCount >= 3) return 'quality_review';
  if (jobsCompleted > 0 && onTimeRate < 85) return 'warning';
  if (incidentCount > 0 || (avgRating > 0 && avgRating < 4.2)) return 'watch';
  return 'healthy';
}

async function selectByIds(sb, table, columns, ids) {
  if (!ids.length) return [];
  const { data, error } = await sb.from(table).select(columns).in('id', ids);
  if (error) throw error;
  return data || [];
}

function lateMinutes(booking, arrivalEvent) {
  if (!booking?.pickup_at || !arrivalEvent?.event_at) return null;
  const scheduled = new Date(booking.pickup_at).getTime();
  const arrived = new Date(arrivalEvent.event_at).getTime();
  if (!Number.isFinite(scheduled) || !Number.isFinite(arrived)) return null;
  return Math.round((arrived - scheduled) / 60000);
}

function buildDriverQuality(driver, context) {
  const assignments = context.assignmentsByDriver[driver.id] || [];
  const assignedBookingIds = unique(assignments.map((assignment) => assignment.booking_id));
  const completedBookingIds = assignedBookingIds.filter((bookingId) => context.bookingsById[bookingId]?.status === 'completed');
  const ratings = context.ratingsByDriver[driver.id] || [];
  const directIncidents = context.incidentsByDriver[driver.id] || [];
  const bookingIncidents = assignedBookingIds.flatMap((bookingId) => context.incidentsByBooking[bookingId] || []);
  const incidents = [...directIncidents, ...bookingIncidents].filter((incident, index, all) => (
    all.findIndex((item) => item.id === incident.id) === index
  ));
  const arrivalScores = completedBookingIds
    .map((bookingId) => {
      const booking = context.bookingsById[bookingId];
      const arrival = (context.eventsByBooking[bookingId] || []).find((event) => event.event_type === 'arrived_pickup');
      const minutes = lateMinutes(booking, arrival);
      return minutes === null ? null : minutes <= 15;
    })
    .filter((value) => value !== null);

  const jobsCompleted = completedBookingIds.length;
  const avgRating = average(ratings.map((rating) => rating.rating));
  const onTimeRate = arrivalScores.length
    ? Math.round((arrivalScores.filter(Boolean).length / arrivalScores.length) * 10000) / 100
    : (jobsCompleted ? 0 : 100);
  const complaintCount = incidents.filter((incident) => incident.incident_type === 'complaint').length;
  const highIncidentCount = incidents.filter((incident) => ['high', 'critical'].includes(incident.severity)).length;
  const reviewResult = driverReviewResult({
    jobsCompleted,
    avgRating,
    onTimeRate,
    incidentCount: incidents.length,
    complaintCount,
    highIncidentCount
  });

  return {
    driver,
    jobs_completed: jobsCompleted,
    avg_rating: avgRating,
    on_time_rate: onTimeRate,
    incident_count: incidents.length,
    complaint_count: complaintCount,
    high_incident_count: highIncidentCount,
    review_result: reviewResult,
    ratings: ratings.slice(0, 8),
    incidents: incidents.slice(0, 8),
    reviews: context.reviewsByDriver[driver.id] || [],
    completed_bookings: completedBookingIds.map((bookingId) => context.bookingsById[bookingId]).filter(Boolean)
  };
}

async function loadQualityContext(sb) {
  const [drivers, assignments, ratings, incidents, reviews] = await Promise.all([
    sb.from('drivers').select('*').order('joined_at', { ascending: false }),
    sb.from('assignments').select('id,driver_id,booking_id,status,assigned_at').order('assigned_at', { ascending: false }),
    sb.from('ratings').select('*').order('created_at', { ascending: false }),
    sb.from('incidents').select('*').order('created_at', { ascending: false }),
    sb.from('driver_quality_reviews').select('*').order('reviewed_at', { ascending: false })
  ]);
  if (drivers.error) throw drivers.error;
  if (assignments.error) throw assignments.error;
  if (ratings.error) throw ratings.error;
  if (incidents.error) throw incidents.error;
  if (reviews.error) throw reviews.error;

  const bookingIds = unique((assignments.data || []).map((assignment) => assignment.booking_id));
  const bookings = await selectByIds(sb, 'bookings', 'id,booking_no,status,pickup_at,customer_id,elder_id,service_type,elders(full_name),customers(full_name,phone)', bookingIds);
  const events = bookingIds.length
    ? await selectByIds(sb, 'trip_events', 'id,booking_id,event_type,event_at', [])
    : [];
  let tripEvents = events;
  if (bookingIds.length) {
    const { data, error } = await sb.from('trip_events')
      .select('id,booking_id,event_type,event_at')
      .in('booking_id', bookingIds)
      .order('event_at', { ascending: true });
    if (error) throw error;
    tripEvents = data || [];
  }

  return {
    drivers: drivers.data || [],
    assignments: assignments.data || [],
    ratings: ratings.data || [],
    incidents: incidents.data || [],
    reviews: reviews.data || [],
    bookingsById: indexById(bookings),
    assignmentsByDriver: groupBy(assignments.data || [], 'driver_id'),
    ratingsByDriver: groupBy(ratings.data || [], 'driver_id'),
    incidentsByDriver: groupBy(incidents.data || [], 'driver_id'),
    incidentsByBooking: groupBy(incidents.data || [], 'booking_id'),
    reviewsByDriver: groupBy(reviews.data || [], 'driver_id'),
    eventsByBooking: groupBy(tripEvents, 'booking_id')
  };
}

async function calculateDriverQuality(sb, driverId) {
  const context = await loadQualityContext(sb);
  const driver = context.drivers.find((item) => item.id === driverId);
  if (!driver) {
    const error = new Error('driver not found');
    error.statusCode = 404;
    error.code = 'DRIVER_NOT_FOUND';
    throw error;
  }
  return buildDriverQuality(driver, context);
}

router.get('/dashboard', async (_, res, next) => {
  try {
    const sb = getSupabase();
    const context = await loadQualityContext(sb);
    const drivers = context.drivers.map((driver) => buildDriverQuality(driver, context));
    const needsReview = drivers.filter((driver) => !['healthy', 'watch'].includes(driver.review_result)).length;
    const avgRating = average(drivers.map((driver) => driver.avg_rating).filter(Boolean));
    const avgOnTime = average(drivers.map((driver) => driver.on_time_rate));
    res.json({
      ok: true,
      summary: {
        drivers: drivers.length,
        needs_review: needsReview,
        avg_rating: avgRating,
        avg_on_time_rate: avgOnTime
      },
      drivers
    });
  } catch (e) { next(e); }
});

router.post('/ratings', async (req, res, next) => {
  try {
    const ratingValue = Number(req.body.rating);
    if (!Number.isInteger(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      const error = new Error('rating must be an integer between 1 and 5');
      error.statusCode = 422;
      error.code = 'RATING_INVALID';
      throw error;
    }

    const sb = getSupabase();
    const { data: booking, error: bookingError } = await sb.from('bookings')
      .select('id,booking_no,customer_id,status')
      .eq('id', req.body.booking_id)
      .single();
    if (bookingError) throw bookingError;

    const { data: assignment, error: assignmentError } = await sb.from('assignments')
      .select('id,driver_id')
      .eq('booking_id', booking.id)
      .order('assigned_at', { ascending: false })
      .limit(1)
      .single();
    if (assignmentError) throw assignmentError;

    const { data: rating, error } = await sb.from('ratings').insert({
      booking_id: booking.id,
      driver_id: req.body.driver_id || assignment.driver_id,
      customer_id: req.body.customer_id || booking.customer_id,
      rating: ratingValue,
      comment: req.body.comment || null
    }).select('*').single();
    if (error) throw error;

    const quality = await calculateDriverQuality(sb, rating.driver_id);
    await sb.from('drivers').update({
      rating_avg: quality.avg_rating,
      total_jobs: quality.jobs_completed
    }).eq('id', rating.driver_id);

    if (['immediate_review', 'suspend_review', 'quality_review'].includes(quality.review_result) || ratingValue <= 2) {
      const period = currentMonthPeriod();
      await sb.from('driver_quality_reviews').insert({
        driver_id: rating.driver_id,
        ...period,
        jobs_completed: quality.jobs_completed,
        avg_rating: quality.avg_rating,
        on_time_rate: quality.on_time_rate,
        incident_count: quality.incident_count,
        complaint_count: quality.complaint_count,
        review_result: ratingValue <= 2 ? 'low_rating_review' : quality.review_result,
        reviewed_by: req.body.reviewed_by || null
      });
      await sb.from('drivers').update({ status: 'reviewing' }).eq('id', rating.driver_id);
      await queueNotification(sb, {
        booking,
        type: 'quality_review_created',
        payload: {
          booking_no: booking.booking_no,
          driver_id: rating.driver_id,
          rating: ratingValue,
          review_result: ratingValue <= 2 ? 'low_rating_review' : quality.review_result
        }
      });
    }

    res.status(201).json({ ok: true, rating, quality });
  } catch (e) { next(e); }
});

router.post('/reviews', async (req, res, next) => {
  try {
    const sb = getSupabase();
    const quality = await calculateDriverQuality(sb, req.body.driver_id);
    const period = currentMonthPeriod();
    const { data, error } = await sb.from('driver_quality_reviews').insert({
      driver_id: req.body.driver_id,
      review_period_start: req.body.review_period_start || period.review_period_start,
      review_period_end: req.body.review_period_end || period.review_period_end,
      jobs_completed: quality.jobs_completed,
      avg_rating: quality.avg_rating,
      on_time_rate: quality.on_time_rate,
      incident_count: quality.incident_count,
      complaint_count: quality.complaint_count,
      review_result: req.body.review_result || quality.review_result,
      reviewed_by: req.body.reviewed_by || null
    }).select('*').single();
    if (error) throw error;

    if (!['healthy', 'watch'].includes(data.review_result)) {
      await sb.from('drivers').update({ status: data.review_result === 'suspend_review' ? 'suspended' : 'reviewing' }).eq('id', req.body.driver_id);
    }

    res.status(201).json({ ok: true, review: data, quality });
  } catch (e) { next(e); }
});

module.exports = router;
