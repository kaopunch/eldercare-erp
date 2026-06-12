-- 013: อุ่นใจ Care Platform — M5 wallet ledger, reviews, withdrawals, notifications, LINE link
-- Additive only. RLS backend-only.
-- rollback: drop table care_notifications, care_withdrawal_requests, care_reviews,
--           care_payout_ledger; alter table care_users drop column line_link_code;

-- ===== payout ledger (append-only — single source of truth for wallet) =====
create table if not exists care_payout_ledger (
  id uuid primary key default uuid_generate_v4(),
  caregiver_user_id uuid not null references care_users(id),
  booking_id uuid references care_bookings(id),
  type text not null check (type in ('earning','withdrawal','adjustment')),
  amount int not null,          -- signed satang (earning +, withdrawal -)
  balance_after bigint not null, -- running balance snapshot
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_care_ledger_caregiver on care_payout_ledger (caregiver_user_id, created_at desc);
create unique index if not exists idx_care_ledger_earning_once
  on care_payout_ledger (booking_id) where type = 'earning';

-- ===== withdrawal requests (เฟสนี้: admin โอน manual แล้ว mark paid) =====
create table if not exists care_withdrawal_requests (
  id uuid primary key default uuid_generate_v4(),
  caregiver_user_id uuid not null references care_users(id),
  amount int not null, -- satang
  bank_info jsonb not null default '{}'::jsonb, -- {bank, account_no, account_name}
  status text not null default 'pending' check (status in ('pending','paid','rejected')),
  ledger_id uuid references care_payout_ledger(id),
  processed_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_care_withdrawals on care_withdrawal_requests (caregiver_user_id, created_at desc);

-- ===== reviews =====
create table if not exists care_reviews (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references care_bookings(id),
  direction text not null check (direction in ('customer_to_caregiver','caregiver_to_customer')),
  reviewer_user_id uuid not null references care_users(id),
  reviewee_user_id uuid not null references care_users(id),
  stars int not null check (stars between 1 and 5),
  comment text,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (booking_id, direction)
);
create index if not exists idx_care_reviews_reviewee on care_reviews (reviewee_user_id, created_at desc);

-- ===== notification log (ทุก channel: line / mock / sms) =====
create table if not exists care_notifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references care_users(id), -- null = admin group
  booking_id uuid references care_bookings(id),
  template text not null,    -- e.g. paid, new_offer, checkin_home, money_in
  channel text not null,     -- line | sms | mock
  message text not null,
  status text not null default 'sent' check (status in ('sent','failed','skipped')),
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists idx_care_notifications_user on care_notifications (user_id, created_at desc);

-- LINE account linking: short-lived code the user sends to the OA chat
alter table care_users add column if not exists line_link_code text;
alter table care_users add column if not exists line_link_code_expires_at timestamptz;

alter table care_payout_ledger enable row level security;
alter table care_withdrawal_requests enable row level security;
alter table care_reviews enable row level security;
alter table care_notifications enable row level security;
