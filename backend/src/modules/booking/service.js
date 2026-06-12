/**
 * Booking business logic (spec C3/C5 + section 3).
 * Flow: quote -> create (draft -> pending_payment, expires 30 min)
 *       -> pay (escrow held) -> searching -> ... (M3 matching takes over)
 * Cancel allowed pending_payment..confirmed with config-driven refund tiers.
 * All status changes go through BookingStateMachine only.
 */
const defaultRepository = require('./repository');
const { calculateQuote } = require('./pricing');
const { calculateCancellation } = require('./cancellation');
const { createBookingStateMachine, CANCELLABLE } = require('./stateMachine');
const { getPaymentGateway } = require('../payment/gateway');
const { AppError } = require('../shared/appError');

const PAYMENT_WINDOW_MINUTES = 30;
const MAX_ADVANCE_DAYS = 30;

function toWktPoint(location) {
  if (!location) return null;
  return `SRID=4326;POINT(${Number(location.lng)} ${Number(location.lat)})`;
}

/** scheduled_date + pickup_time are Thai local (Asia/Bangkok, UTC+7, no DST). */
function pickupDateTime(booking) {
  return new Date(`${booking.scheduled_date}T${booking.pickup_time}+07:00`);
}

function hoursUntilPickup(booking, now = new Date()) {
  return (pickupDateTime(booking).getTime() - now.getTime()) / (60 * 60 * 1000);
}

