/** Caregiver portal endpoints (spec 5.4) — mounted at /api/v1/caregiver. */
const express = require('express');
const { z } = require('zod');
const { requireCareUser } = require('../shared/careAuth');
const { createOnboardingService } = require('./service');

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

function createCaregiverRouter(service = createOnboardingService()) {
  const router = express.Router();
  router.use(requireCareUser(['caregiver']));

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
