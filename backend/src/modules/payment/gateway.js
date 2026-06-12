/**
 * PaymentGateway interface (DECISIONS.md 2026-06-11) — implementations:
 *   createCharge({amountSatang, method, cardToken?, bookingId}) ->
 *     { chargeId, status: 'successful'|'pending'|'failed', qrImageUrl?, raw? }
 *   refund({chargeId, amountSatang}) -> { refundId, status }
 *
 * Default is MockGateway until CARE_PAYMENT_GATEWAY=omise + keys are set.
 * Omise amounts are already satang — no conversion needed.
 */
const crypto = require('crypto');
const { AppError } = require('../shared/appError');

class MockGateway {
  constructor() {
    this.name = 'mock';
  }

  async createCharge({ amountSatang, method }) {
    // simulate instant success so the dev flow reaches `searching` (M2 DoD)
    return {
      chargeId: `mock_ch_${crypto.randomBytes(8).toString('hex')}`,
      status: 'successful',
      method: method || 'mock',
      amountSatang
    };
  }

  async refund({ chargeId, amountSatang }) {
    return {
      refundId: `mock_rf_${crypto.randomBytes(8).toString('hex')}`,
      status: 'closed',
      chargeId,
      amountSatang
    };
  }
}

class OmiseGateway {
  constructor({ secretKey } = {}) {
    this.name = 'omise';
    this.secretKey = secretKey || process.env.OMISE_SECRET_KEY;
    if (!this.secretKey) {
      throw new AppError('CONFIG_MISSING', 'ระบบชำระเงินยังตั้งค่าไม่ครบ', 500, { env: 'OMISE_SECRET_KEY' });
    }
  }

  async omiseRequest(path, body, method = 'POST') {
    const auth = Buffer.from(`${this.secretKey}:`).toString('base64');
    const response = await fetch(`https://api.omise.co${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || data.object === 'error') {
      throw new AppError('PAYMENT_GATEWAY_ERROR', 'ชำระเงินไม่สำเร็จ กรุณาลองใหม่', 502, {
        gateway_code: data.code
      });
    }
    return data;
  }

  async createCharge({ amountSatang, method, cardToken, bookingId }) {
    let body;
    if (method === 'promptpay') {
      const source = await this.omiseRequest('/sources', {
        type: 'promptpay',
        amount: amountSatang,
        currency: 'THB'
      });
      body = { amount: amountSatang, currency: 'THB', source: source.id, metadata: { booking_id: bookingId } };
    } else if (method === 'card') {
      if (!cardToken) {
        throw new AppError('CARD_TOKEN_REQUIRED', 'ข้อมูลบัตรไม่ถูกต้อง', 422);
      }
      body = { amount: amountSatang, currency: 'THB', card: cardToken, metadata: { booking_id: bookingId } };
    } else {
      throw new AppError('PAYMENT_METHOD_INVALID', 'ช่องทางชำระเงินไม่ถูกต้อง', 422);
    }
    const charge = await this.omiseRequest('/charges', body);
    return {
      chargeId: charge.id,
      status: charge.status === 'successful' ? 'successful' : charge.status === 'failed' ? 'failed' : 'pending',
      qrImageUrl: charge.source?.scannable_code?.image?.download_uri || null,
      method,
      amountSatang
    };
  }

  async refund({ chargeId, amountSatang }) {
    const refund = await this.omiseRequest(`/charges/${chargeId}/refunds`, { amount: amountSatang });
    return { refundId: refund.id, status: refund.status || 'closed', chargeId, amountSatang };
  }

  /** Webhook hardening: never trust the webhook payload — re-fetch the charge. */
  async retrieveChargeStatus(chargeId) {
    const charge = await this.omiseRequest(`/charges/${chargeId}`, null, 'GET');
    return charge.status === 'successful' ? 'successful' : charge.status === 'failed' ? 'failed' : 'pending';
  }
}

let activeGateway = null;

function getPaymentGateway() {
  if (!activeGateway) {
    activeGateway =
      process.env.CARE_PAYMENT_GATEWAY === 'omise' ? new OmiseGateway() : new MockGateway();
  }
  return activeGateway;
}

/** test hook */
function setPaymentGateway(gateway) {
  activeGateway = gateway;
}

module.exports = { MockGateway, OmiseGateway, getPaymentGateway, setPaymentGateway };
