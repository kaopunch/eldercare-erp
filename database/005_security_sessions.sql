-- ElderCare ERP security/session hardening
-- Run after 003_app_user_login.sql. This migration enables persistent logout
-- and admin session revocation; the backend also keeps an in-memory fallback
-- until this SQL has been applied.

create table if not exists app_session_revocations (
  token_signature text primary key,
  user_id uuid references app_users(id) on delete cascade,
  revoked_by uuid references app_users(id) on delete set null,
  reason text,
  revoked_at timestamptz default now(),
  expires_at timestamptz
);

create index if not exists idx_app_session_revocations_user_id
on app_session_revocations(user_id);

create index if not exists idx_app_session_revocations_expires_at
on app_session_revocations(expires_at)
where expires_at is not null;

create table if not exists app_user_session_revocations (
  user_id uuid primary key references app_users(id) on delete cascade,
  revoked_by uuid references app_users(id) on delete set null,
  reason text,
  revoked_after timestamptz not null default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_app_user_session_revocations_revoked_after
on app_user_session_revocations(revoked_after);

alter table app_session_revocations enable row level security;
alter table app_user_session_revocations enable row level security;

drop policy if exists app_session_revocations_service_only on app_session_revocations;
drop policy if exists app_user_session_revocations_service_only on app_user_session_revocations;

comment on table app_session_revocations is
'Service-role only store for individually revoked ElderCare ERP session tokens.';

comment on table app_user_session_revocations is
'Service-role only store for revoking all sessions issued before a user-specific timestamp.';
