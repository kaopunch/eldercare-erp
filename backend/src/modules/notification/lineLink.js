/**
 * LINE account linking (spec C1 "เชื่อม LINE").
 * Flow: portal shows a short code -> user adds the OA as a friend and sends
 * the code in chat -> webhook matches the code -> line_user_id saved -> all
 * future notifications go over LINE.
 * Webhook: POST /api/v1/line/webhook (set this URL in LINE Developers Console;
 * signature verification is added in M6 hardening).
 */
const crypto = require('crypto');
const { getSupabase } = require('../../db/supabase');
const { notifySafe } = require('./notifier');

const CODE_TTL_MINUTES = 15;
const CODE_PATTERN = /^CARE-([A-Z0-9]{6})$/i;

function generateCode() {
  return `CARE-${crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;
}

async function createLinkCode(userId) {
  const code = generateCode();
  const { error } = await getSupabase()
    .from('care_users')
    .update({
      line_link_code: code,
      line_link_code_expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString()
    })
    .eq('id', userId);
  if (error) throw new Error(error.message);
  return {
    code,
    expires_in: CODE_TTL_MINUTES * 60,
    oa_url: process.env.CARE_LINE_OA_URL || null,
    instruction: `เพิ่มเพื่อน LINE OA แล้วพิมพ์ ${code} ในแชท ภายใน ${CODE_TTL_MINUTES} นาที`
  };
}

/** Handle LINE webhook events — link codes only; everything else is ignored. */
async function processWebhookEvents(events = []) {
  let linked = 0;
  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;
    const text = String(event.message.text || '').trim();
    const match = text.match(CODE_PATTERN);
    if (!match || !event.source?.userId) continue;

    const code = `CARE-${match[1].toUpperCase()}`;
    const { data: user } = await getSupabase()
      .from('care_users')
      .select('id,line_link_code_expires_at')
      .eq('line_link_code', code)
      .maybeSingle();
    if (!user) continue;
    if (user.line_link_code_expires_at && new Date(user.line_link_code_expires_at) < new Date()) continue;

    await getSupabase()
      .from('care_users')
      .update({
        line_user_id: event.source.userId,
        line_link_code: null,
        line_link_code_expires_at: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id);
    linked += 1;
    notifySafe({ userId: user.id, template: 'line_linked', data: {} });
  }
  return { linked };
}

module.exports = { createLinkCode, processWebhookEvents };
