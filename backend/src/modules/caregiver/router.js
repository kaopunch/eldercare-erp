/** Caregiver portal endpoints (spec 5.4) — mounted at /api/v1/caregiver. */
const express = require('express');
const { z } = require('zod');
const { requireCareUser } = require('../shared/careAuth');
const { createOnboardingService } = require('./service');
const { createJobsService } = require('./jobsService');
const { createActiveJobService } = require('./activeJobService');

const locationSchema = z.object({ lat: z.number(), lng: z.number() });

const photoSchema = z.object({
  content_type: z.string().max(100).optional(),
  data_base64: z.string().min(1)
});

const checkinSchema = z.object({ photo: photoSchema, location: locationSchema });

const stepSchema = z.object({ location: locationSchema.nullable().optional() });

const healthRecordSchema = z.object({
  vital_signs: z
    .object({ bp: z.string().max(20).optional(), pulse: z.string().max(20).optional(), temp: z.string().max(20).optional() })
    .optional(),
  doctor_summary: z.string().max(5000).nullable().optional(),
  medications_received: z
    .array(z.object({ name: z.string().min(1).max(300), note: z.string().max(500).optional(), photo: photoSchema.optional() }))
    .max(50)
    .optional(),
  next_appointment: z
    .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), department: z.string().max(200).optional(), note: z.string().max(500).optional() })
    .nullable()
    .optional(),
  attachments: z.array(photoSchema).max(10).optional()
});

const pingSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  accuracy_m: z.number().nullable().optional()
});

const sosSchema = z.object({
  location: locationSchema.nullable().optional(),
  note: z.string().max(1000).optional()
});

const availabilitySchema = z.object({
  days: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        slots: z.object({ morning: z.boolean(), afternoon: z.boolean() })
      })
    )
    .min(1)
    .max(120)
});

const profileSchema = z.object({
  full_name: z.string().min(1).max(200),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  id_card_number: z.string().min(13).max(20).optional(),
  background: z.enum(['nurse_retired', 'nurse_assistant', 'health_student', 'trained_general']).nullable().optional(),
  languages: z.array(z.enum(['th', 'en'])).max(2).optional(),
  service_area: z
    .object({ lat: z.number(), lng: z.number(), radius_km: z.number() })
    .nullable()
    .optional(),
  base_rate_half_day_baht: z.number().optional(),
  base_rate_full_day_baht: z.number().optional()
});

const documentSchema = z.object({
  type: z.enum(['id_card', 'certificate', 'photo']),
  file_name: z.string().max(300).optional(),
  content_type: z.string().max(100),
  data_base64: z.string().min(1)
});

function createCaregiverRouter(
  service = createOnboardingService(),
  jobsService = createJobsService(),
  activeJobService = createActiveJobService()
) {
  const router = express.Router();
  router.use(requireCareUser(['caregiver']));

  // ===== active job steps (G4) =====

  router.post('/jobs/:id/checkin', async (req, res, next) => {
    try {
      const body = checkinSchema.parse(req.body || {});
      res.json(await activeJobService.checkin(req.careUser.id, req.params.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/arrive', async (req, res, next) => {
    try {
      const body = stepSchema.parse(req.body || {});
      res.json(await activeJobService.arrive(req.careUser.id, req.params.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/health-record', async (req, res, next) => {
    try {
      const body = healthRecordSchema.parse(req.body || {});
      res.status(201).json(await activeJobService.saveHealthRecord(req.careUser.id, req.params.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/departing', async (req, res, next) => {
    try {
      const body = stepSchema.parse(req.body || {});
      res.json(await activeJobService.departing(req.careUser.id, req.params.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/checkout', async (req, res, next) => {
    try {
      const body = stepSchema.parse(req.body || {});
      res.json(await activeJobService.checkout(req.careUser.id, req.params.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/sos', async (req, res, next) => {
    try {
      const body = sosSchema.parse(req.body || {});
      res.json(await activeJobService.sos(req.careUser.id, req.params.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/location', async (req, res, next) => {
    try {
      const body = pingSchema.parse(req.body || {});
      res.json(await activeJobService.ping(req.careUser.id, req.params.id, body));
    } catch (err) {
      next(err);
    }
  });

  // ===== availability (G2) =====

  router.get('/availability', async (req, res, next) => {
    try {
      const from = String(req.query.from || new Date().toISOString().slice(0, 10));
      const to = String(
        req.query.to || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      );
      res.json(await jobsService.getAvailability(req.careUser.id, from, to));
    } catch (err) {
      next(err);
    }
  });

  router.put('/availability', async (req, res, next) => {
    try {
      const body = availabilitySchema.parse(req.body || {});
      res.json(await jobsService.saveAvailability(req.careUser.id, body.days));
    } catch (err) {
      next(err);
    }
  });

  // ===== jobs (G3) =====

  router.get('/jobs/offers', async (req, res, next) => {
    try {
      res.json(await jobsService.listOffers(req.careUser.id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/accept', async (req, res, next) => {
    try {
      res.json(await jobsService.acceptJob(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/active', async (req, res, next) => {
    try {
      res.json(await jobsService.listActiveJobs(req.careUser.id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/history', async (req, res, next) => {
    try {
      res.json(await jobsService.listHistory(req.careUser.id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/:id', async (req, res, next) => {
    try {
      res.json(await jobsService.getJob(req.careUser.id, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/onboard/profile', async (req, res, next) => {
    try {
      const body = profileSchema.parse(req.body || {});
      res.json(await service.saveProfile(req.careUser.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/onboard/documents', async (req, res, next) => {
    try {
      const body = documentSchema.parse(req.body || {});
      res.status(201).json(await service.uploadDocument(req.careUser.id, body));
    } catch (err) {
      next(err);
    }
  });

  router.get('/onboard/status', async (req, res, next) => {
    try {
      res.json(await service.getStatus(req.careUser.id));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createCaregiverRouter };
