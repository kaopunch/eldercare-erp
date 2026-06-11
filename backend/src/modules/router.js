/**
 * อุ่นใจ Care Platform — /api/v1 root router.
 * Mounted in server.js BEFORE the ERP's attachActor middleware so care portal
 * requests never hit staff auth. Has its own rate limits and error handler
 * (CLAUDE.md: errors are JSON {code, message} with Thai message).
 */
const express = require('express');
const { createRateLimiter } = require('../middleware/security');
const { createAuthRouter } = require('./auth/router');
const { createCustomerRouter } = require('./customer/router');
const { createCaregiverRouter } = require('./caregiver/router');

function createCareApiRouter() {
  const router = express.Router();

  const authRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.CARE_AUTH_RATE_LIMIT_MAX || 30),
    keyPrefix: 'care-auth',
    message: 'Too many authentication requests'
  });
  const apiRateLimit = createRateLimiter({
    max: Number(process.env.CARE_API_RATE_LIMIT_MAX || 600),
    keyPrefix: 'care-api',
    message: 'Too many API requests'
  });

  router.use('/customer/auth', authRateLimit, createAuthRouter('customer'));
  router.use('/caregiver/auth', authRateLimit, createAuthRouter('caregiver'));
  router.use('/customer', apiRateLimit, createCustomerRouter());
  router.use('/caregiver', apiRateLimit, createCaregiverRouter());

  // central error handler for /api/v1 — AppError + zod + fallback
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.name === 'ZodError') {
      return res.status(422).json({
        code: 'VALIDATION_ERROR',
        message: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบและลองใหม่',
        details: err.issues?.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }
    const status = err.statusCode || 500;
    if (status >= 500) {
      console.error('[care-api]', err.code || err.name, err.message);
    }
    return res.status(status).json({
      code: err.code || 'INTERNAL_ERROR',
      message: status >= 500 && !err.code ? 'เกิดข้อผิดพลาดภายในระบบ' : err.message,
      details: err.details
    });
  });

  return router;
}

module.exports = { createCareApiRouter };
