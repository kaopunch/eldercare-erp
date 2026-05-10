-- ElderCare ERP app-user PIN login hardening
-- Run after 001_schema.sql and 002_rls_policies.sql.

create table if not exists app_user_credentials (
  user_id uuid primary key references app_users(id) on delete cascade,
  login_pin_hash text not null,
  must_rotate_pin boolean default false,
  failed_attempts integer default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  pin_updated_at timestamptz default now(),
  last_login_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_app_user_credentials_locked_until
on app_user_credentials(locked_until)
where locked_until is not null;

alter table app_user_credentials enable row level security;

-- Credential hashes must never be readable through direct client access.
drop policy if exists app_user_credentials_service_only on app_user_credentials;

-- Existing audit policy allows internal roles to insert audit records.
comment on table app_user_credentials is
'Service-role only credential store for ElderCare ERP app users. Use backend/scripts/set_user_pin.js to set PIN hashes.';
