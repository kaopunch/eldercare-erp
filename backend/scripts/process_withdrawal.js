/**
 * Ops script: settle a withdrawal request after the manual bank transfer
 * (admin dashboard is out of scope).
 * Usage: node scripts/process_withdrawal.js --id <request_id> [--reject "เหตุผล"]
 *        node scripts/process_withdrawal.js --list
 */
require('dotenv').config();
const { getSupabase } = require('../src/db/supabase');
const { appendLedgerEntry } = require('../src/modules/booking/repository');

async function main() {
  const args = process.argv.slice(2);
  const sb = getSupabase();

  if (args.includes('--list')) {
    const { data } = await sb
      .from('care_withdrawal_requests')
      .select('id,caregiver_user_id,amount,bank_info,status,created_at')
      .eq('status', 'pending')
      .order('created_at');
    for (const row of data || []) {
      console.log(`${row.id}  ${(row.amount / 100).toFixed(2)} บาท  ${row.bank_info.bank} ${row.bank_info.account_no} (${row.bank_info.account_name})`);
    }
    if (!data?.length) console.log('no pending withdrawals');
    return;
  }

  const idIndex = args.indexOf('--id');
  if (idIndex === -1 || !args[idIndex + 1]) {
    console.error('Usage: node scripts/process_withdrawal.js --id <request_id> [--reject "เหตุผล"] | --list');
    process.exit(1);
  }
  const id = args[idIndex + 1];
  const rejectIndex = args.indexOf('--reject');
  const reject = rejectIndex !== -1;
  const note = reject ? args[rejectIndex + 1] || 'rejected' : null;

  const { data: request, error } = await sb
    .from('care_withdrawal_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !request) {
    console.error('request not found:', error?.message || id);
    process.exit(1);
  }
  if (request.status !== 'pending') {
    console.error(`request already ${request.status}`);
    process.exit(1);
  }

  if (reject) {
    // compensating adjustment restores the held amount
    await appendLedgerEntry({
      caregiverUserId: request.caregiver_user_id,
      type: 'adjustment',
      amount: request.amount,
      note: `คืนยอดถอนที่ถูกปฏิเสธ: ${note}`
    });
  }
  await sb
    .from('care_withdrawal_requests')
    .update({ status: reject ? 'rejected' : 'paid', processed_at: new Date().toISOString(), note })
    .eq('id', id);
  console.log(`${id} -> ${reject ? 'rejected (balance restored)' : 'paid'}`);
}

main();
