const express = require('express');
const { getSupabase } = require('../db/supabase');

const router = express.Router();

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function groupCount(rows = [], key) {
  return rows.reduce((groups, row) => {
    const value = row[key] || 'unknown';
    groups[value] = (groups[value] || 0) + 1;
    return groups;
  }, {});
}

function monthKey(value) {
  if (!value) return 'unscheduled';
  return new Date(value).toISOString().slice(0, 7);
}

router.get('/operations', async (_, res, next) => {
  try {
    const sb = getSupabase();
    const [bookings, payments, incidents, ratings, drivers, assignments] = await Promise.all([
      sb.from('bookings').select('id,booking_no,customer_id,service_type,status,risk_level,pickup_at,final_price,quoted_price,payment_status'),
      sb.from('payments').select('booking_id,amount,payment_status,paid_at'),
      sb.from('incidents').select('id,booking_id,driver_id,severity,incident_type,status,created_at'),
      sb.from('ratings').select('driver_id,rating,created_at'),
      sb.from('drivers').select('id,full_name,status,rating_avg,total_jobs'),
      sb.from('assignments').select('id,booking_id,driver_id,status')
    ]);
    if (bookings.error) throw bookings.error;
    if (payments.error) throw payments.error;
    if (incidents.error) throw incidents.error;
    if (ratings.error) throw ratings.error;
    if (drivers.error) throw drivers.error;
    if (assignments.error) throw assignments.error;

    const bookingRows = bookings.data || [];
    const paymentRows = payments.data || [];
    const paidRevenue = paymentRows
      .filter((payment) => !['refunded', 'partial_refunded'].includes(payment.payment_status))
      .reduce((sum, payment) => sum + numeric(payment.amount), 0);
    const bookedRevenue = bookingRows.reduce((sum, booking) => sum + numeric(booking.final_price || booking.quoted_price), 0);
    const completed = bookingRows.filter((booking) => booking.status === 'completed').length;
    const openIncidents = (incidents.data || []).filter((incident) => incident.status !== 'closed').length;
    const customers = groupCount(bookingRows, 'customer_id');
    const repeatCustomers = Object.values(customers).filter((count) => count > 1).length;

    const serviceMix = Object.entries(groupCount(bookingRows, 'service_type')).map(([service_type, count]) => ({
      service_type,
      count,
      revenue: bookingRows
        .filter((booking) => booking.service_type === service_type)
        .reduce((sum, booking) => sum + numeric(booking.final_price || booking.quoted_price), 0)
    }));
    const statusMix = Object.entries(groupCount(bookingRows, 'status')).map(([status, count]) => ({ status, count }));
    const incidentMix = Object.entries(groupCount(incidents.data || [], 'severity')).map(([severity, count]) => ({ severity, count }));
    const monthly = Object.values(bookingRows.reduce((months, booking) => {
      const key = monthKey(booking.pickup_at);
      if (!months[key]) months[key] = { month: key, bookings: 0, revenue: 0 };
      months[key].bookings += 1;
      months[key].revenue += numeric(booking.final_price || booking.quoted_price);
      return months;
    }, {})).sort((a, b) => a.month.localeCompare(b.month));

    const assignmentsByDriver = (assignments.data || []).reduce((groups, assignment) => {
      if (!assignment.driver_id) return groups;
      if (!groups[assignment.driver_id]) groups[assignment.driver_id] = [];
      groups[assignment.driver_id].push(assignment);
      return groups;
    }, {});
    const ratingsByDriver = (ratings.data || []).reduce((groups, rating) => {
      if (!rating.driver_id) return groups;
      if (!groups[rating.driver_id]) groups[rating.driver_id] = [];
      groups[rating.driver_id].push(rating);
      return groups;
    }, {});
    const driverPerformance = (drivers.data || []).map((driver) => {
      const driverRatings = ratingsByDriver[driver.id] || [];
      const avgRating = driverRatings.length
        ? driverRatings.reduce((sum, rating) => sum + numeric(rating.rating), 0) / driverRatings.length
        : numeric(driver.rating_avg);
      return {
        id: driver.id,
        full_name: driver.full_name,
        status: driver.status,
        assignment_count: (assignmentsByDriver[driver.id] || []).length,
        avg_rating: Math.round(avgRating * 100) / 100,
        total_jobs: numeric(driver.total_jobs)
      };
    }).sort((a, b) => b.assignment_count - a.assignment_count);

    res.json({
      ok: true,
      report: {
        summary: {
          total_bookings: bookingRows.length,
          completed_bookings: completed,
          completion_rate: bookingRows.length ? Math.round((completed / bookingRows.length) * 10000) / 100 : 0,
          booked_revenue: bookedRevenue,
          paid_revenue: paidRevenue,
          outstanding_revenue: Math.max(0, bookedRevenue - paidRevenue),
          open_incidents: openIncidents,
          repeat_customers: repeatCustomers
        },
        service_mix: serviceMix,
        status_mix: statusMix,
        incident_mix: incidentMix,
        monthly,
        driver_performance: driverPerformance
      }
    });
  } catch (e) { next(e); }
});

module.exports = router;
