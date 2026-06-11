-- 008: อุ่นใจ Care Platform — M1 tables (auth, elder profiles, caregiver profiles)
-- All new marketplace tables use the care_ prefix to avoid colliding with ERP tables
-- (spec name -> actual: users -> care_users, elder_profiles -> care_elder_profiles, ...).
-- Money columns are int satang per spec. Additive only — touches no ERP table.
-- rollback: drop table care_audit_logs, care_caregiver_profiles, care_elder_profiles,
--           care_refresh_tokens, care_otp_codes, care_users; delete storage bucket care-documents.

-- ===== users (login for customer + caregiver portals) =====
create table if not exists care_users (
  id uuid primary key default uuid_generate_v4(),
  phone varchar(15) not null unique, -- E.164, primary login
  email text,
  password_hash text, -- null until OTP verified and password set
  role text not null check (role in ('customer','caregiver','admin')),
  line_user_id text,
  status text not null default 'pending_verification'
    check (status in ('active','suspended','pending_verification')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ===== OTP codes (register/login/reset) =====
create table if not exists care_otp_codes (
  id uuid primary key default uuid_generate_v4(),
  phone varchar(15) not null,
  purpose text not null check (purpose in ('register','login','reset')),
  code_hash text not null, -- never store the plain OTP
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_care_otp_phone on care_otp_codes (phone, purpose, created_at desc);

-- ===== refresh tokens (JWT refresh, 30 days) =====
create table if not exists care_refresh_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references care_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_care_refresh_user on care_refresh_tokens (user_id, expires_at desc);

-- ===== elder profiles (created by customer; sensitive health data) =====
create table if not exists care_elder_profiles (
  id uuid primary key default uuid_generate_v4(),
  owner_user_id uuid not null references care_users(id),
  full_name text not null,
  nickname text,
  birth_date date,
  gender text check (gender in ('male','female','other')),
  blood_type text,
  weight_kg numeric(5,1),
  height_cm numeric(5,1),
  chronic_conditions jsonb not null default '[]'::jsonb,
  medications jsonb not null default '[]'::jsonb, -- [{name, dose, schedule}]
  allergies jsonb not null default '[]'::jsonb,
  mobility text check (mobility in ('walk','cane','walker','wheelchair','bedridden')),
  primary_hospital text,
  home_address text,
  home_location extensions.geography(point, 4326),
  special_notes text,
  photo_url text,
  consent_version text not null, -- PDPA: consent text version accepted at creation
  consent_accepted_at timestamptz not null,
  deleted_at timestamptz, -- soft delete; health history must remain linkable
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_care_elder_owner on care_elder_profiles (owner_user_id);

-- ===== caregiver profiles =====
create table if not exists care_caregiver_profiles (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null unique references care_users(id),
  full_name text not null,
  birth_date date,
  gender text check (gender in ('male','female','other')),
  photo_url text,
  id_card_number_encrypted text, -- AES-encrypted at rest; never logged or returned by API
  background text check (background in ('nurse_retired','nurse_assistant','health_student','trained_general')),
  certificates jsonb not null default '[]'::jsonb, -- [{type, file_ref, uploaded_at, verified_at}]
  languages jsonb not null default '["th"]'::jsonb,
  service_area_center extensions.geography(point, 4326),
  service_radius_km numeric(5,1),
  base_rate_half_day int, -- satang
  base_rate_full_day int, -- satang
  verification_status text not null default 'pending'
    check (verification_status in ('pending','documents_submitted','verified','rejected')),
  verification_note text, -- admin feedback shown on pending page checklist
  verified_badge boolean not null default false,
  rating_avg numeric(3,2) not null default 0,
  rating_count int not null default 0,
  wallet_balance bigint not null default 0, -- satang; denormalized from care_payout_ledger (M5)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ===== PDPA access log for care platform (health-data reads) =====
create table if not exists care_audit_logs (
  id uuid primary key default uuid_generate_v4(),
  actor_user_id uuid references care_users(id),
  action text not null, -- e.g. elder_profile.read, elder_profile.update
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_care_audit_entity on care_audit_logs (entity_type, entity_id, created_at desc);

-- ===== RLS: backend-only (service role) — same pattern as 006 =====
alter table care_users enable row level security;
alter table care_otp_codes enable row level security;
alter table care_refresh_tokens enable row level security;
alter table care_elder_profiles enable row level security;
alter table care_caregiver_profiles enable row level security;
alter table care_audit_logs enable row level security;

-- ===== private storage bucket for caregiver documents / elder photos =====
insert into storage.buckets (id, name, public)
values ('care-documents', 'care-documents', false)
on conflict (id) do nothing;
