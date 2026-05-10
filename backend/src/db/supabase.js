
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

function decodeSupabaseKeyRole(key = process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const tokenParts = String(key || '').split('.');
  if (tokenParts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString('utf8'));
    return payload.role || null;
  } catch (error) {
    return null;
  }
}

function requireServiceRoleKey() {
  const role = decodeSupabaseKeyRole();
  if (role !== 'service_role') {
    const error = new Error(`SUPABASE_SERVICE_ROLE_KEY must be a service_role key; current key role is ${role || 'unknown'}`);
    error.code = 'SUPABASE_SERVICE_ROLE_REQUIRED';
    throw error;
  }
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: ws }
  });
}

module.exports = { decodeSupabaseKeyRole, getSupabase, requireServiceRoleKey };
