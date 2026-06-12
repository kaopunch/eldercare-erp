-- 012: อุ่นใจ Care Platform — M4 active job: location pings + service health records
-- Additive only. RLS backend-only.
-- Note: spec wants monthly partitions + 90-day retention for pings; at pilot
-- scale a plain table + index suffices — revisit with pg_partman before scale.
-- rollback: drop table care_location_pings, care_service_health_records;
--           alter table care_bookings drop column checkout_at;

create table if not exists care_location_pings (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references care_bookings(id),
  lat numeric(9,6) not null,
  lng numeric(9,6) not null,
  accuracy_m numeric(7,1),
  recorded_at timestamptz not null default now()
);
create index if not exists idx_care_pings_booking on care_location_pings (booking_id, recorded_at desc);

create table if not exists care_service_health_records (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references care_bookings(id),
  elder_profile_id uuid not null references care_elder_profiles(id),
  vital_signs jsonb not null default '{}'::jsonb,            -- {bp, pulse, temp}
  doctor_summary text,                                        -- ผู้ดูแลสรุปสิ่งที่แพทย์แจ้ง
  medications_received jsonb not null default '[]'::jsonb,    -- [{name, note, photo_ref}]
  next_appointment jsonb,                                     -- {date, department, note}
  attachments jsonb not null default '[]'::jsonb,             -- [file_ref] ใบนัด/ฉลากยา
  created_by_user_id uuid references care_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_care_health_elder on care_service_health_records (elder_profile_id, created_at desc);
create unique index if not exists idx_care_health_booking on care_service_health_records (booking_id);

alter table care_bookings add column if not exists checkout_at timestamptz;

alter table care_location_pings enable row level security;
alter table care_service_health_records enable row level security;
