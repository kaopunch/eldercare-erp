const express = require('express');
const { getSupabase } = require('../db/supabase');
const { subscribeRealtimeEvents } = require('../lib/aiEventBus');
const { eventVisibleToActor } = require('../lib/aiVisibility');

const router = express.Router();

function sendSse(res, event, data = {}) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function assignedBookingIds(sb, actor = {}) {
  if (!actor.id || ['owner', 'admin', 'dispatcher'].includes(actor.role)) return new Set();
  const { data, error } = await sb.from('assignments')
    .select('booking_id,care_assistant_id,drivers(user_id)')
    .limit(1000);
  if (error) throw error;
  return new Set((data || [])
    .filter((assignment) => {
      const driver = Array.isArray(assignment.drivers) ? assignment.drivers[0] : assignment.drivers;
      return assignment.care_assistant_id === actor.id || driver?.user_id === actor.id;
    })
    .map((assignment) => assignment.booking_id)
    .filter(Boolean));
}

router.get('/', async (req, res, next) => {
  try {
    const bookingId = req.query.booking_id || null;
    const sb = getSupabase();
    const bookingIds = await assignedBookingIds(sb, req.actor || {});
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    sendSse(res, 'hello', {
      ok: true,
      actor_role: req.actor?.role || null,
      actor_user_id: req.actor?.id || null,
      booking_id: bookingId,
      visible_booking_count: bookingIds.size,
      streamed_at: new Date().toISOString()
    });

    const unsubscribe = subscribeRealtimeEvents((event) => {
      if (bookingId && event.booking_id !== bookingId) return;
      if (!eventVisibleToActor(event, req.actor, { bookingIds })) return;
      sendSse(res, 'realtime_event', event);
    });
    const heartbeat = setInterval(() => {
      sendSse(res, 'heartbeat', { streamed_at: new Date().toISOString() });
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
