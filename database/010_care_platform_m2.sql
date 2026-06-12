-- 010: อุ่นใจ Care Platform — M2 booking core + payment (escrow)
-- Money = int satang. Additive only. RLS backend-only (service role) like 008.
-- rollback: drop table care_payments, care_booking_events, care_bookings,
--           care_cancellation_rules, care_pricing_rules.

-- ===== pricing rules (spec 5.1: config in DB, editable without deploy) =====
create table if not exists care_pricing_rules (
  id uuid primary key default uuid_generate_v4(),
  service_type text not null check (service_type in ('hospital_visit','errand','companion')),
  duration_type text not null check (duration_type in ('half_day','full_day')),
  base_satang int not null,
  included_km numeric(6,1) not null default 10,
  per_km_satang int not null default 800, -- surcharge per km beyond included_km
  english_multiplier numeric(4,2) not null default 1.25, -- premium tier
  platform_fee_pct numeric(4,3) not null default 0.200,
  insurance_fee_satang int not null default 5000,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_care_pricing_active
  on care_pricing_rules (service_type, duration_type) where active;

insert into care_pricing_rules (service_type, duration_type, base_satang) values
  ('hospital_visit','half_day',  90000),
  ('hospital_visit','full_day', 150000),
  ('errand','half_day',          70000),
  ('errand','full_day',         120000),
  ('companion','half_day',       80000),
  ('companion','full_day',      140000)
on conflict do nothing;

-- ===== cancellation rules (spec 3.1: config not hardcode) =====
create table if not exists care_cancellation_rules (
  id uuid primary key default uuid_generate_v4(),
  min_hours_before numeric(6,2) not null, -- tier applies when hours_before >= this value
  customer_refund_pct numeric(5,2) not null,
  caregiver_comp_pct numeric(5,2) not null, -- % of caregiver_payout compensated
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into care_cancellation_rules (min_hours_before, customer_refund_pct, caregiver_comp_pct) values
  (24, 100, 0),
  (6,   80, 10),
  (0,   50, 30)
on conflict do nothing;

-- ===== bookings (heart of the system — driven by BookingStateMachine) =====
create table if not exists care_bookings (
  id uuid primary key default uuid_generate_v4(),
  customer_user_id uuid not null references care_users(id),
  elder_profile_id uuid not null references care_elder_profiles(id),
  caregiver_user_id uuid references care_users(id),
  service_type text not null check (service_type in ('hospital_visit','errand','companion')),
  duration_type text not null check (duration_type in ('half_day','full_day')),
  scheduled_date date not null,
  pickup_time time not null,
  pickup_address text,
  pickup_location extensions.geography(point, 4326),
  pickup_lat numeric(9,6),
  pickup_lng numeric(9,6),
  destination_name text not null,
  destination_address text,
  destination_location extensions.geography(point, 4326),
  destination_lat numeric(9,6),
  destination_lng numeric(9,6),
  appointment_detail text,
  special_requirements jsonb not null default '{}'::jsonb, -- {wheelchair, english, caregiver_gender}
  -- price snapshot at confirmation (int satang)
  price_total int,
  platform_fee int,
  caregiver_payout int,
  insurance_fee int,
  distance_km numeric(6,1),
  status text not null default 'draft' check (status in (
    'draft','pending_payment','searching','matched','confirmed',
    'in_progress_pickup','at_destination','returning',
    'pending_confirmation','completed','cancelled','disputed'
  )),
  payment_expires_at timestamptz, -- pending_payment expires after 30 min
  cancelled_by text check (cancelled_by in ('customer','caregiver','system','admin')),
  cancel_reason text,
  cancelled_at timestamptz,
  refund_pct numeric(5,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_care_bookings_customer on care_bookings (customer_user_id, created_at desc);
create index if not exists idx_care_bookings_status on care_bookings (status, scheduled_date);
create index if not exists idx_care_bookings_caregiver on care_bookings (caregiver_user_id, scheduled_date);

-- ===== booking events (append-only log; never update/delete rows) =====
create table if not exists care_booking_events (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references care_bookings(id),
  event_type text not null, -- created/paid/matched/.../cancelled/sos/geofence_alert/status_changed
  actor text not null check (actor in ('customer','caregiver','system','admin')),
  location extensions.geography(point, 4326),
  lat numeric(9,6),
  lng numeric(9,6),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_care_booking_events on care_booking_events (booking_id, created_at);

-- ===== payments (escrow lifecycle) =====
create table if not exists care_payments (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references care_bookings(id),
  amount int not null, -- satang
  method text not null check (method in ('promptpay','card','mock')),
  gateway text not null default 'mock', -- 'omise' | 'mock'
  gateway_charge_id text,
  status text not null default 'pending'
    check (status in ('pending','held_escrow','released','refunded','failed')),
  refund_amount int,
  paid_at timestamptz,
  released_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_care_payments_booking on care_payments (booking_id, created_at desc);
create unique index if not exists idx_care_payments_charge on care_payments (gateway_charge_id) where gateway_charge_id is not null;

alter table care_pricing_rules enable row level security;
alter table care_cancellation_rules enable row level security;
alter table care_bookings enable row level security;
alter table care_booking_events enable row level security;
alter table care_payments enable row level security;
