/**
 * BookingStateMachine — the single authority for booking status changes
 * (CLAUDE.md iron rule 5: never set booking.status anywhere else).
 *
 * Spec section 3:
 *   draft → pending_payment → searching → matched → confirmed
 *     → in_progress_pickup → at_destination → returning
 *     → pending_confirmation → completed | disputed
 *   cancellable from pending_payment..confirmed → cancelled
 *
 * Properties:
 * - table-driven: ALLOWED_TRANSITIONS is the contract both portals rely on
 * - idempotent: transitioning to the current status is a no-op (returns the
 *   booking unchanged, writes no event) so double-taps/retries never corrupt
 * - every real transition appends one care_booking_events row
 */
const { AppError } = require('../shared/appError');

const STATUSES = [
  'draft',
  'pending_payment',
  'searching',
  'matched',
  'confirmed',
  'in_progress_pickup',
  'at_destination',
  'returning',
  'pending_confirmation',
  'completed',
  'cancelled',
  'disputed'
];

const CANCELLABLE = ['pending_payment', 'searching', 'matched', 'confirmed'];

const ALLOWED_TRANSITIONS = {
  draft: ['pending_payment'],
  pending_payment: ['searching', 'cancelled'],
  searching: ['matched', 'cancelled'],
  matched: ['confirmed', 'cancelled'],
  confirmed: ['in_progress_pickup', 'cancelled'],
  in_progress_pickup: ['at_destination'],
  at_destination: ['returning'],
  returning: ['pending_confirmation'],
  pending_confirmation: ['completed', 'disputed'],
  completed: [],
  cancelled: [],
  disputed: []
};

/** Default event_type per target status (spec booking_events enum). */
const EVENT_FOR_STATUS = {
  pending_payment: 'created',
  searching: 'paid',
  matched: 'matched',
  confirmed: 'accepted',
  in_progress_pickup: 'checkin_home',
  at_destination: 'arrived_destination',
  returning: 'departing',
  pending_confirmation: 'checkout_home',
  completed: 'completed',
  cancelled: 'cancelled',
  disputed: 'disputed'
};

const ACTORS = ['customer', 'caregiver', 'system', 'admin'];

function assertKnownStatus(status) {
  if (!STATUSES.includes(status)) {
    throw new AppError('STATUS_UNKNOWN', 'สถานะงานไม่ถูกต้อง', 500, { status });
  }
}

function canTransition(fromStatus, toStatus) {
  assertKnownStatus(fromStatus);
  assertKnownStatus(toStatus);
  return ALLOWED_TRANSITIONS[fromStatus].includes(toStatus);
}

/**
 * createBookingStateMachine({repository}) — repository must provide:
 *   updateBookingStatus(bookingId, fromStatus, patch) -> updated row | null
 *     (conditional update WHERE status = fromStatus — the DB row lock that
 *      makes concurrent transitions safe; null means lost the race)
 *   insertBookingEvent({bookingId, eventType, actor, lat, lng, payload})
 */
function createBookingStateMachine({ repository }) {
  /**
   * Transition a booking. Idempotent: if booking.status === toStatus, no-op.
   * @param {object} booking current row (id + status required)
   * @param {string} toStatus
   * @param {object} options {actor, eventType?, payload?, location?, patch?}
   */
  async function transition(booking, toStatus, options = {}) {
    const { actor, eventType, payload = {}, location = null, patch = {} } = options;
    assertKnownStatus(toStatus);
    if (!ACTORS.includes(actor)) {
      throw new AppError('ACTOR_INVALID', 'ผู้กระทำไม่ถูกต้อง', 500, { actor });
    }

    if (booking.status === toStatus) {
      return { booking, changed: false }; // idempotent repeat
    }
    if (!canTransition(booking.status, toStatus)) {
      throw new AppError(
        'TRANSITION_INVALID',
        'ไม่สามารถเปลี่ยนสถานะงานนี้ได้',
        409,
        { from: booking.status, to: toStatus }
      );
    }

    const updated = await repository.updateBookingStatus(booking.id, booking.status, {
      ...patch,
      status: toStatus
    });
    if (!updated) {
      // someone else transitioned first; surface as conflict so caller can re-read
      throw new AppError('TRANSITION_CONFLICT', 'สถานะงานเปลี่ยนไปแล้ว กรุณาลองใหม่', 409, {
        from: booking.status,
        to: toStatus
      });
    }

    await repository.insertBookingEvent({
      bookingId: booking.id,
      eventType: eventType || EVENT_FOR_STATUS[toStatus] || 'status_changed',
      actor,
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      payload: { ...payload, from: booking.status, to: toStatus }
    });

    return { booking: updated, changed: true };
  }

  return { transition, canTransition };
}

module.exports = {
  STATUSES,
  CANCELLABLE,
  ALLOWED_TRANSITIONS,
  canTransition,
  createBookingStateMachine
};
