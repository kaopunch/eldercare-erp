require('dotenv').config();

const dns = require('dns').promises;
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { decodeSupabaseKeyRole } = require('../src/db/supabase');
const { paymentEvidenceBucket } = require('../src/lib/storage');

const TABLE_PROBES = [
  ['app_users', 'id'],
  ['app_user_credentials', 'user_id'],
  ['audit_logs', 'id'],
  ['booking_workflows', 'id'],
  ['visit_summaries', 'id'],
  ['family_updates', 'id'],
  ['sla_escalations', 'id'],
  ['branch_operation_checklists', 'id'],
  ['app_user_session_revocations', 'user_id']
];

function argValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function redactUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch (error) {
    return 'invalid-url';
  }
}

function check(id, label, status, details = {}) {
  return { id, label, status, details };
}

function summarize(checks) {
  return checks.reduce((summary, item) => {
    summary.total += 1;
    summary[item.status] = (summary[item.status] || 0) + 1;
    return summary;
  }, { total: 0, pass: 0, warn: 0, fail: 0 });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeSupabaseTables(sb, checks) {
  for (const [table, column] of TABLE_PROBES) {
    try {
      const result = await sb.from(table).select(column, { count: 'exact', head: true });
      checks.push(check(`schema.${table}`, table, result.error ? 'fail' : 'pass', {
        count: result.count,
        code: result.error?.code || null,
        message: result.error?.message || null
      }));
    } catch (error) {
      checks.push(check(`schema.${table}`, table, 'fail', {
        message: error.message
      }));
    }
  }
}

async function probeStorage(sb, checks) {
  const bucket = paymentEvidenceBucket();
  try {
    const result = await sb.storage.getBucket(bucket);
    checks.push(check('storage.payment_evidence', 'Payment evidence bucket', result.data ? 'pass' : 'warn', {
      bucket,
      configured: Boolean(result.data),
      code: result.error?.statusCode || result.error?.code || null,
      message: result.error?.message || null
    }));
  } catch (error) {
    checks.push(check('storage.payment_evidence', 'Payment evidence bucket', 'warn', {
      bucket,
      message: error.message
    }));
  }
}

async function probeRender(baseUrl, checks) {
  if (!baseUrl) {
    checks.push(check('render.base_url', 'Render base URL supplied', 'warn', {
      configured: false,
      hint: 'Pass --base-url=https://eldercare-erp.onrender.com or set ELDERCARE_PUBLIC_BASE_URL'
    }));
    return;
  }

  const normalized = baseUrl.replace(/\/+$/, '');
  checks.push(check('render.base_url', 'Render base URL supplied', 'pass', {
    url: redactUrl(normalized)
  }));

  try {
    const health = await fetchWithTimeout(`${normalized}/health`);
    let payload = null;
    try {
      payload = await health.json();
    } catch (error) {
      payload = null;
    }
    checks.push(check('render.health', 'Render health endpoint', health.ok && payload?.ok ? 'pass' : 'fail', {
      status: health.status,
      service: payload?.service || null
    }));
  } catch (error) {
    checks.push(check('render.health', 'Render health endpoint', 'fail', {
      message: error.message
    }));
  }

  try {
    const authConfig = await fetchWithTimeout(`${normalized}/api/auth/config`);
    const payload = await authConfig.json();
    checks.push(check('render.auth_config', 'Render production auth config', payload?.config?.mode === 'pin' && payload?.config?.demo_allowed === false ? 'pass' : 'fail', {
      status: authConfig.status,
      mode: payload?.config?.mode || null,
      demo_allowed: payload?.config?.demo_allowed
    }));
  } catch (error) {
    checks.push(check('render.auth_config', 'Render production auth config', 'fail', {
      message: error.message
    }));
  }

  try {
    const token = process.env.ELDERCARE_ADMIN_SESSION_TOKEN || '';
    const readiness = await fetchWithTimeout(`${normalized}/api/readiness`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (token) {
      const payload = await readiness.json();
      checks.push(check('render.readiness', 'Render authenticated readiness', readiness.ok && payload?.summary?.fail === 0 ? 'pass' : 'fail', {
        status: readiness.status,
        summary: payload?.summary || null
      }));
    } else {
      checks.push(check('render.readiness_auth', 'Render readiness requires auth', readiness.status === 401 ? 'pass' : 'fail', {
        status: readiness.status
      }));
    }
  } catch (error) {
    checks.push(check('render.readiness', 'Render readiness endpoint', 'fail', {
      message: error.message
    }));
  }
}

async function main() {
  const checks = [];
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const baseUrl = argValue('base-url') || process.env.ELDERCARE_PUBLIC_BASE_URL || '';
  let host = '';

  checks.push(check('env.supabase_url', 'SUPABASE_URL configured', supabaseUrl ? 'pass' : 'fail', {
    configured: Boolean(supabaseUrl),
    url: redactUrl(supabaseUrl)
  }));
  checks.push(check('env.supabase_service_role', 'SUPABASE_SERVICE_ROLE_KEY is service_role', decodeSupabaseKeyRole() === 'service_role' ? 'pass' : 'fail', {
    configured: Boolean(supabaseKey),
    role: decodeSupabaseKeyRole() || 'unknown'
  }));

  if (supabaseUrl) {
    try {
      host = new URL(supabaseUrl).host;
      const lookup = await dns.lookup(host);
      checks.push(check('network.supabase_dns', 'Supabase DNS resolves', 'pass', {
        host,
        family: lookup.family
      }));
    } catch (error) {
      checks.push(check('network.supabase_dns', 'Supabase DNS resolves', 'fail', {
        host: host || 'invalid-url',
        message: error.message
      }));
    }
  }

  const dnsReady = checks.find((item) => item.id === 'network.supabase_dns')?.status === 'pass';
  if (supabaseUrl && supabaseKey && dnsReady) {
    const sb = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      realtime: { transport: ws }
    });
    await probeSupabaseTables(sb, checks);
    await probeStorage(sb, checks);
  } else {
    checks.push(check('schema.probes', 'Supabase schema probes skipped', 'warn', {
      reason: 'SUPABASE_URL, service role key, or DNS readiness is missing'
    }));
  }

  await probeRender(baseUrl, checks);

  const summary = summarize(checks);
  const result = {
    ok: summary.fail === 0,
    generated_at: new Date().toISOString(),
    summary,
    checks
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    code: error.code || error.name || 'RUNTIME_READINESS_ERROR'
  }, null, 2));
  process.exit(1);
});
