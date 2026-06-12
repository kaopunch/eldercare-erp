/**
 * Matching engine (spec 5.2). When a booking enters `searching`:
 *  1. candidates: verified caregivers, available that date+slot, pickup inside
 *     service radius, passing gender/language filters
 *  2. rank: rating desc -> distance asc -> jobs_completed desc
 *  3. offer in batches of BATCH_SIZE; each batch lives OFFER_TTL_MINUTES;
 *     batch progression is lazy (advanced whenever offers are read)
 *  4. first-accept-wins via the state machine's conditional update
 *  5. search times out after SEARCH_TIMEOUT_HOURS or when less than
 *     MIN_HOURS_BEFORE_PICKUP remain -> event logged, customer can cancel
 *     with a full refund (no caregiver was assigned)
 *
 * Distance math uses the denormalized lat/lng columns (DECISIONS.md M1 #5);
 * PostGIS ST_DWithin can replace it when caregiver count grows.
 */
const { haversineKm } = require('./pricing');

const BATCH_SIZE = 5;
const OFFER_TTL_MINUTES = 10;
const SEARCH_TIMEOUT_HOURS = 4;
const MIN_HOURS_BEFORE_PICKUP = 3;

/** Booking slot needed: full_day needs both; half_day by pickup hour (<12 = morning). */
function requiredSlots(booking) {
  if (booking.duration_type === 'full_day') return ['morning', 'afternoon'];
  const hour = Number(String(booking.pickup_time).slice(0, 2));
  return [hour < 12 ? 'morning' : 'afternoon'];
}

function caregiverMatchesRequirements(profile, requirements = {}) {
  if (requirements.english && !(profile.languages || []).includes('en')) return false;
  if (requirements.caregiver_gender && profile.gender !== requirements.caregiver_gender) return false;
  return true;
}

/**
 * Filter + rank candidates for a booking.
 * @param {object} booking care_bookings row
 * @param {Array} profiles verified caregiver profiles (with availability pre-joined
 *   as profile.availability = slots object for booking.scheduled_date, or null)
 * @returns ranked [{user_id, distance_km}]
 */
function rankCandidates(booking, profiles) {
  const pickup = { lat: Number(booking.pickup_lat), lng: Number(booking.pickup_lng) };
  const slots = requiredSlots(booking);
  const candidates = [];
  for (const profile of profiles) {
    if (profile.verification_status !== 'verified') continue;
    if (!profile.availability) continue;
    if (!slots.every((slot) => profile.availability[slot] === true)) continue;
    if (
      profile.service_area_lat === null ||
      profile.service_area_lat === undefined ||
      !profile.service_radius_km
    ) {
      continue;
    }
    const distanceKm =
      Math.round(
        haversineKm(pickup, {
          lat: Number(profile.service_area_lat),
          lng: Number(profile.service_area_lng)
        }) * 10
      ) / 10;
    if (distanceKm > Number(profile.service_radius_km)) continue;
    if (!caregiverMatchesRequirements(profile, booking.special_requirements)) continue;
    candidates.push({
      user_id: profile.user_id,
      distance_km: distanceKm,
      rating_avg: Number(profile.rating_avg) || 0,
      jobs_completed: Number(profile.jobs_completed) || 0
    });
  }
  candidates.sort(
    (a, b) =>
      b.rating_avg - a.rating_avg ||
      a.distance_km - b.distance_km ||
      b.jobs_completed - a.jobs_completed
  );
  return candidates;
}

function searchTimedOut(booking, now = new Date()) {
  const startedAt = booking.search_started_at ? new Date(booking.search_started_at) : null;
  if (startedAt && now.getTime() - startedAt.getTime() > SEARCH_TIMEOUT_HOURS * 60 * 60 * 1000) {
    return true;
  }
  const pickupAt = new Date(`${booking.scheduled_date}T${booking.pickup_time}+07:00`);
  return pickupAt.getTime() - now.getTime() < MIN_HOURS_BEFORE_PICKUP * 60 * 60 * 1000;
}

/**
 * createMatchingEngine({repository}) — repository needs:
 *   listVerifiedCaregiversWithAvailability(date) -> profiles (+availability)
 *   listOffersForBooking(bookingId), insertOffers(rows),
 *   expireOffers(bookingId, nowIso), findBookingById(id)
 */
function createMatchingEngine({ repository, notifier = null, now = () => new Date() }) {
  /**
   * Create the next offer batch for a searching booking (idempotent: skips
   * caregivers already offered; no-op when a live batch exists or search
   * timed out). Returns {batch_no, offered} or null.
   */
  async function advanceOffers(booking) {
    if (booking.status !== 'searching') return null;
    if (searchTimedOut(booking, now())) return null;

    const existing = await repository.listOffersForBooking(booking.id);
    const nowIso = now().toISOString();
    const live = existing.filter(
      (offer) => offer.status === 'offered' && offer.expires_at > nowIso
    );
    if (live.length) return null; // current batch still running

    // mark stale offered rows expired
    await repository.expireOffers(booking.id, nowIso);

    const profiles = await repository.listVerifiedCaregiversWithAvailability(booking.scheduled_date);
    const ranked = rankCandidates(booking, profiles);
    const alreadyOffered = new Set(existing.map((offer) => offer.caregiver_user_id));
    const nextUp = ranked.filter((candidate) => !alreadyOffered.has(candidate.user_id)).slice(0, BATCH_SIZE);
    if (!nextUp.length) return null;

    const batchNo = existing.length ? Math.max(...existing.map((offer) => offer.batch_no)) + 1 : 1;
    const expiresAt = new Date(now().getTime() + OFFER_TTL_MINUTES * 60 * 1000).toISOString();
    await repository.insertOffers(
      nextUp.map((candidate) => ({
        booking_id: booking.id,
        caregiver_user_id: candidate.user_id,
        batch_no: batchNo,
        distance_km: candidate.distance_km,
        expires_at: expiresAt
      }))
    );
    if (notifier) {
      for (const candidate of nextUp) {
        notifier({
          userId: candidate.user_id,
          bookingId: booking.id,
          template: 'new_offer',
          data: {
            scheduled_date: booking.scheduled_date,
            pickup_time: booking.pickup_time,
            payout_satang: booking.caregiver_payout
          }
        });
      }
    }
    return { batch_no: batchNo, offered: nextUp.length, offered_user_ids: nextUp.map((candidate) => candidate.user_id) };
  }

  return { advanceOffers, rankCandidates, requiredSlots, searchTimedOut };
}

module.exports = {
  BATCH_SIZE,
  OFFER_TTL_MINUTES,
  SEARCH_TIMEOUT_HOURS,
  MIN_HOURS_BEFORE_PICKUP,
  requiredSlots,
  rankCandidates,
  searchTimedOut,
  createMatchingEngine
};