function publicBooking(row) {
  return {
    id: row.id,
    elder_profile_id: row.elder_profile_id,
    caregiver_user_id: row.caregiver_user_id || null,
    service_type: row.service_type,
    duration_type: row.duration_type,
    scheduled_date: row.scheduled_date,
    pickup_time: row.pickup_time,
    pickup_address: row.pickup_address,
    pickup_location:
      row.pickup_lat === null || row.pickup_lat === undefined
        ? null
        : { lat: Number(row.pickup_lat), lng: Number(row.pickup_lng) },
    destination_name: row.destination_name,
    destination_address: row.destination_address,
    destination_location:
      row.destination_lat === null || row.destination_lat === undefined
        ? null
        : { lat: Number(row.destination_lat), lng: Number(row.destination_lng) },
    appointment_detail: row.appointment_detail,
    special_requirements: row.special_requirements || {},
    distance_km: row.distance_km === null ? null : Number(row.distance_km),
    price_total_satang: row.price_total,
    platform_fee_satang: row.platform_fee,
    insurance_fee_satang: row.insurance_fee,
    status: row.status,
    payment_expires_at: row.payment_expires_at,
    cancelled_by: row.cancelled_by,
    cancel_reason: row.cancel_reason,
    cancelled_at: row.cancelled_at,
    refund_pct: row.refund_pct === null ? null : Number(row.refund_pct),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function createBookingService({ repository = defaultRepository, gateway = null, now = () => new Date() } = {}) {
  const machine = createBookingStateMachine({ repository });
  const paymentGateway = () => gateway || getPaymentGateway();

  async function quote(input) {
    const rule = await repository.findPricingRule(input.service_type, input.duration_type);
    return calculateQuote(rule, input);
  }

  async function createBooking(customerUserId, input) {
    const elder = await repository.findElderForCustomer(input.elder_profile_id, customerUserId);
    if (!elder) {
      throw new AppError('ELDER_NOT_FOUND', 'ไม่พบโปรไฟล์ผู้สูงวัย', 404);
    }
    if (elder.mobility === 'bedridden') {
      // spec: bedridden is outside service scope
      throw new AppError('MOBILITY_NOT_SUPPORTED', 'ขออภัย บริการนี้ยังไม่รองรับผู้ป่วยติดเตียง', 422);
    }

    // pickup defaults to the elder's home pin (spec C2)
    const pickup =
      input.pickup_location ||
      (elder.home_lat !== null && elder.home_lat !== undefined
        ? { lat: Number(elder.home_lat), lng: Number(elder.home_lng) }
        : null);
    if (!pickup) {
      throw new AppError('PICKUP_REQUIRED', 'กรุณาปักหมุดจุดรับ หรือเพิ่มพิกัดบ้านในโปรไฟล์ผู้สูงวัย', 422);
    }
    if (!input.destination_location) {
      throw new AppError('DESTINATION_REQUIRED', 'กรุณาระบุพิกัดจุดหมาย', 422);
    }

    const pickupAt = new Date(`${input.scheduled_date}T${input.pickup_time}+07:00`);
    if (Number.isNaN(pickupAt.getTime())) {
      throw new AppError('SCHEDULE_INVALID', 'วันเวลานัดไม่ถูกต้อง', 422);
    }
    const hoursAhead = (pickupAt.getTime() - now().getTime()) / (60 * 60 * 1000);
    if (hoursAhead <= 0) {
      throw new AppError('SCHEDULE_PAST', 'วันเวลานัดต้องอยู่ในอนาคต', 422);
    }
    if (hoursAhead > MAX_ADVANCE_DAYS * 24) {
      throw new AppError('SCHEDULE_TOO_FAR', `จองล่วงหน้าได้สูงสุด ${MAX_ADVANCE_DAYS} วัน`, 422);
    }

    const rule = await repository.findPricingRule(input.service_type, input.duration_type);
    const quoted = calculateQuote(rule, {
      pickup,
      destination: input.destination_location,
      special_requirements: input.special_requirements
    });

    const draft = await repository.insertBooking({
      customer_user_id: customerUserId,
      elder_profile_id: input.elder_profile_id,
      service_type: input.service_type,
      duration_type: input.duration_type,
      scheduled_date: input.scheduled_date,
      pickup_time: input.pickup_time,
      pickup_address: input.pickup_address || elder.home_address || null,
      pickup_location: toWktPoint(pickup),
      pickup_lat: pickup.lat,
      pickup_lng: pickup.lng,
      destination_name: input.destination_name,
      destination_address: input.destination_address || null,
      destination_location: toWktPoint(input.destination_location),
      destination_lat: input.destination_location.lat,
      destination_lng: input.destination_location.lng,
      appointment_detail: input.appointment_detail || null,
      special_requirements: input.special_requirements || {},
      price_total: quoted.price_total_satang,
      platform_fee: quoted.platform_fee_satang,
      caregiver_payout: quoted.caregiver_payout_satang,
      insurance_fee: quoted.insurance_fee_satang,
      distance_km: quoted.distance_km,
      status: 'draft'
    });

    const { booking } = await machine.transition(draft, 'pending_payment', {
      actor: 'system',
      patch: {
        payment_expires_at: new Date(now().getTime() + PAYMENT_WINDOW_MINUTES * 60 * 1000).toISOString()
      },
      payload: { price_total_satang: quoted.price_total_satang }
    });
    return { booking: publicBooking(booking), quote: quoted };
  }

  /** Lazy expiry: pending_payment past its window flips to cancelled on read. */
  async function expireIfNeeded(booking) {
    if (
      booking.status === 'pending_payment' &&
      booking.payment_expires_at &&
      new Date(booking.payment_expires_at).getTime() < now().getTime()
    ) {
      try {
        const { booking: expired } = await machine.transition(booking, 'cancelled', {
          actor: 'system',
          eventType: 'cancelled',
          patch: {
            cancelled_by: 'system',
            cancel_reason: 'payment_expired',
            cancelled_at: now().toISOString(),
            refund_pct: null
          },
          payload: { reason: 'payment_expired' }
        });
        return expired;
      } catch (err) {
        if (err.code === 'TRANSITION_CONFLICT') return repository.findBookingById(booking.id);
        throw err;
      }
    }
    return booking;
  }

  async function getBooking(customerUserId, bookingId) {
    let booking = await repository.findBookingById(bookingId, customerUserId);
    if (!booking) {
      throw new AppError('BOOKING_NOT_FOUND', 'ไม่พบรายการจอง', 404);
    }
    booking = await expireIfNeeded(booking);
    return publicBooking(booking);
  }

  async function listBookings(customerUserId, scope) {
    const rows = await repository.listBookingsByCustomer(customerUserId);
    const result = [];
    for (const row of rows) {
      result.push(publicBooking(await expireIfNeeded(row)));
    }
    if (scope === 'upcoming') {
      return result.filter((booking) =>
        ['pending_payment', 'searching', 'matched', 'confirmed', 'in_progress_pickup', 'at_destination', 'returning', 'pending_confirmation'].includes(booking.status)
      );
    }
    if (scope === 'past') {
      return result.filter((booking) => ['completed', 'cancelled', 'disputed'].includes(booking.status));
    }
    return result;
  }

  async function pay(customerUserId, bookingId, { method, card_token: cardToken }) {
    let booking = await repository.findBookingById(bookingId, customerUserId);
    if (!booking) {
      throw new AppError('BOOKING_NOT_FOUND', 'ไม่พบรายการจอง', 404);
    }
    booking = await expireIfNeeded(booking);
    if (booking.status === 'searching') {
      // idempotent: already paid
      const existing = await repository.findPaymentByBooking(bookingId);
      return { booking: publicBooking(booking), payment_status: existing?.status || 'held_escrow' };
    }
    if (booking.status !== 'pending_payment') {
      throw new AppError('PAYMENT_NOT_ALLOWED', 'รายการนี้ไม่อยู่ในสถานะรอชำระเงิน', 409);
    }

    const gw = paymentGateway();
    const charge = await gw.createCharge({
      amountSatang: booking.price_total,
      method,
      cardToken,
      bookingId: booking.id
    });

    const payment = await repository.insertPayment({
      booking_id: booking.id,
      amount: booking.price_total,
      method: gw.name === 'mock' ? 'mock' : method,
      gateway: gw.name,
      gateway_charge_id: charge.chargeId,
      status: charge.status === 'successful' ? 'held_escrow' : charge.status === 'failed' ? 'failed' : 'pending',
      paid_at: charge.status === 'successful' ? now().toISOString() : null
    });

    if (charge.status === 'failed') {
      throw new AppError('PAYMENT_FAILED', 'ชำระเงินไม่สำเร็จ กรุณาลองใหม่', 402);
    }

    if (charge.status === 'successful') {
      const { booking: updated } = await machine.transition(booking, 'searching', {
        actor: 'system',
        eventType: 'paid',
        payload: { payment_id: payment.id, amount_satang: booking.price_total }
      });
      return { booking: publicBooking(updated), payment_status: 'held_escrow' };
    }

    // pending (e.g. PromptPay QR) — webhook will complete the transition
    return {
      booking: publicBooking(booking),
      payment_status: 'pending',
      qr_image_url: charge.qrImageUrl || null
    };
  }

  /** Omise webhook: charge.complete — idempotent on repeated delivery. */
  async function handleChargeComplete(chargeId, chargeStatus) {
    const payment = await repository.findPaymentByChargeId(chargeId);
    if (!payment) return { handled: false };
    if (payment.status === 'held_escrow') return { handled: true }; // duplicate delivery
    if (chargeStatus !== 'successful') {
      await repository.updatePayment(payment.id, { status: 'failed' });
      return { handled: true };
    }
    await repository.updatePayment(payment.id, {
      status: 'held_escrow',
      paid_at: now().toISOString()
    });
    const booking = await repository.findBookingById(payment.booking_id);
    if (booking && booking.status === 'pending_payment') {
      await machine.transition(booking, 'searching', {
        actor: 'system',
        eventType: 'paid',
        payload: { payment_id: payment.id, via: 'webhook' }
      });
    }
    return { handled: true };
  }

  async function cancelPreview(customerUserId, bookingId) {
    const booking = await repository.findBookingById(bookingId, customerUserId);
    if (!booking) {
      throw new AppError('BOOKING_NOT_FOUND', 'ไม่พบรายการจอง', 404);
    }
    const rules = await repository.listCancellationRules();
    const paid = booking.status !== 'pending_payment' && booking.status !== 'draft';
    const result = calculateCancellation({
      rules,
      cancelledBy: 'customer',
      hoursBefore: hoursUntilPickup(booking, now()),
      priceTotalSatang: booking.price_total || 0,
      caregiverPayoutSatang: booking.caregiver_payout || 0
    });
    return {
      cancellable: CANCELLABLE.includes(booking.status),
      paid,
      ...result
    };
  }

  async function cancel(customerUserId, bookingId, reason) {
    let booking = await repository.findBookingById(bookingId, customerUserId);
    if (!booking) {
      throw new AppError('BOOKING_NOT_FOUND', 'ไม่พบรายการจอง', 404);
    }
    booking = await expireIfNeeded(booking);
    if (booking.status === 'cancelled') {
      return { booking: publicBooking(booking), refund_satang: null }; // idempotent
    }
    if (!CANCELLABLE.includes(booking.status)) {
      throw new AppError('CANCEL_NOT_ALLOWED', 'รายการนี้ยกเลิกไม่ได้แล้ว', 409);
    }

    const paid = booking.status !== 'pending_payment';
    let refund = { refund_pct: 100, refund_satang: 0, caregiver_comp_pct: 0, caregiver_comp_satang: 0 };
    if (paid) {
      const rules = await repository.listCancellationRules();
      refund = calculateCancellation({
        rules,
        cancelledBy: 'customer',
        hoursBefore: hoursUntilPickup(booking, now()),
        priceTotalSatang: booking.price_total || 0,
        caregiverPayoutSatang: booking.caregiver_payout || 0
      });
      const payment = await repository.findPaymentByBooking(bookingId);
      if (payment && payment.status === 'held_escrow' && refund.refund_satang > 0) {
        const gw = paymentGateway();
        await gw.refund({ chargeId: payment.gateway_charge_id, amountSatang: refund.refund_satang });
        await repository.updatePayment(payment.id, {
          status: 'refunded',
          refund_amount: refund.refund_satang,
          refunded_at: now().toISOString()
        });
      }
    }

    const { booking: cancelled } = await machine.transition(booking, 'cancelled', {
      actor: 'customer',
      eventType: 'cancelled',
      patch: {
        cancelled_by: 'customer',
        cancel_reason: reason || null,
        cancelled_at: now().toISOString(),
        refund_pct: paid ? refund.refund_pct : null
      },
      payload: {
        reason: reason || null,
        refund_pct: paid ? refund.refund_pct : null,
        refund_satang: paid ? refund.refund_satang : null
      }
    });
    return { booking: publicBooking(cancelled), refund_satang: paid ? refund.refund_satang : null };
  }

  async function listEvents(customerUserId, bookingId) {
    const booking = await repository.findBookingById(bookingId, customerUserId);
    if (!booking) {
      throw new AppError('BOOKING_NOT_FOUND', 'ไม่พบรายการจอง', 404);
    }
    return repository.listBookingEvents(bookingId);
  }

  return {
    quote,
    createBooking,
    getBooking,
    listBookings,
    pay,
    handleChargeComplete,
    cancel,
    cancelPreview,
    listEvents,
    publicBooking,
    hoursUntilPickup
  };
}

module.exports = { createBookingService };
