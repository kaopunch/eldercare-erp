require('dotenv').config();

const { decodeSupabaseKeyRole } = require('../src/db/supabase');

const role = decodeSupabaseKeyRole();

console.log(JSON.stringify({
  supabase_url_configured: Boolean(process.env.SUPABASE_URL),
  supabase_key_configured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  supabase_key_role: role || 'unknown',
  service_role_ready: role === 'service_role'
}, null, 2));

if (role !== 'service_role') {
  process.exitCode = 1;
}
