const test = require('node:test');
const assert = require('node:assert/strict');

const { createWalletService, MIN_WITHDRAWAL_SATANG } = require('../src/modules/caregiver/walletService');
const { createReviewService } = require('../src/modules/customer/reviewService');
const { TEMPLATES } = require('../src/modules/notification/notifier');

// ===== wallet =====

function createFakeWalletRepository(initialBalance = 0) {
  const ledger = [];
  const withdrawals = [];
  let balance = initialBalance;
  return {
    ledger,
    withdrawals,
    async currentWalletBalance() {
      return balance;
    },
    async appendLedgerEntry({ caregiverUserId, bookingId = null, type, amount, note }) {
      if (type === 'earning' && ledger.some((entry) => entry.booking_id === bookingId && entry.type === 'earning')) {
        return null;
      }
      balance += amount;
      const entry = {
        id: `lg-${ledger.length + 1}`,
        caregiver_user_id: caregiverUserId,
        booking_id: bookingId,
        type,
        amount,
        balance_after: balance,
        note
      };
      ledger.push(entry);
      return entry;
    },
    async listLedgerEntries() {
      return [...ledger].reverse();
    },
    async insertWithdrawalRequest(row) {
      const request = { ...row, id: `wd-${withdrawals.length + 1}` };
      withdrawals.push(request);
      return request;
    },
    async listWithdrawalRequests() {
      return [...withdrawals];
    }
  };
}

const BANK = { bank: 'กสิกรไทย', account_no: '1234567890', account_name: 'พยาบาลดี มีใจ' };

test('withdrawal deducts immediately and keeps running balance consistent', async () => {
  const repository = createFakeWalletRepository(0);
  await repository.appendLedgerEntry({ caregiverUserId: 'cg', bookingId: 'b1', type: 'earning', amount: 72000 });
  await repository.appendLedgerEntry({ caregiverUserId: 'cg', bookingId: 'b2', type: 'earning', amount: 60000 });

  const service = createWalletService({ repository });
  const result = await service.requestWithdrawal('cg', { amount_satang: 100000, bank_info: BANK });
  assert.equal(result.balance_satang, 32000);
  assert.equal(result.status, 'pending');

  const wallet = await service.getWallet('cg');
  assert.equal(wallet.balance_satang, 32000);
  assert.deepEqual(
    repository.ledger.map((entry) => entry.balance_after),
    [72000, 132000, 32000]
  );
});

test('withdrawal rejects insufficient balance and below-minimum amounts', async () => {
  const repository = createFakeWalletRepository(0);
  await repository.appendLedgerEntry({ caregiverUserId: 'cg', bookingId: 'b1', type: 'earning', amount: 50000 });
  const service = createWalletService({ repository });

  await assert.rejects(
    service.requestWithdrawal('cg', { amount_satang: 60000, bank_info: BANK }),
    (err) => err.code === 'BALANCE_INSUFFICIENT'
  );
  await assert.rejects(
    service.requestWithdrawal('cg', { amount_satang: MIN_WITHDRAWAL_SATANG - 1, bank_info: BANK }),
    (err) => err.code === 'WITHDRAWAL_AMOUNT_INVALID'
  );
  await assert.rejects(
    service.requestWithdrawal('cg', { amount_satang: 20000, bank_info: { bank: 'x' } }),
    (err) => err.code === 'BANK_INFO_REQUIRED'
  );
});

test('earning per booking is idempotent (duplicate insert ignored)', async () => {
  const repository = createFakeWalletRepository(0);
  const first = await repository.appendLedgerEntry({ caregiverUserId: 'cg', bookingId: 'b1', type: 'earning', amount: 72000 });
  const second = await repository.appendLedgerEntry({ caregiverUserId: 'cg', bookingId: 'b1', type: 'earning', amount: 72000 });
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(await repository.currentWalletBalance(), 72000);
});

test('rejected withdrawal restores balance via adjustment', async () => {
  const repository = createFakeWalletRepository(0);
  await repository.appendLedgerEntry({ caregiverUserId: 'cg', bookingId: 'b1', type: 'earning', amount: 72000 });
  const service = createWalletService({ repository });
  await service.requestWithdrawal('cg', { amount_satang: 50000, bank_info: BANK });
  assert.equal(await repository.currentWalletBalance(), 22000);
  // simulate scripts/process_withdrawal.js --reject
  await repository.appendLedgerEntry({ caregiverUserId: 'cg', type: 'adjustment', amount: 50000, note: 'คืนยอด' });
  assert.equal(await repository.currentWalletBalance(), 72000);
});

