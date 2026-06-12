/**
 * Ops script: mark a caregiver as verified (admin dashboard is out of scope).
 * Usage: node scripts/verify_caregiver.js --phone 0800000002 [--reject "note"]
 */
require('dotenv').config();
const { getSupabase } = require('../src/db/supabase');
const { normalizePhone } = require('../src/modules/shared/phone');

async function main() {
  const args = process.argv.slice(2);
  const phoneIndex = args.indexOf('--phone');
  if (phoneIndex === -1 || !args[phoneIndex + 1]) {
    console.error('Usage: node scripts/verify_caregiver.js --phone 08XXXXXXXX [--reject "note"]');
    process.exit(1);
  }
  const phone = normalizePhone(args[phoneIndex + 1]);
  const rejectIndex = args.indexOf('--reject');
  const reject = rejectIndex !== -1;
  const note = reject ? args[rejectIndex + 1] || null : null;

  const sb = getSupabase();
  const { data: user, error: userError } = await sb
    .from('care_users')
    .select('id,phone,role')
    .eq('phone', phone)
    .maybeSingle();
  if (userError || !user) {
    console.error('user not found:', phone, userError?.message || '');
    process.exit(1);
  }
  if (user.role !== 'caregiver') {
    console.error(`user ${phone} has role ${user.role}, not caregiver`);
    process.exit(1);
  }
  const { data: profile, error } = await sb
    .from('care_caregiver_profiles')
    .update({
      verification_status: reject ? 'rejected' : 'verified',
      verified_badge: !reject,
      verification_note: note,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', user.id)
    .select('full_name,verification_status')
    .maybeSingle();
  if (error || !profile) {
    console.error('profile update failed:', error?.message || 'no profile row');
    process.exit(1);
  }
  console.log(`${profile.full_name} (${phone}) -> ${profile.verification_status}`);
}

main();
