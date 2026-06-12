/** Customer portal endpoints (spec 4.2) — mounted at /api/v1/customer. */
const express = require('express');
const { z } = require('zod');
const { requireCareUser } = require('../shared/careAuth');
const { createElderService } = require('./service');
const { createBookingService } = require('../booking/service');
const { createReviewService } = require('./reviewService');
const { createLinkCode } = require('../notification/lineLink');

const locationSchema = z.object({ lat: z.number(), lng: z.number() }).nullable();

const medicationSchema = z.object({
  name: z.string().min(1),
  dose: z.string().optional().default(''),
  schedule: z.string().optional().default('')
});

const elderBaseSchema = z.object({
  full_name: z.string().min(1).max(200),
  nickname: z.string().max(100).nullable().optional(),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  blood_type: z.string().max(5).nullable().optional(),
  weight_kg: z.number().positive().max(300).nullable().optional(),
  height_cm: z.number().positive().max(250).nullable().optional(),
  chronic_conditions: z.array(z.string().max(200)).max(50).optional(),
  medications: z.array(medicationSchema).max(100).optional(),
  allergies: z.array(z.string().max(200)).max(50).optional(),
  mobility: z.enum(['walk', 'cane', 'walker', 'wheelchair', 'bedridden']).nullable().optional(),
  primary_hospital: z.string().max(300).nullable().optional(),
  home_address: z.string().max(1000).nullable().optional(),
  home_location: locationSchema.optional(),
  special_notes: z.string().max(2000).nullable().optional(),
  photo_url: z.string().max(1000).nullable().optional()
});

const elderCreateSchema = elderBaseSchema.extend({
  consent_accepted: z.boolean()
});

const elderUpdateSchema = elderBaseSchema.partial();

const pointSchema = z.object({ lat: z.number(), lng: z.number() });

const specialRequirementsSchema = z
  .object({
    wheelchair: z.boolean().optional(),
    english: z.boolean().optional(),
    caregiver_gender: z.enum(['male', 'female']).nullable().optional()
  })
  .optional();

const quoteSchema = z.object({
  service_type: z.enum(['hospital_visit', 'errand', 'companion']),
  duration_type: z.enum(['half_day', 'full_day']),
  pickup: pointSchema,
  destination: pointSchema,
  special_requirements: specialRequirementsSchema
});

const bookingCreateSchema = z.object({
  elder_profile_id: z.string().uuid(),
  service_type: z.enum(['hospital_visit', 'errand', 'companion']),
  duration_type: z.enum(['half_day', 'full_day']),
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pickup_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  pickup_address: z.string().max(1000).nullable().optional(),
  pickup_location: pointSchema.nullable().optional(),
  destination_name: z.string().min(1).max(300),
  destination_address: z.string().max(1000).nullable().optional(),
  destination_location: pointSchema,
  appointment_detail: z.string().max(2000).nullable().optional(),
  special_requirements: specialRequirementsSchema
});

const paySchema = z.object({
  method: z.enum(['promptpay', 'card', 'mock']).default('promptpay'),
  card_token: z.string().optional()
});

const cancelSchema = z.object({ reason: z.string().max(500).optional() });

const reviewSchema = z.object({
  booking_id: z.string().uuid(),
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(50)).max(10).optional()
});

function createCustomerRouter(
  service = createElderService(),
  bookingService = createBookingService(),
  reviewService = createReviewService()
) {
  const router = express.Router();
  router.use(requireCareUser(['customer']));

  router.get('/elders', async (req, res, next) => {
    try {
      res.json(await service.listElders(req.careUser.id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/elders', async (req, res, next) => {
    try {
      const body = elderCreateSchema.parse(req.body || {});
      res.status(201).json(await service.createElder(req.careUser.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.get('/elders/:id', async (req, res, next) => {
    try {
      res.json(await service.getElder(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/elders/:id', async (req, res, next) => {
    try {
      const body = elderUpdateSchema.parse(req.body || {});
      res.json(await service.updateElder(req.careUser.id, req.params.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/elders/:id', async (req, res, next) => {
    try {
      res.json(await service.deleteElder(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // ===== bookings (spec 4.2) =====

  router.post('/bookings/quote', async (req, res, next) => {
    try {
      const body = quoteSchema.parse(req.body || {});
      res.json(await bookingService.quote(body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/bookings', async (req, res, next) => {
    try {
      const body = bookingCreateSchema.parse(req.body || {});
      res.status(201).json(await bookingService.createBooking(req.careUser.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.get('/bookings', async (req, res, next) => {
    try {
      const scope = ['upcoming', 'past'].includes(req.query.scope) ? req.query.scope : null;
      res.json(await bookingService.listBookings(req.careUser.id, scope));
    } catch (err) {
      next(err);
    }
  });

  router.get('/bookings/:id', async (req, res, next) => {
    try {
      res.json(await bookingService.getBooking(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/bookings/:id/pay', async (req, res, next) => {
    try {
      const body = paySchema.parse(req.body || {});
      res.json(await bookingService.pay(req.careUser.id, req.params.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/bookings/:id/confirm', async (req, res, next) => {
    try {
      res.json(await bookingService.confirmCaregiver(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/bookings/:id/cancel-preview', async (req, res, next) => {
    try {
      res.json(await bookingService.cancelPreview(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/bookings/:id/cancel', async (req, res, next) => {
    try {
      const body = cancelSchema.parse(req.body || {});
      res.json(await bookingService.cancel(req.careUser.id, req.params.id, body.reason));
    } catch (err) {
      next(err);
    }
  });

  router.get('/bookings/:id/events', async (req, res, next) => {
    try {
      res.json(await bookingService.listEvents(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/bookings/:id/confirm-complete', async (req, res, next) => {
    try {
      res.json(await bookingService.confirmComplete(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/bookings/:id/track', async (req, res, next) => {
    try {
      res.json(await bookingService.getTrackSnapshot(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // ===== health profile (C6) =====

  router.get('/elders/:id/health-records', async (req, res, next) => {
    try {
      res.json(await service.getHealthRecords(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // ===== reviews (C7) =====

  router.get('/reviews/pending', async (req, res, next) => {
    try {
      res.json(await reviewService.pendingReviews(req.careUser.id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/reviews', async (req, res, next) => {
    try {
      const body = reviewSchema.parse(req.body || {});
      res.status(201).json(await reviewService.createReview(req.careUser.id, body));
    } catch (err) {
      next(err);
    }
  });

  // ===== LINE link (C1) =====

  router.post('/line/link-code', async (req, res, next) => {
    try {
      res.json(await createLinkCode(req.careUser.id));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createCustomerRouter };
