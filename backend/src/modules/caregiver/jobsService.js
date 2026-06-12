/**
 * Caregiver jobs + availability (spec G2/G3).
 * - offers are job cards WITHOUT the full pickup address (spec: ไม่โชว์บ้านเลขที่
 *   เต็มก่อนรับงาน) — only approximate area (~1 km rounding) + distance + payout
 * - accept = first-accept-wins through BookingStateMachine's conditional update;
 *   the loser gets JOB_TAKEN
 */
const bookingRepository = require('../booking/repository');
const caregiverRepository = require('./repository');
const { createBookingStateMachine } = require('../booking/stateMachine');
const { createMatchingEngine } = require('../booking/matching');
const { notifySafe } = require('../notification/notifier');
const { AppError } = require('../shared/appError');

const ACTIVE_STATUSES = [
  'matched',
  'confirmed',
  'in_progress_pickup',
  'at_destination',
  'returning',
  'pending_confirmation'
];

function approx(value) {
  // ~1.1 km grid — enough for a map preview, not enough to identify the house
  return value === null || value === undefined ? null : Math.round(Number(value) * 100) / 100;
}

function offerCard(offer) {
  const booking = offer.booking;
  return {
    booking_id: offer.booking_id,
    batch_no: offer.batch_no,
    expires_at: offer.expires_at,
    scheduled_date: booking.scheduled_date,
    pickup_time: booking.pickup_time,
    service_type: booking.service_type,
    duration_type: booking.duration_type,
    destination_name: booking.destination_name,
    special_requirements: booking.special_requirements || {},
    distance_km: offer.distance_km === null ? null : Number(offer.distance_km),
    payout_satang: booking.caregiver_payout,
    area_approx:
      booking.pickup_lat === null
        ? null
        : { lat: approx(booking.pickup_lat), lng: approx(booking.pickup_lng) }
  };
}

/** Caregiver's view of an accepted job — full details unlocked. */
function jobView(booking) {
  return {
    id: booking.id,
    status: booking.status,
    service_type: booking.service_type,
    duration_type: booking.duration_type,
    scheduled_date: booking.scheduled_date,
    pickup_time: booking.pickup_time,
    pickup_address: booking.pickup_address,
    pickup_location:
      booking.pickup_lat === null
        ? null
        : { lat: Number(booking.pickup_lat), lng: Number(booking.pickup_lng) },
    destination_name: booking.destination_name,
    destination_address: booking.destination_address,
    destination_location:
      booking.destination_lat === null
        ? null
        : { lat: Number(booking.destination_lat), lng: Number(booking.destination_lng) },
    appointment_detail: booking.appointment_detail,
    special_requirements: booking.special_requirements || {},
    payout_satang: booking.caregiver_payout,
    matched_at: booking.matched_at
  };
}

