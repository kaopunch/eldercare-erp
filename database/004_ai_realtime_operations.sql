-- ElderCare ERP AI realtime operations migration
-- Run after the core schema when an existing Supabase database is missing
-- AI call center, admin task, guardrail, event, and party presence tables.

create or replace function current_app_claims()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function current_app_role()
returns text
language sql
stable
as $$
  select coalesce(current_app_claims() ->> 'app_role', current_app_claims() ->> 'role', 'anon');
$$;

create or replace function current_app_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_app_claims() ->> 'app_user_id', '')::uuid;
$$;

create table if not exists ai_conversations (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  elder_id uuid references elders(id) on delete set null,
  source_channel text not null default 'in_app',
  caller_name text,
  caller_phone text,
  caller_line_id text,
  caller_email text,
  contact_role text,
  contact_user_id uuid references app_users(id) on delete set null,
  transcript text not null default '',
  intent text not null default 'unknown',
  confidence numeric(5,4) default 0,
  summary text,
  status text not null default 'needs_review',
  risk_level text not null default 'low',
  created_by uuid references app_users(id) on delete set null,
  approved_by uuid references app_users(id) on delete set null,
  approved_at timestamptz,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table ai_conversations add column if not exists customer_id uuid references customers(id) on delete set null;
alter table ai_conversations add column if not exists elder_id uuid references elders(id) on delete set null;
alter table ai_conversations add column if not exists caller_name text;
alter table ai_conversations add column if not exists caller_phone text;
alter table ai_conversations add column if not exists caller_line_id text;
alter table ai_conversations add column if not exists caller_email text;
alter table ai_conversations add column if not exists contact_role text;
alter table ai_conversations add column if not exists contact_user_id uuid references app_users(id) on delete set null;
alter table ai_conversations add column if not exists created_by uuid references app_users(id) on delete set null;
alter table ai_conversations add column if not exists approved_by uuid references app_users(id) on delete set null;
alter table ai_conversations add column if not exists approved_at timestamptz;
alter table ai_conversations add column if not exists payload jsonb default '{}'::jsonb;
alter table ai_conversations add column if not exists updated_at timestamptz default now();
alter table ai_conversations alter column source_channel set default 'in_app';
alter table ai_conversations alter column transcript set default '';
alter table ai_conversations alter column intent set default 'unknown';
alter table ai_conversations alter column status set default 'needs_review';
alter table ai_conversations drop constraint if exists ai_conversations_source_channel_check;
alter table ai_conversations add constraint ai_conversations_source_channel_check check (
  source_channel in ('phone','line','whatsapp','web_chat','in_app','email','sms','other')
);
alter table ai_conversations drop constraint if exists ai_conversations_confidence_check;
alter table ai_conversations add constraint ai_conversations_confidence_check check (
  confidence is null or (confidence >= 0 and confidence <= 1)
);
alter table ai_conversations drop constraint if exists ai_conversations_status_check;
alter table ai_conversations add constraint ai_conversations_status_check check (
  status in ('captured','triaged','pending_admin','needs_review','auto_resolved','verified','approved','rejected','actioned','notified','closed','failed')
);
alter table ai_conversations drop constraint if exists ai_conversations_risk_level_check;
alter table ai_conversations add constraint ai_conversations_risk_level_check check (
  risk_level in ('low','medium','high','critical')
);

create table if not exists ai_admin_tasks (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid references ai_conversations(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  task_type text not null default 'admin_review',
  title text not null,
  summary text,
  risk_level text not null default 'low',
  required_checks jsonb default '[]'::jsonb,
  approval_status text not null default 'pending',
  status text not null default 'open',
  assigned_to uuid references app_users(id) on delete set null,
  due_at timestamptz,
  approved_by uuid references app_users(id) on delete set null,
  approved_at timestamptz,
  completed_at timestamptz,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table ai_admin_tasks add column if not exists task_type text default 'admin_review';
alter table ai_admin_tasks add column if not exists summary text;
alter table ai_admin_tasks add column if not exists status text default 'open';
alter table ai_admin_tasks add column if not exists assigned_to uuid references app_users(id) on delete set null;
alter table ai_admin_tasks add column if not exists payload jsonb default '{}'::jsonb;
alter table ai_admin_tasks add column if not exists updated_at timestamptz default now();
alter table ai_admin_tasks alter column task_type set default 'admin_review';
alter table ai_admin_tasks alter column status set default 'open';
alter table ai_admin_tasks drop constraint if exists ai_admin_tasks_risk_level_check;
alter table ai_admin_tasks add constraint ai_admin_tasks_risk_level_check check (
  risk_level in ('low','medium','high','critical')
);
alter table ai_admin_tasks drop constraint if exists ai_admin_tasks_approval_status_check;
alter table ai_admin_tasks add constraint ai_admin_tasks_approval_status_check check (
  approval_status in ('not_required','pending','needs_review','approved','rejected','completed','cancelled')
);
alter table ai_admin_tasks drop constraint if exists ai_admin_tasks_status_check;
alter table ai_admin_tasks add constraint ai_admin_tasks_status_check check (
  status in ('open','completed','cancelled')
);
alter table ai_admin_tasks drop constraint if exists ai_admin_tasks_required_checks_array_check;
alter table ai_admin_tasks add constraint ai_admin_tasks_required_checks_array_check check (
  jsonb_typeof(required_checks) = 'array'
);

create table if not exists realtime_events (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  conversation_id uuid references ai_conversations(id) on delete cascade,
  task_id uuid references ai_admin_tasks(id) on delete cascade,
  actor_user_id uuid references app_users(id) on delete set null,
  actor_role text,
  recipient_role text,
  event_type text not null,
  event_payload jsonb default '{}'::jsonb,
  delivery_status text not null default 'queued',
  created_at timestamptz default now()
);

alter table realtime_events add column if not exists conversation_id uuid references ai_conversations(id) on delete cascade;
alter table realtime_events add column if not exists task_id uuid references ai_admin_tasks(id) on delete cascade;
alter table realtime_events add column if not exists event_payload jsonb default '{}'::jsonb;
alter table realtime_events drop constraint if exists realtime_events_delivery_status_check;
alter table realtime_events add constraint realtime_events_delivery_status_check check (
  delivery_status in ('queued','sent','delivered','read','acknowledged','failed','skipped')
);

create table if not exists party_presence (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  party_role text not null,
  party_name text,
  channel text not null default 'in_app',
  recipient_user_id uuid references app_users(id) on delete set null,
  status text not null default 'offline',
  last_seen_at timestamptz default now(),
  last_acknowledged_event_id uuid references realtime_events(id) on delete set null,
  acknowledged_at timestamptz,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table party_presence add column if not exists party_name text;
alter table party_presence add column if not exists recipient_user_id uuid references app_users(id) on delete set null;
alter table party_presence add column if not exists last_acknowledged_event_id uuid references realtime_events(id) on delete set null;
alter table party_presence add column if not exists acknowledged_at timestamptz;
alter table party_presence add column if not exists payload jsonb default '{}'::jsonb;
alter table party_presence add column if not exists updated_at timestamptz default now();
alter table party_presence drop constraint if exists party_presence_status_check;
alter table party_presence add constraint party_presence_status_check check (
  status in ('offline','online','seen','acknowledged','pendingConfirm','pending_confirm','pending','unreachable','needs_followup')
);

create table if not exists verification_checks (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid references ai_conversations(id) on delete cascade,
  task_id uuid references ai_admin_tasks(id) on delete cascade,
  booking_id uuid references bookings(id) on delete cascade,
  check_type text not null,
  status text not null default 'pending',
  required boolean default true,
  evidence jsonb default '{}'::jsonb,
  notes text,
  verified_by uuid references app_users(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz default now()
);

alter table verification_checks add column if not exists required boolean default true;
alter table verification_checks add column if not exists evidence jsonb default '{}'::jsonb;
alter table verification_checks add column if not exists notes text;
alter table verification_checks add column if not exists verified_by uuid references app_users(id) on delete set null;
alter table verification_checks add column if not exists verified_at timestamptz;
alter table verification_checks drop constraint if exists verification_checks_status_check;
alter table verification_checks add constraint verification_checks_status_check check (
  status in ('pending','approved','rejected','passed','failed','warning','skipped')
);

create index if not exists idx_ai_conversations_booking_status_created on ai_conversations(booking_id, status, created_at desc);
create index if not exists idx_ai_conversations_risk_status on ai_conversations(risk_level, status);
create index if not exists idx_ai_admin_tasks_booking_status_due on ai_admin_tasks(booking_id, approval_status, due_at);
create index if not exists idx_ai_admin_tasks_conversation on ai_admin_tasks(conversation_id);
create index if not exists idx_ai_admin_tasks_assigned_status on ai_admin_tasks(assigned_to, approval_status);
create index if not exists idx_realtime_events_booking_created on realtime_events(booking_id, created_at desc);
create index if not exists idx_realtime_events_task_created on realtime_events(task_id, created_at desc);
create index if not exists idx_realtime_events_conversation_created on realtime_events(conversation_id, created_at desc);
create index if not exists idx_party_presence_booking_role on party_presence(booking_id, party_role);
create index if not exists idx_party_presence_recipient_status on party_presence(recipient_user_id, status);
create unique index if not exists idx_party_presence_booking_role_recipient_channel on party_presence(booking_id, party_role, recipient_user_id, channel);
create index if not exists idx_verification_checks_task_status on verification_checks(task_id, status);
create index if not exists idx_verification_checks_booking_type_status on verification_checks(booking_id, check_type, status);

alter table ai_conversations enable row level security;
alter table ai_admin_tasks enable row level security;
alter table realtime_events enable row level security;
alter table party_presence enable row level security;
alter table verification_checks enable row level security;

drop policy if exists ai_conversations_admin_access on ai_conversations;
create policy ai_conversations_admin_access on ai_conversations
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists ai_admin_tasks_admin_access on ai_admin_tasks;
create policy ai_admin_tasks_admin_access on ai_admin_tasks
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists ai_admin_tasks_owner_read on ai_admin_tasks;
create policy ai_admin_tasks_owner_read on ai_admin_tasks
for select using (assigned_to = current_app_user_id());

drop policy if exists realtime_events_admin_access on realtime_events;
create policy realtime_events_admin_access on realtime_events
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists party_presence_admin_access on party_presence;
create policy party_presence_admin_access on party_presence
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists party_presence_recipient_read on party_presence;
create policy party_presence_recipient_read on party_presence
for select using (recipient_user_id = current_app_user_id());

drop policy if exists party_presence_recipient_update on party_presence;
create policy party_presence_recipient_update on party_presence
for update using (recipient_user_id = current_app_user_id())
with check (recipient_user_id = current_app_user_id());

drop policy if exists verification_checks_admin_access on verification_checks;
create policy verification_checks_admin_access on verification_checks
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists verification_checks_booking_party_read on verification_checks;
create policy verification_checks_booking_party_read on verification_checks
for select using (
  verified_by = current_app_user_id()
  or exists (
    select 1
    from assignments a
    left join drivers d on d.id = a.driver_id
    where a.booking_id = verification_checks.booking_id
      and (a.care_assistant_id = current_app_user_id() or d.user_id = current_app_user_id())
  )
);
