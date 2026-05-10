const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeInboundMessages,
  normalizeLineWebhook,
  normalizeTwilioWebhook,
  normalizeWhatsAppWebhook,
  verifyWebhookSecret
} = require('../src/lib/aiChannels');
const { normalizeAiAnalysis } = require('../src/lib/aiAnalysisProvider');

test('normalizes LINE text webhooks into AI inbound messages', () => {
  const messages = normalizeLineWebhook({
    events: [{
      type: 'message',
      replyToken: 'reply-1',
      webhookEventId: 'line-event-1',
      source: { type: 'user', userId: 'line-user-1' },
      message: { id: 'msg-1', type: 'text', text: 'ขอเลื่อนเวลารับคุณพ่อเป็น 14:30' }
    }]
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].source_channel, 'line');
  assert.equal(messages[0].caller_line_id, 'line-user-1');
  assert.equal(messages[0].transcript, 'ขอเลื่อนเวลารับคุณพ่อเป็น 14:30');
  assert.equal(messages[0].payload.provider, 'line');
});

test('normalizes WhatsApp Cloud API message webhooks', () => {
  const messages = normalizeWhatsAppWebhook({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'phone-number-1' },
          contacts: [{ wa_id: '66810000000', profile: { name: 'Khun Orn' } }],
          messages: [{ id: 'wa-1', from: '66810000000', type: 'text', text: { body: 'คนขับมาถึงหรือยัง' } }]
        }
      }]
    }]
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].source_channel, 'whatsapp');
  assert.equal(messages[0].caller_name, 'Khun Orn');
  assert.equal(messages[0].caller_phone, '66810000000');
  assert.equal(messages[0].payload.whatsapp_phone_number_id, 'phone-number-1');
});

test('normalizes Twilio voice and SMS payloads', () => {
  const voice = normalizeTwilioWebhook({
    CallSid: 'call-1',
    From: '+66810000000',
    SpeechResult: 'ผู้สูงวัยหกล้ม ต้องการความช่วยเหลือด่วน',
    Confidence: '0.92'
  }, 'twilio');
  const sms = normalizeInboundMessages('sms', {
    SmsMessageSid: 'sms-1',
    From: '+66810000001',
    Body: 'ยืนยันรับทราบ ETA แล้ว'
  });
  const twilioSms = normalizeInboundMessages('twilio', {
    SmsMessageSid: 'sms-2',
    From: '+66810000002',
    Body: 'รับทราบ'
  });

  assert.equal(voice[0].source_channel, 'phone');
  assert.equal(voice[0].payload.twilio_call_sid, 'call-1');
  assert.equal(sms[0].source_channel, 'sms');
  assert.equal(sms[0].payload.twilio_message_sid, 'sms-1');
  assert.equal(twilioSms[0].source_channel, 'sms');
});

test('verifies webhook shared secret with production guard', () => {
  assert.deepEqual(verifyWebhookSecret({
    headerSecret: 'secret',
    env: { ELDERCARE_AI_WEBHOOK_SECRET: 'secret', NODE_ENV: 'production' }
  }), { ok: true, configured: true, reason: 'matched' });

  assert.equal(verifyWebhookSecret({
    headerSecret: 'bad',
    env: { ELDERCARE_AI_WEBHOOK_SECRET: 'secret', NODE_ENV: 'production' }
  }).ok, false);

  assert.deepEqual(verifyWebhookSecret({
    env: { NODE_ENV: 'development' }
  }), { ok: true, configured: false, reason: 'development_open' });

  assert.equal(verifyWebhookSecret({
    env: { NODE_ENV: 'production' }
  }).reason, 'missing_secret');
});

test('normalizes external AI analysis while preserving safety review', () => {
  const result = normalizeAiAnalysis({
    intent: 'status_check',
    confidence: 0.99,
    risk_level: 'critical',
    requires_human_review: false,
    reasons: ['provider_detected_medical_risk']
  }, {
    transcript: 'ผู้สูงวัยหายใจไม่ออก',
    confidence: 0.99
  });

  assert.equal(result.intent, 'status_check');
  assert.equal(result.risk_level, 'critical');
  assert.equal(result.requires_human_review, true);
  assert.equal(result.reasons.includes('provider_detected_medical_risk'), true);
});
