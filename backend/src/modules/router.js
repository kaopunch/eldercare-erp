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

  // LINE webhook — link codes (set this URL in LINE Developers Console).
  // When LINE_CHANNEL_SECRET is set, X-Line-Signature (HMAC-SHA256 of the raw
  // body) is enforced; without it (dev/mock) the check is skipped.
  const crypto = require('crypto');
  const { processWebhookEvents } = require('./notification/lineLink');
  router.post('/line/webhook', apiRateLimit, async (req, res, next) => {
    try {
      const secret = process.env.LINE_CHANNEL_SECRET;
      if (secret) {
        const signature = String(req.headers['x-line-signature'] || '');
        const expected = crypto
          .createHmac('sha256', secret)
          .update(req.rawBody || Buffer.alloc(0))
          .digest('base64');
        const a = Buffer.from(signature);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          return res.status(401).json({ code: 'SIGNATURE_INVALID', message: 'invalid signature' });
        }
      }
      const result = await processWebhookEvents(req.body?.events || []);
      res.json({ received: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // Omise webhook (charge.complete) — Omise has no signing secret, so the
  // payload is never trusted: when the omise gateway is active, the charge
  // status is re-fetched from the Omise API before any transition.
  const { createBookingService } = require('./booking/service');
  const { getPaymentGateway } = require('./payment/gateway');
  const webhookBookingService = createBookingService();
  router.post('/payments/webhook/omise', apiRateLimit, async (req, res, next) => {
    try {
      const event = req.body || {};
      if (event.key === 'charge.complete' && event.data?.id) {
        const gateway = getPaymentGateway();
        const status =
          gateway.name === 'omise' && gateway.retrieveChargeStatus
            ? await gateway.retrieveChargeStatus(event.data.id)
            : event.data.status; // mock/dev path
        await webhookBookingService.handleChargeComplete(event.data.id, status);
      }
      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  });

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