// ===== reviews =====

function createFakeReviewRepository(bookingStatus = 'completed') {
  const reviews = [];
  const profile = { rating_avg: 4.0, rating_count: 2 };
  return {
    reviews,
    profile,
    async findBookingById(bookingId, customerUserId) {
      if (bookingId !== 'bk-1' || customerUserId !== 'cust-1') return null;
      return { id: 'bk-1', status: bookingStatus, caregiver_user_id: 'cg-1', customer_user_id: 'cust-1' };
    },
    async insertReview(row) {
      if (reviews.some((review) => review.booking_id === row.booking_id && review.direction === row.direction)) {
        const err = new Error('duplicate');
        err.code = 'REVIEW_EXISTS';
        err.statusCode = 409;
        throw err;
      }
      const review = { ...row, id: `rv-${reviews.length + 1}` };
      reviews.push(review);
      return review;
    },
    async applyReviewToRating(_caregiverId, stars) {
      const count = profile.rating_count;
      profile.rating_avg = Math.round(((profile.rating_avg * count + stars) / (count + 1)) * 100) / 100;
      profile.rating_count = count + 1;
    },
    async listUnreviewedCompletedBookings() {
      return reviews.length ? [] : [{ id: 'bk-1' }];
    },
    async listReviewsForUser() {
      return reviews;
    }
  };
}

test('review on completed booking updates caregiver rating incrementally', async () => {
  const repository = createFakeReviewRepository();
  const service = createReviewService({ repository });
  const result = await service.createReview('cust-1', {
    booking_id: 'bk-1',
    stars: 5,
    comment: 'ดูแลดีมาก',
    tags: ['ตรงเวลา', 'ดูแลดี', 'แท็กแปลกๆ']
  });
  assert.equal(result.stars, 5);
  // (4.0*2 + 5)/3 = 4.33
  assert.equal(repository.profile.rating_avg, 4.33);
  assert.equal(repository.profile.rating_count, 3);
  // unknown tags are filtered out
  assert.deepEqual(repository.reviews[0].tags, ['ตรงเวลา', 'ดูแลดี']);
});

test('review is once per booking and only after completion', async () => {
  const repository = createFakeReviewRepository();
  const service = createReviewService({ repository });
  await service.createReview('cust-1', { booking_id: 'bk-1', stars: 4 });
  await assert.rejects(
    service.createReview('cust-1', { booking_id: 'bk-1', stars: 1 }),
    (err) => err.code === 'REVIEW_EXISTS'
  );

  const notDone = createReviewService({ repository: createFakeReviewRepository('returning') });
  await assert.rejects(
    notDone.createReview('cust-1', { booking_id: 'bk-1', stars: 5 }),
    (err) => err.code === 'REVIEW_NOT_ALLOWED'
  );
});

test('pending reviews lists completed-but-unreviewed bookings', async () => {
  const repository = createFakeReviewRepository();
  const service = createReviewService({ repository });
  assert.equal((await service.pendingReviews('cust-1')).length, 1);
  await service.createReview('cust-1', { booking_id: 'bk-1', stars: 5 });
  assert.equal((await service.pendingReviews('cust-1')).length, 0);
});

// ===== notification templates =====

test('every template renders Thai text and portal deep links carry booking ids', () => {
  const data = {
    booking_id: 'bk-1',
    amount_satang: 95000,
    balance_satang: 167000,
    scheduled_date: '2026-06-20',
    pickup_time: '09:00:00',
    payout_satang: 72000,
    caregiver_name: 'พยาบาลดี',
    destination_name: 'รพ.ศิริราช',
    elder_name: 'ยายศรี',
    time: '09:15',
    deviation_km: 2.4,
    note: ''
  };
  for (const [name, builder] of Object.entries(TEMPLATES)) {
    const message = builder(data);
    assert.ok(message.length > 10, `${name} renders`);
  }
  assert.match(TEMPLATES.paid(data), /950/);
  assert.match(TEMPLATES.checkin_home(data), /\/bookings\/bk-1\/track/);
  assert.match(TEMPLATES.money_in(data), /950.*1,670/);
  assert.match(TEMPLATES.new_offer(data), /09:00/);
});
