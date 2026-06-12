const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  createBookingStateMachine
} = require('../src/modules/booking/stateMachine');

function createFakeMachineRepository(initialStatus = 'draft') {
  const booking = { id: 'b1', status: initialStatus };
  const events = [];
  return {
    booking,
    events,
    async updateBookingStatus(bookingId, fromStatus, patch) {
      if (booking.id !== bookingId || booking.status !== fromStatus) return null;
      Object.assign(booking, patch);
      return { ...booking };
    },
    async insertBookingEvent(event) {
      events.push(event);
      return { id: `ev${events.length}` };
    }
  };
}

test('happy path walks the full spec flow', async () => {
  const repository = createFakeMachineRepository('draft');
  const machine = createBookingStateMachine({ repository });
  const path = [
    'pending_payment',
    'searching',
    'matched',
    'confirmed',
    'in_progress_pickup',
    'at_destination',
    'returning',
    'pending_confirmation',
    'completed'
  ];
  for (const next of path) {
    const { changed } = await machine.transition({ ...repository.booking }, next, { actor: 'system' });
    assert.equal(changed, true);
    assert.equal(repository.booking.status, next);
  }
  assert.equal(repository.events.length, path.length);
  assert.deepEqual(
    repository.events.map((event) => event.eventType),
    ['created', 'paid', 'matched', 'accepted', 'checkin_home', 'arrived_destination', 'departing', 'checkout_home', 'completed']
  );
});

test('repeating a transition is a no-op (idempotent)', async () => {
  const repository = createFakeMachineRepository('pending_payment');
  const machine = createBookingStateMachine({ repository });
  const first = await machine.transition({ ...repository.booking }, 'searching', { actor: 'system' });
  assert.equal(first.changed, true);
  const second = await machine.transition({ ...repository.booking }, 'searching', { actor: 'system' });
  assert.equal(second.changed, false);
  assert.equal(repository.events.length, 1, 'no duplicate event on repeat');
});

test('invalid transitions are rejected with TRANSITION_INVALID', async () => {
  const repository = createFakeMachineRepository('searching');
  const machine = createBookingStateMachine({ repository });
  await assert.rejects(
    machine.transition({ ...repository.booking }, 'completed', { actor: 'system' }),
    (err) => err.code === 'TRANSITION_INVALID'
  );
  assert.equal(repository.events.length, 0);
});

test('terminal states allow no transitions', () => {
  for (const terminal of ['completed', 'cancelled', 'disputed']) {
    for (const target of STATUSES) {
      if (target === terminal) continue;
      assert.equal(canTransition(terminal, target), false, `${terminal} -> ${target}`);
    }
  }
});

test('cancellation allowed exactly from pending_payment..confirmed', () => {
  const cancellable = STATUSES.filter((status) => canTransition(status, 'cancelled'));
  assert.deepEqual(cancellable.sort(), ['confirmed', 'matched', 'pending_payment', 'searching'].sort());
});

test('lost race surfaces TRANSITION_CONFLICT', async () => {
  const repository = createFakeMachineRepository('pending_payment');
  const machine = createBookingStateMachine({ repository });
  const stale = { ...repository.booking };
  await machine.transition({ ...repository.booking }, 'searching', { actor: 'system' });
  // stale caller still believes status is pending_payment and wants cancelled
  await assert.rejects(
    machine.transition(stale, 'cancelled', { actor: 'customer' }),
    (err) => err.code === 'TRANSITION_CONFLICT'
  );
});

test('every status in the transition table is a known status', () => {
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    assert.ok(STATUSES.includes(from));
    for (const to of targets) assert.ok(STATUSES.includes(to), `${from} -> ${to}`);
  }
});
