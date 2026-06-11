/** Customer portal endpoints (spec 4.2) — mounted at /api/v1/customer. */
const express = require('express');
const { z } = require('zod');
const { requireCareUser } = require('../shared/careAuth');
const { createElderService } = require('./service');

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

function createCustomerRouter(service = createElderService()) {
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

  return router;
}

module.exports = { createCustomerRouter };
