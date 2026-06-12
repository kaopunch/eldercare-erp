-- 011: อุ่นใจ Care Platform — M3 matching + caregiver jobs
-- Additive only. RLS backend-only like 008/010.
-- rollback: drop table care_booking_offers, care_caregiver_availability;
--           alter table care_bookings drop column matched_at;
--           alter table care_caregiver_profiles drop column jobs_completed;

-- ===== availability calendar (spec G2): slots = {"morning":bool,"afternoon":bool} =====
create table if not exists care_caregiver_availability (
  id uuid primary key default uuid_generate_v4(),
  caregiver_user_id uuid not null references care_users(id),
  date date not null,
  slots jsonb not null default '{"morning":false,"afternoon":false}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (caregiver_user_id, date)
);
create index if not exists idx_care_availability_date on care_caregiver_availability (date);

-- ===== job offers (spec 5.2: batch 5, 10-min wait, first-accept-wins) =====
create table if not exists care_booking_offers (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references care_bookings(id),
  caregiver_user_id uuid not null references care_users(id),
  batch_no int not null default 1,
  distance_km numeric(6,1),
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'offered'
    check (status in ('offered','accepted','lost','expired','withdrawn')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (booking_id, caregiver_user_id)
);
create index if not exists idx_care_offers_caregiver on care_booking_offers (caregiver_user_id, status, expires_at desc);
create index if not exists idx_care_offers_booking on care_booking_offers (booking_id, batch_no);

alter table care_bookings add column if not exists matched_at timestamptz;
alter table care_bookings add column if not exists search_started_at timestamptz;
alter table care_caregiver_profiles add column if not exists jobs_completed int not null default 0;

alter table care_caregiver_availability enable row level security;
alter table care_booking_offers enable row level security;
