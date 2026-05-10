const CHANNEL_ALIASES = {
  twilio: 'phone',
  voice: 'phone',
  call: 'phone',
  phone_call: 'phone',
  webchat: 'web_chat',
  web: 'web_chat',
  sms_message: 'sms',
  whatsapp_cloud: 'whatsapp'
};

function normalizeKey(value, fallback = 'in_app') {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || fallback;
}

function normalizeChannel(value) {
  const channel = normalizeKey(value, 'in_app');
  return CHANNEL_ALIASES[channel] || channel;
}

function firstText(...values) {
  return values.find((value) => String(value || '').trim()) || '';
}

function normalizeGenericMessage(input = {}, channel = 'in_app') {
  const sourceChannel = normalizeChannel(input.source_channel || input.channel || channel);
  const transcript = firstText(
    input.transcript,
    input.message,
    input.text,
    input.body,
    input.SpeechResult,
    input.TranscriptionText,
    input.Body
  );

  return {
    booking_id: input.booking_id || null,
    customer_id: input.customer_id || null,
    elder_id: input.elder_id || null,
    source_channel: sourceChannel,
    caller_name: input.caller_name || input.contact_name || input.ProfileName || input.From || null,
    caller_phone: input.caller_phone || input.contact_phone || input.phone || input.From || input.Caller || null,
    caller_line_id: input.caller_line_id || input.line_id || null,
    caller_email: input.caller_email || input.email || null,
    contact_role: input.contact_role || input.caller_role || null,
    contact_user_id: input.contact_user_id || null,
    intent: input.intent || input.detected_intent || null,
    confidence: input.confidence ?? input.confidence_score ?? input.ai_confidence ?? null,
    transcript,
    message: transcript,
    summary: input.summary || null,
    language: input.language || null,
    direction: input.direction || 'inbound',
    payload: {
      ...(input.payload || {}),
      provider_message_id: input.message_id || input.MessageSid || input.CallSid || null,
      provider_raw_channel: channel
    }
  };
}

function lineText(event = {}) {
  const message = event.message || {};
  if (message.type === 'text') return message.text || '';
  if (message.type === 'audio') return event.transcript || event.speech_text || '';
  return event.text || event.body || '';
}

function normalizeLineWebhook(body = {}) {
  const events = Array.isArray(body.events) ? body.events : [];
  return events.map((event) => {
    const source = event.source || {};
    const userId = source.userId || source.groupId || source.roomId || null;
    const transcript = lineText(event);
    return normalizeGenericMessage({
      source_channel: 'line',
      transcript,
      caller_name: event.profile?.displayName || userId,
      caller_line_id: userId,
      message_id: event.webhookEventId || event.message?.id || null,
      timestamp: event.timestamp || null,
      payload: {
        provider: 'line',
        line_reply_token: event.replyToken || null,
        line_source_type: source.type || null,
        line_event_type: event.type || null,
        provider_timestamp: event.timestamp || null
      }
    }, 'line');
  }).filter((message) => message.transcript);
}

function whatsappText(message = {}) {
  return firstText(
    message.text?.body,
    message.button?.text,
    message.interactive?.button_reply?.title,
    message.interactive?.list_reply?.title,
    message.caption
  );
}

function normalizeWhatsAppWebhook(body = {}) {
  const messages = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contactsByWaId = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact]));
      for (const message of value.messages || []) {
        const contact = contactsByWaId.get(message.from) || {};
        const transcript = whatsappText(message);
        if (!transcript) continue;
        messages.push(normalizeGenericMessage({
          source_channel: 'whatsapp',
          transcript,
          caller_name: contact.profile?.name || message.from || null,
          caller_phone: message.from || null,
          message_id: message.id || null,
          timestamp: message.timestamp || null,
          payload: {
            provider: 'whatsapp',
            whatsapp_phone_number_id: value.metadata?.phone_number_id || null,
            whatsapp_display_phone_number: value.metadata?.display_phone_number || null,
            whatsapp_message_type: message.type || null,
            provider_timestamp: message.timestamp || null
          }
        }, 'whatsapp'));
      }
    }
  }
  return messages;
}

function normalizeTwilioWebhook(body = {}, channel = 'phone') {
  const transcript = firstText(body.SpeechResult, body.TranscriptionText, body.Body, body.message, body.text);
  if (!transcript) return [];
  const sourceChannel = normalizeChannel(channel === 'twilio' ? (body.SmsMessageSid ? 'sms' : 'phone') : channel);
  return [normalizeGenericMessage({
    source_channel: sourceChannel,
    transcript,
    caller_name: body.CallerName || body.From || body.Caller || null,
    caller_phone: body.From || body.Caller || null,
    message_id: body.CallSid || body.MessageSid || body.SmsMessageSid || null,
    language: body.Language || null,
    payload: {
      provider: 'twilio',
      twilio_call_sid: body.CallSid || null,
      twilio_message_sid: body.MessageSid || body.SmsMessageSid || null,
      twilio_call_status: body.CallStatus || null,
      speech_confidence: body.Confidence || null
    }
  }, sourceChannel)];
}

function normalizeInboundMessages(channel, body = {}) {
  const rawChannel = channel || body.channel || body.source_channel;
  const normalizedChannel = normalizeChannel(rawChannel);
  if (normalizedChannel === 'line') return normalizeLineWebhook(body);
  if (normalizedChannel === 'whatsapp') return normalizeWhatsAppWebhook(body);
  if (normalizedChannel === 'phone' || normalizedChannel === 'sms' || normalizeKey(rawChannel) === 'twilio') {
    return normalizeTwilioWebhook(body, normalizeKey(rawChannel) === 'twilio' ? 'twilio' : normalizedChannel);
  }
  return [normalizeGenericMessage(body, normalizedChannel)].filter((message) => message.transcript);
}

function bearerToken(authorization = '') {
  const match = String(authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function verifyWebhookSecret({
  authorization,
  headerSecret,
  querySecret,
  env = process.env
} = {}) {
  const expected = env.ELDERCARE_AI_WEBHOOK_SECRET || env.AI_WEBHOOK_SECRET || '';
  if (!expected) {
    return {
      ok: env.NODE_ENV !== 'production',
      configured: false,
      reason: env.NODE_ENV === 'production' ? 'missing_secret' : 'development_open'
    };
  }

  const actual = headerSecret || bearerToken(authorization) || querySecret || '';
  return {
    ok: actual === expected,
    configured: true,
    reason: actual === expected ? 'matched' : 'mismatch'
  };
}

function assertWebhookAuthorized(req) {
  const result = verifyWebhookSecret({
    authorization: req.get('authorization'),
    headerSecret: req.get('x-eldercare-webhook-secret') || req.get('x-ai-webhook-secret'),
    querySecret: req.query.secret
  });

  if (result.ok) return result;

  const error = new Error(result.reason === 'missing_secret'
    ? 'AI webhook secret is required in production'
    : 'AI webhook secret is invalid');
  error.statusCode = result.reason === 'missing_secret' ? 503 : 401;
  error.code = result.reason === 'missing_secret' ? 'AI_WEBHOOK_SECRET_REQUIRED' : 'AI_WEBHOOK_UNAUTHORIZED';
  throw error;
}

module.exports = {
  assertWebhookAuthorized,
  normalizeChannel,
  normalizeGenericMessage,
  normalizeInboundMessages,
  normalizeLineWebhook,
  normalizeTwilioWebhook,
  normalizeWhatsAppWebhook,
  verifyWebhookSecret
};
