const fs = require('fs');
const path = require('path');
const express = require('express');
const { decodeSupabaseKeyRole, getSupabase } = require('../db/supabase');
const { authMode, demoAuthAllowed, sessionHours } = require('../lib/session');
const { paymentEvidenceBucket } = require('../lib/storage');
const { isMissingRevocationSchema } = require('../lib/revocations');
const { configured: aiAnalysisConfigured } = require('../lib/aiAnalysisProvider');

const router = express.Router();

function readinessCheck(id, label, status, details = {}) {
  return { id, label, status, details };
}

function summarize(checks) {
  return checks.reduce((memo, check) => {
    memo.total += 1;
    memo[check.status] = (memo[check.status] || 0) + 1;
    return memo;
  }, { total: 0, pass: 0, warn: 0, fail: 0 });
}

async function activeUsersAndCredentials(sb) {
  const users = await sb.from('app_users')
    .select('id,status')
    .eq('status', 'active');
  if (users.error) throw users.error;

  const userIds = (users.data || []).map((user) => user.id);
  if (!userIds.length) return { users: [], credentials: [] };

  const credentials = await sb.from('app_user_credentials')
    .select('user_id,must_rotate_pin')
    .in('user_id', userIds);
  if (credentials.error) throw credentials.error;

  return { users: users.data || [], credentials: credentials.data || [] };
}

router.get('/', async (_, res, next) => {
  try {
    const sb = getSupabase();
    const checks = [];
    const supabaseRole = decodeSupabaseKeyRole();
    const bucketName = paymentEvidenceBucket();
    const fontDir = path.join(__dirname, '..', '..', 'assets', 'fonts');
    const regularFont = path.join(fontDir, 'NotoSansThai-Regular.ttf');
    const boldFont = path.join(fontDir, 'NotoSansThai-Bold.ttf');

    checks.push(readinessCheck('auth.mode', 'PIN auth mode', authMode() === 'pin' ? 'pass' : 'fail', {
      mode: authMode()
    }));
    checks.push(readinessCheck('auth.demo', 'Demo auth disabled', demoAuthAllowed() ? 'fail' : 'pass', {
      demo_allowed: demoAuthAllowed()
    }));
    checks.push(readinessCheck('session.secret', 'Dedicated session secret', process.env.ELDERCARE_SESSION_SECRET ? 'pass' : 'warn', {
      configured: Boolean(process.env.ELDERCARE_SESSION_SECRET),
      session_hours: sessionHours()
    }));
    checks.push(readinessCheck('supabase.url', 'Supabase URL configured', process.env.SUPABASE_URL ? 'pass' : 'fail', {
      configured: Boolean(process.env.SUPABASE_URL)
    }));
    checks.push(readinessCheck('supabase.service_role', 'Supabase service role key', supabaseRole === 'service_role' ? 'pass' : 'fail', {
      key_role: supabaseRole || 'unknown'
    }));

    try {
      const { users, credentials } = await activeUsersAndCredentials(sb);
      const credentialUserIds = new Set(credentials.map((credential) => credential.user_id));
      checks.push(readinessCheck('schema.credentials', 'PIN credential schema', 'pass', {
        active_users: users.length,
        credentials: credentials.length
      }));
      checks.push(readinessCheck('users.pin_coverage', 'Active user PIN coverage', users.every((user) => credentialUserIds.has(user.id)) ? 'pass' : 'fail', {
        active_users: users.length,
        pin_configured: credentialUserIds.size
      }));
      checks.push(readinessCheck('users.pin_rotation', 'Temporary PIN rotation cleared', credentials.some((credential) => credential.must_rotate_pin) ? 'warn' : 'pass', {
        rotation_required: credentials.filter((credential) => credential.must_rotate_pin).length
      }));
    } catch (error) {
      checks.push(readinessCheck('schema.credentials', 'PIN credential schema', 'fail', {
        code: error.code || null,
        message: error.message
      }));
    }

    const auditProbe = await sb.from('audit_logs').select('id').limit(1);
    checks.push(readinessCheck('schema.audit', 'Audit log table reachable', auditProbe.error ? 'fail' : 'pass', {
      code: auditProbe.error?.code || null
    }));

    const sopV2Tables = [
      ['booking_workflows', 'Booking workflow templates'],
      ['visit_summaries', 'Visit summary approvals'],
      ['family_updates', 'Family communication log'],
      ['sla_escalations', 'SLA escalation log'],
      ['branch_operation_checklists', 'Branch operation checklist']
    ];
    for (const [table, label] of sopV2Tables) {
      const probe = await sb.from(table).select('id').limit(1);
      checks.push(readinessCheck(`schema.${table}`, label, probe.error ? 'fail' : 'pass', {
        code: probe.error?.code || null
      }));
    }

    const sessionRevocationProbe = await sb.from('app_user_session_revocations').select('user_id').limit(1);
    checks.push(readinessCheck('schema.session_revocation', 'Persistent session revocation schema', sessionRevocationProbe.error ? (isMissingRevocationSchema(sessionRevocationProbe.error) ? 'warn' : 'fail') : 'pass', {
      persistent: !sessionRevocationProbe.error,
      code: sessionRevocationProbe.error?.code || null
    }));

    const storageProbe = await sb.storage.getBucket(bucketName);
    checks.push(readinessCheck('storage.payment_evidence', 'Private payment evidence bucket', storageProbe.data ? 'pass' : 'warn', {
      bucket: bucketName,
      configured: Boolean(storageProbe.data),
      code: storageProbe.error?.statusCode || storageProbe.error?.code || null
    }));

    checks.push(readinessCheck('pdf.thai_fonts', 'Thai PDF fonts bundled', fs.existsSync(regularFont) && fs.existsSync(boldFont) ? 'pass' : 'fail', {
      regular: fs.existsSync(regularFont),
      bold: fs.existsSync(boldFont)
    }));
    checks.push(readinessCheck('line.config', 'LINE integration credentials', process.env.LINE_CHANNEL_ACCESS_TOKEN ? 'pass' : 'warn', {
      configured: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN)
    }));
    checks.push(readinessCheck('ai.webhook_secret', 'AI inbound webhook shared secret', process.env.ELDERCARE_AI_WEBHOOK_SECRET || process.env.AI_WEBHOOK_SECRET ? 'pass' : 'warn', {
      configured: Boolean(process.env.ELDERCARE_AI_WEBHOOK_SECRET || process.env.AI_WEBHOOK_SECRET)
    }));
    checks.push(readinessCheck('ai.analysis_provider', 'External AI analysis provider', aiAnalysisConfigured() ? 'pass' : 'warn', {
      configured: aiAnalysisConfigured()
    }));
    checks.push(readinessCheck('ai.outbound_delivery', 'External outbound delivery gateway', process.env.ELDERCARE_OUTBOUND_DELIVERY_URL || process.env.OUTBOUND_DELIVERY_WEBHOOK_URL ? 'pass' : 'warn', {
      configured: Boolean(process.env.ELDERCARE_OUTBOUND_DELIVERY_URL || process.env.OUTBOUND_DELIVERY_WEBHOOK_URL),
      line_configured: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN)
    }));

    res.json({
      ok: true,
      summary: summarize(checks),
      checks
    });
  } catch (e) { next(e); }
});

module.exports = router;
