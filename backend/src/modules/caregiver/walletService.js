/**
 * Caregiver wallet (spec G5). The append-only care_payout_ledger is the single
 * source of truth; care_caregiver_profiles.wallet_balance is denormalized.
 * Withdrawal phase 1: request deducts the balance immediately (hold), admin
 * transfers manually and marks paid via scripts/process_withdrawal.js;
 * a rejection writes a compensating adjustment.
 */
const bookingRepository = require('../booking/repository');
const { AppError } = require('../shared/appError');

const MIN_WITHDRAWAL_SATANG = 10000; // 100 บาท

function createWalletService({ repository = bookingRepository } = {}) {
  async function getWallet(caregiverUserId) {
    const [balance, ledger, withdrawals] = await Promise.all([
      repository.currentWalletBalance(caregiverUserId),
      repository.listLedgerEntries(caregiverUserId),
      repository.listWithdrawalRequests(caregiverUserId)
    ]);
    return { balance_satang: balance, ledger, withdrawals };
  }

  async function requestWithdrawal(caregiverUserId, { amount_satang: amountSatang, bank_info: bankInfo }) {
    const amount = Number(amountSatang);
    if (!Number.isInteger(amount) || amount < MIN_WITHDRAWAL_SATANG) {
      throw new AppError('WITHDRAWAL_AMOUNT_INVALID', `ยอดถอนขั้นต่ำ ${MIN_WITHDRAWAL_SATANG / 100} บาท`, 422);
    }
    if (!bankInfo?.bank || !bankInfo?.account_no || !bankInfo?.account_name) {
      throw new AppError('BANK_INFO_REQUIRED', 'กรุณากรอกข้อมูลบัญชีธนาคารให้ครบ', 422);
    }
    const balance = await repository.currentWalletBalance(caregiverUserId);
    if (amount > balance) {
      throw new AppError('BALANCE_INSUFFICIENT', 'ยอดเงินในกระเป๋าไม่พอ', 422, {
        balance_satang: balance
      });
    }
    const entry = await repository.appendLedgerEntry({
      caregiverUserId,
      type: 'withdrawal',
      amount: -amount,
      note: `ถอนเข้าบัญชี ${bankInfo.bank} ${bankInfo.account_no}`
    });
    const request = await repository.insertWithdrawalRequest({
      caregiver_user_id: caregiverUserId,
      amount,
      bank_info: bankInfo,
      status: 'pending',
      ledger_id: entry.id
    });
    return {
      id: request.id,
      amount_satang: amount,
      status: request.status,
      balance_satang: entry.balance_after
    };
  }

  return { getWallet, requestWithdrawal, MIN_WITHDRAWAL_SATANG };
}

module.exports = { createWalletService, MIN_WITHDRAWAL_SATANG };
