const {
  classifyConversation,
  normalizeConfidence,
  normalizeIntent
} = require('./aiRealtime');

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

function configured() {
  return Boolean(process.env.ELDERCARE_AI_ANALYSIS_URL || process.env.AI_ANALYSIS_WEBHOOK_URL);
}

function providerUrl() {
  return process.env.ELDERCARE_AI_ANALYSIS_URL || process.env.AI_ANALYSIS_WEBHOOK_URL || '';
}

function providerSecret() {
  return process.env.ELDERCARE_AI_ANALYSIS_SECRET || process.env.AI_ANALYSIS_WEBHOOK_SECRET || '';
}

function normalizeReasons(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return [String(value)];
}

function normalizeAiAnalysis(data = {}, fallbackInput = {}) {
  const heuristic = classifyConversation(fallbackInput);
  const intent = normalizeIntent(data.intent || data.detected_intent || heuristic.intent);
  const confidence = normalizeConfidence(data.confidence ?? data.confidence_score ?? heuristic.confidence);
  const riskLevel = RISK_LEVELS.has(data.risk_level) ? data.risk_level : heuristic.risk_level;
  const providerReasons = normalizeReasons(data.reasons || data.guardrail_reasons);

  const requiresHumanReview = Boolean(
    data.requires_human_review === true ||
    riskLevel !== 'low' ||
    confidence < 0.85 ||
    heuristic.requires_human_review
  );

  return {
    intent,
    confidence,
    risk_level: riskLevel,
    requires_human_review: requiresHumanReview,
    approval_mode: data.approval_mode || (riskLevel === 'low' && confidence >= 0.85 ? 'one_click' : 'manual_review'),
    reasons: [...new Set([...providerReasons, ...heuristic.reasons])]
  };
}

async function analyzeWithProvider(input = {}) {
  if (!configured()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_ANALYSIS_TIMEOUT_MS || 8000));
  try {
    const headers = { 'Content-Type': 'application/json' };
    const secret = providerSecret();
    if (secret) headers.Authorization = `Bearer ${secret}`;

    const response = await fetch(providerUrl(), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        system: 'eldercare_ai_ops_classification',
        input
      })
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`AI analysis provider failed: ${response.status}`);
      error.statusCode = 502;
      error.code = 'AI_ANALYSIS_PROVIDER_FAILED';
      error.details = { status: response.status, body: text.slice(0, 500) };
      throw error;
    }
    return normalizeAiAnalysis(text ? JSON.parse(text) : {}, input);
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyWithAi(input = {}) {
  const fallback = classifyConversation(input);
  if (!configured()) {
    return {
      classification: fallback,
      analysis_source: 'rules'
    };
  }

  try {
    const providerClassification = await analyzeWithProvider(input);
    return {
      classification: providerClassification || fallback,
      analysis_source: providerClassification ? 'ai_provider' : 'rules'
    };
  } catch (error) {
    return {
      classification: {
        ...fallback,
        reasons: [...new Set([...(fallback.reasons || []), 'ai_provider_failed'])]
      },
      analysis_source: 'rules_fallback',
      analysis_error: {
        code: error.code || error.name || 'AI_ANALYSIS_ERROR',
        message: error.message
      }
    };
  }
}

module.exports = {
  analyzeWithProvider,
  classifyWithAi,
  configured,
  normalizeAiAnalysis
};
