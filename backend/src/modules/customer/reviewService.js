/**
 * Reviews (spec C7) — customer reviews the caregiver after a completed job.
 * Stars update the caregiver's denormalized rating incrementally.
 */
const bookingRepository = require('../booking/repository');
const { AppError } = require('../shared/appError');

const ALLOWED_TAGS = ['ตรงเวลา', 'ดูแลดี', 'สื่อสารดี', 'สุภาพ', 'รายงานละเอียด'];

function createReviewService({ repository = bookingRepository } = {}) {
  async function createReview(customerUserId, { booking_id: bookingId, stars, comment, tags }) {
    const booking = await repository.findBookingById(bookingId, customerUserId);
    if (!booking) {
      throw new AppError('BOOKING_NOT_FOUND', 'ไม่พบรายการจอง', 404);
    }
    if (booking.status !== 'completed') {
      throw new AppError('REVIEW_NOT_ALLOWED', 'รีวิวได้เมื่องานเสร็จสมบูรณ์แล้ว', 409);
    }
    if (!booking.caregiver_user_id) {
      throw new AppError('REVIEW_NOT_ALLOWED', 'งานนี้ไม่มีผู้ดูแล', 409);
    }
    const starsValue = Number(stars);
    if (!Number.isInteger(starsValue) || starsValue < 1 || starsValue > 5) {
      throw new AppError('STARS_INVALID', 'กรุณาให้คะแนน 1-5 ดาว', 422);
    }
    const review = await repository.insertReview({
      booking_id: bookingId,
      direction: 'customer_to_caregiver',
      reviewer_user_id: customerUserId,
      reviewee_user_id: booking.caregiver_user_id,
      stars: starsValue,
      comment: comment || null,
      tags: (tags || []).filter((tag) => ALLOWED_TAGS.includes(tag))
    });
    await repository.applyReviewToRating(booking.caregiver_user_id, starsValue);
    return { id: review.id, stars: review.stars };
  }

  async function pendingReviews(customerUserId) {
    return repository.listUnreviewedCompletedBookings(customerUserId);
  }

  async function receivedReviews(caregiverUserId) {
    return repository.listReviewsForUser(caregiverUserId);
  }

  return { createReview, pendingReviews, receivedReviews, ALLOWED_TAGS };
}

module.exports = { createReviewService, ALLOWED_TAGS };
