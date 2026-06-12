const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BATCH_SIZE,
  requiredSlots,
  rankCandidates,
  searchTimedOut,
  createMatchingEngine
} = require('../src/modules/booking/matching');

const BOOKING = {
  id: 'bk-1',
  status: 'searching',
  scheduled_date: '2027-01-15',
  pickup_time: '09:00',
  duration_type: 'half_day',
  pickup_lat: 13.7563,
  pickup_lng: 100.5018,
  special_requirements: {},
  search_started_at: new Date().toISOString()
};

function profile(overrides = {}) {
  return {
    user_id: `cg-${Math.random().toString(36).slice(2, 8)}`,
    gender: 'female',
    languages: ['th'],
    service_area_lat: 13.75,
    service_area_lng: 100.5,
    service_radius_km: 15,
    verification_status: 'verified',
    rating_avg: 4.5,
    jobs_completed: 10,
    availability: { morning: true, afternoon: true },
    ...overrides
  };
}

test('requiredSlots: half-day by pickup hour, full day needs both', () => {
  assert.deepEqual(requiredSlots({ duration_type: 'half_day', pickup_time: '09:00' }), ['morning']);
  assert.deepEqual(requiredSlots({ duration_type: 'half_day', pickup_time: '13:30' }), ['afternoon']);
  assert.deepEqual(requiredSlots({ duration_type: 'full_day', pickup_time: '09:00' }), ['morning', 'afternoon']);
});

test('filters: unverified, unavailable, out-of-radius, gender/language mismatches all excluded', () => {
  const good = profile({ user_id: 'good' });
  const candidates = rankCandidates(
    {
      ...BOOKING,
      special_requirements: { english: true, caregiver_gender: 'female' }
    },
    [
      { ...good, languages: ['th', 'en'] },
      profile({ user_id: 'unverified', verification_status: 'documents_submitted', languages: ['th', 'en'] }),
      profile({ user_id: 'no-avail', availability: null, languages: ['th', 'en'] }),
      profile({ user_id: 'wrong-slot', availability: { morning: false, afternoon: true }, languages: ['th', 'en'] }),
      profile({ user_id: 'too-far', service_area_lat: 14.5, languages: ['th', 'en'] }), // ~80km
      profile({ user_id: 'male', gender: 'male', languages: ['th', 'en'] }),
      profile({ user_id: 'no-english' }) // th only
    ]
  );
  assert.deepEqual(candidates.map((candidate) => candidate.user_id), ['good']);
});

test('ranking: rating desc, then distance asc, then jobs done desc', () => {
  const candidates = rankCandidates(BOOKING, [
    profile({ user_id: 'far-good', rating_avg: 4.9, service_area_lat: 13.8 }),
    profile({ user_id: 'near-good', rating_avg: 4.9, service_area_lat: 13.756 }),
    profile({ user_id: 'low-rating', rating_avg: 3.0, jobs_completed: 99 }),
    profile({ user_id: 'same-dist-more-jobs', rating_avg: 4.9, service_area_lat: 13.756, jobs_completed: 50 })
  ]);
  assert.deepEqual(
    candidates.map((candidate) => candidate.user_id),
    ['same-dist-more-jobs', 'near-good', 'far-good', 'low-rating']
  );
});

test('searchTimedOut after 4h of searching or <3h before pickup', () => {
  const now = new Date('2027-01-10T03:00:00Z');
  const fresh = { ...BOOKING, search_started_at: '2027-01-10T02:00:00Z' };
  assert.equal(searchTimedOut(fresh, now), false);
  const stale = { ...BOOKING, search_started_at: '2027-01-09T22:00:00Z' };
  assert.equal(searchTimedOut(stale, now), true);
  // pickup within 3 hours (pickup 09:00 +07 = 02:00Z; now 00:00Z = 2h before)
  const lastMinute = {
    ...BOOKING,
    scheduled_date: '2027-01-10',
    pickup_time: '09:00',
    search_started_at: '2027-01-09T23:30:00Z'
  };
  assert.equal(searchTimedOut(lastMinute, new Date('2027-01-10T00:00:00Z')), true);
});

function createFakeMatchingRepository(profiles) {
  const offers = [];
  return {
    offers,
    async listVerifiedCaregiversWithAvailability() {
      return profiles.filter((row) => row.verification_status === 'verified');
    },
    async listOffersForBooking(bookingId) {
      return offers.filter((offer) => offer.booking_id === bookingId);
    },
    async insertOffers(rows) {
      for (const row of rows) offers.push({ ...row, status: 'offered' });
      return rows;
    },
    async expireOffers(bookingId, nowIso) {
      for (const offer of offers) {
        if (offer.booking_id === bookingId && offer.status === 'offered' && offer.expires_at <= nowIso) {
          offer.status = 'expired';
        }
      }
    }
  };
}

test('advanceOffers sends batches of 5 and progresses only when the batch expires', async () => {
  const profiles = Array.from({ length: 8 }, (_, index) =>
    profile({ user_id: `cg-${index}`, rating_avg: 5 - index * 0.1 })
  );
  const repository = createFakeMatchingRepository(profiles);
  let clock = new Date('2027-01-10T00:00:00Z');
  const engine = createMatchingEngine({ repository, now: () => clock });
  const booking = { ...BOOKING, search_started_at: '2027-01-10T00:00:00Z' };

  const batch1 = await engine.advanceOffers(booking);
  assert.equal(batch1.batch_no, 1);
  assert.equal(batch1.offered, BATCH_SIZE);
  // best-ranked caregivers got batch 1
  assert.deepEqual(
    repository.offers.map((offer) => offer.caregiver_user_id),
    ['cg-0', 'cg-1', 'cg-2', 'cg-3', 'cg-4']
  );

  // batch still live -> no-op
  assert.equal(await engine.advanceOffers(booking), null);

  // 11 minutes later the batch expired -> next 3 caregivers get batch 2
  clock = new Date('2027-01-10T00:11:00Z');
  const batch2 = await engine.advanceOffers(booking);
  assert.equal(batch2.batch_no, 2);
  assert.equal(batch2.offered, 3);
  assert.equal(repository.offers.filter((offer) => offer.status === 'expired').length, BATCH_SIZE);

  // everyone offered -> nothing left
  clock = new Date('2027-01-10T00:22:00Z');
  assert.equal(await engine.advanceOffers(booking), null);
});

test('advanceOffers is a no-op for non-searching or timed-out bookings', async () => {
  const repository = createFakeMatchingRepository([profile()]);
  const engine = createMatchingEngine({ repository });
  assert.equal(await engine.advanceOffers({ ...BOOKING, status: 'matched' }), null);
  assert.equal(
    await engine.advanceOffers({
      ...BOOKING,
      search_started_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
    }),
    null
  );
  assert.equal(repository.offers.length, 0);
});