function createJobsService({ repository = bookingRepository, profileRepository = caregiverRepository, notifier = null, now = () => new Date() } = {}) {
  const machine = createBookingStateMachine({ repository });
  const notify = notifier || (repository === bookingRepository ? notifySafe : () => {});
  const matching = createMatchingEngine({ repository, notifier: notify, now });

  async function assertVerified(caregiverUserId) {
    const profile = await profileRepository.findProfileByUserId(caregiverUserId);
    if (!profile || profile.verification_status !== 'verified') {
      throw new AppError('NOT_VERIFIED', 'บัญชียังไม่ผ่านการตรวจสอบ จึงยังรับงานไม่ได้', 403);
    }
    return profile;
  }

  // ===== availability (G2) =====

  async function getAvailability(caregiverUserId, fromDate, toDate) {
    return repository.listAvailability(caregiverUserId, fromDate, toDate);
  }

  async function saveAvailability(caregiverUserId, days) {
    for (const day of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
        throw new AppError('DATE_INVALID', 'รูปแบบวันที่ไม่ถูกต้อง', 422);
      }
    }
    return repository.upsertAvailability(
      caregiverUserId,
      days.map((day) => ({
        date: day.date,
        slots: { morning: Boolean(day.slots?.morning), afternoon: Boolean(day.slots?.afternoon) }
      }))
    );
  }

  // ===== offers (G3) =====

  /** Lazy batch progression: every poll advances stale searching bookings. */
  async function listOffers(caregiverUserId) {
    await assertVerified(caregiverUserId);
    const searching = await repository.listSearchingBookings();
    for (const booking of searching) {
      await matching.advanceOffers(booking);
    }
    const offers = await repository.listActiveOffersForCaregiver(caregiverUserId, now().toISOString());
    return offers
      .filter((offer) => offer.booking && offer.booking.status === 'searching')
      .map(offerCard);
  }

  async function acceptJob(caregiverUserId, bookingId) {
    await assertVerified(caregiverUserId);
    const booking = await repository.findBookingById(bookingId);
    if (!booking) {
      throw new AppError('BOOKING_NOT_FOUND', 'ไม่พบงานนี้', 404);
    }
    if (booking.caregiver_user_id === caregiverUserId && booking.status !== 'searching') {
      return jobView(booking); // idempotent: already mine
    }
    if (booking.status !== 'searching') {
      throw new AppError('JOB_TAKEN', 'งานนี้ถูกรับไปแล้ว', 409);
    }
    const offers = await repository.listOffersForBooking(bookingId);
    const mine = offers.find((offer) => offer.caregiver_user_id === caregiverUserId);
    const nowIso = now().toISOString();
    if (!mine || mine.status !== 'offered' || mine.expires_at <= nowIso) {
      throw new AppError('OFFER_EXPIRED', 'ข้อเสนองานนี้หมดอายุแล้ว', 410);
    }

    let result;
    try {
      result = await machine.transition(booking, 'matched', {
        actor: 'caregiver',
        patch: { caregiver_user_id: caregiverUserId, matched_at: nowIso },
        payload: { caregiver_user_id: caregiverUserId }
      });
    } catch (err) {
      if (err.code === 'TRANSITION_CONFLICT') {
        throw new AppError('JOB_TAKEN', 'งานนี้ถูกรับไปแล้ว', 409);
      }
      throw err;
    }
    await repository.setOfferStatus(bookingId, caregiverUserId, 'accepted');
    await repository.markOtherOffersLost(bookingId, caregiverUserId);
    const profile = await profileRepository.findProfileByUserId(caregiverUserId);
    notify({
      userId: booking.customer_user_id,
      bookingId,
      template: 'accepted_customer',
      data: { caregiver_name: profile?.full_name || '', scheduled_date: booking.scheduled_date }
    });
    notify({
      userId: caregiverUserId,
      bookingId,
      template: 'accepted_caregiver',
      data: { scheduled_date: booking.scheduled_date, pickup_time: booking.pickup_time }
    });
    return jobView(result.booking);
  }

  /** Single job with the elder card pinned on the active-job screen (spec G4). */
  async function getJob(caregiverUserId, bookingId) {
    const booking = await repository.findBookingById(bookingId);
    if (!booking || booking.caregiver_user_id !== caregiverUserId) {
      throw new AppError('BOOKING_NOT_FOUND', 'ไม่พบงานนี้', 404);
    }
    const view = jobView(booking);
    const elder = await repository.findElderForJob(booking.elder_profile_id);
    if (elder) {
      view.elder = {
        full_name: elder.full_name,
        nickname: elder.nickname || null,
        mobility: elder.mobility || null,
        chronic_conditions: elder.chronic_conditions || [],
        special_notes: elder.special_notes || null,
        // family emergency phone unlocks once the booking is confirmed
        family_phone: booking.status === 'matched' ? null : elder.family_phone
      };
    }
    return view;
  }

  async function listActiveJobs(caregiverUserId) {
    const rows = await repository.listBookingsByCaregiver(caregiverUserId, ACTIVE_STATUSES);
    return rows.map(jobView);
  }

  async function listHistory(caregiverUserId) {
    const rows = await repository.listBookingsByCaregiver(caregiverUserId, ['completed', 'cancelled', 'disputed']);
    return rows.map(jobView);
  }

  return { getAvailability, saveAvailability, listOffers, acceptJob, getJob, listActiveJobs, listHistory };
}

module.exports = { createJobsService, ACTIVE_STATUSES };
