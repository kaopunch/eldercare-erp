require('dotenv').config();

const { getSupabase, requireServiceRoleKey } = require('../src/db/supabase');
const { hashPin } = require('../src/lib/session');

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  console.error('Usage: node scripts/set_user_pin.js --email user@example.com --pin 123456');
  console.error('   or: node scripts/set_user_pin.js --user-id <uuid> --pin 123456');
}

async function main() {
  const email = argValue('email');
  const userId = argValue('user-id');
  const pin = argValue('pin') || process.env.ELDERCARE_SET_PIN;
  if ((!email && !userId) || !pin) {
    usage();
    process.exit(1);
  }
  requireServiceRoleKey();

  const sb = getSupabase();
  let query = sb.from('app_users').select('id,email,full_name,role,status');
  query = userId ? query.eq('id', userId) : query.eq('email', email);
  const { data: user, error: userError } = await query.single();
  if (userError) throw userError;
  if (user.status !== 'active') {
    throw new Error(`Cannot set PIN for ${user.full_name}: status is ${user.status}`);
  }

  const { error } = await sb.from('app_user_credentials').upsert({
    user_id: user.id,
    login_pin_hash: hashPin(pin),
    must_rotate_pin: false,
    failed_attempts: 0,
    locked_until: null,
    pin_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) throw error;

  console.log(`PIN set for ${user.full_name} (${user.role})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
