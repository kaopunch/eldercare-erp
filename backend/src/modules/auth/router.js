/**
 * Auth endpoints, mounted twice: /api/v1/customer/auth and /api/v1/caregiver/auth.
 * The portal role is fixed by mount point — createAuthRouter('customer'|'caregiver').
 */
const express = require('express');
const { z } = require('zod');
const { createAuthService } = require('./service');

const phoneSchema = z.string().min(9).max(20);

const registerSchema = z.object({ phone: phoneSchema });

const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/),
  password: z.string().min(1).max(200),
  email: z.string().email().optional()
});

const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1).max(200)
});

const otpLoginSchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/)
});

const refreshSchema = z.object({ refresh_token: z.string().min(10) });

function createAuthRouter(role, service = createAuthService()) {
  const router = express.Router();

  router.post('/register', async (req, res, next) => {
    try {
      const body = registerSchema.parse(req.body || {});
      res.status(201).json(await service.register({ phone: body.phone, role }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/otp/request', async (req, res, next) => {
    try {
      const body = registerSchema.parse(req.body || {});
      res.json(await service.requestOtp({ phone: body.phone, purpose: 'login', role }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/otp/verify', async (req, res, next) => {
    try {
      const body = otpVerifySchema.parse(req.body || {});
      res.status(201).json(await service.verifyOtpAndRegister({ ...body, role }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = loginSchema.parse(req.body || {});
      res.json(await service.login({ ...body, role }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/login/otp', async (req, res, next) => {
    try {
      const body = otpLoginSchema.parse(req.body || {});
      res.json(await service.loginWithOtp({ ...body, role }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/refresh', async (req, res, next) => {
    try {
      const body = refreshSchema.parse(req.body || {});
      res.json(await service.refresh({ refreshToken: body.refresh_token }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const body = refreshSchema.parse(req.body || {});
      res.json(await service.logout({ refreshToken: body.refresh_token }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAuthRouter };
