-- ElderCare ERP production hardening: Supabase RLS policies
-- Apply after 001_schema.sql. Backend service-role traffic bypasses RLS, while
-- browser/client Supabase access must use JWT claims:
--   app_role: owner|admin|dispatcher|driver|care_assistant|trainer|finance
--   app_user_id: app_users.id

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

create or replace function is_admin_role()
returns boolean
language sql
stable
as $$
  select current_app_role() in ('owner', 'admin');
$$;

create index if not exists idx_drivers_user_id on drivers(user_id);
create index if not exists idx_assignments_driver_id on assignments(driver_id);
create index if not exists idx_assignments_care_assistant_id on assignments(care_assistant_id);
create index if not exists idx_bookings_customer_id on bookings(customer_id);
create index if not exists idx_bookings_elder_id on bookings(elder_id);
create index if not exists idx_trip_events_booking_id on trip_events(booking_id);
create index if not exists idx_trip_checklists_booking_id on trip_checklists(booking_id);
create index if not exists idx_audit_logs_entity on audit_logs(entity_type, entity_id);

alter table app_users enable row level security;
alter table customers enable row level security;
alter table elders enable row level security;
alter table bookings enable row level security;
alter table assignments enable row level security;
alter table trip_events enable row level security;
alter table trip_checklists enable row level security;
alter table payments enable row level security;
alter table invoices enable row level security;
alter table refunds enable row level security;
alter table notifications enable row level security;
alter table pdpa_consents enable row level security;
alter table audit_logs enable row level security;
alter table ai_conversations enable row level security;
alter table ai_admin_tasks enable row level security;
alter table realtime_events enable row level security;
alter table party_presence enable row level security;
alter table verification_checks enable row level security;

drop policy if exists app_users_read_scope on app_users;
create policy app_users_read_scope on app_users
for select using (
  is_admin_role()
  or id = current_app_user_id()
  or current_app_role() in ('dispatcher', 'trainer', 'finance')
);

drop policy if exists customers_internal_read on customers;
create policy customers_internal_read on customers
for select using (current_app_role() in ('owner', 'admin', 'dispatcher', 'finance'));

drop policy if exists customers_internal_write on customers;
create policy customers_internal_write on customers
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists elders_minimum_needed_read on elders;
create policy elders_minimum_needed_read on elders
for select using (current_app_role() in ('owner', 'admin', 'dispatcher', 'care_assistant'));

drop policy if exists elders_internal_write on elders;
create policy elders_internal_write on elders
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists bookings_role_read on bookings;
create policy bookings_role_read on bookings
for select using (
  current_app_role() in ('owner', 'admin', 'dispatcher', 'finance')
  or exists (
    select 1
    from assignments a
    join drivers d on d.id = a.driver_id
    where a.booking_id = bookings.id
      and d.user_id = current_app_user_id()
  )
  or exists (
    select 1
    from assignments a
    where a.booking_id = bookings.id
      and a.care_assistant_id = current_app_user_id()
  )
);

drop policy if exists bookings_dispatch_write on bookings;
create policy bookings_dispatch_write on bookings
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists assignments_role_read on assignments;
create policy assignments_role_read on assignments
for select using (
  current_app_role() in ('owner', 'admin', 'dispatcher')
  or care_assistant_id = current_app_user_id()
  or exists (
    select 1 from drivers d
    where d.id = assignments.driver_id
      and d.user_id = current_app_user_id()
  )
);

drop policy if exists assignments_dispatch_write on assignments;
create policy assignments_dispatch_write on assignments
for all using (current_app_role() in ('owner', 'admin', 'dispatcher', 'driver'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher', 'driver'));

drop policy if exists trip_events_role_read on trip_events;
create policy trip_events_role_read on trip_events
for select using (
  current_app_role() in ('owner', 'admin', 'dispatcher')
  or exists (
    select 1
    from assignments a
    left join drivers d on d.id = a.driver_id
    where a.booking_id = trip_events.booking_id
      and (a.care_assistant_id = current_app_user_id() or d.user_id = current_app_user_id())
  )
);

drop policy if exists trip_events_field_write on trip_events;
create policy trip_events_field_write on trip_events
for insert with check (current_app_role() in ('owner', 'admin', 'dispatcher', 'driver', 'care_assistant'));

drop policy if exists trip_checklists_role_access on trip_checklists;
create policy trip_checklists_role_access on trip_checklists
for all using (current_app_role() in ('owner', 'admin', 'dispatcher', 'driver', 'care_assistant'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher', 'driver', 'care_assistant'));

drop policy if exists finance_read on invoices;
create policy finance_read on invoices for select using (current_app_role() in ('owner', 'admin', 'finance'));
drop policy if exists finance_write on invoices;
create policy finance_write on invoices for all using (current_app_role() in ('owner', 'admin', 'finance')) with check (current_app_role() in ('owner', 'admin', 'finance'));

drop policy if exists payments_finance_read on payments;
create policy payments_finance_read on payments for select using (current_app_role() in ('owner', 'admin', 'finance'));
drop policy if exists payments_finance_write on payments;
create policy payments_finance_write on payments for all using (current_app_role() in ('owner', 'admin', 'finance')) with check (current_app_role() in ('owner', 'admin', 'finance'));

drop policy if exists refunds_finance_access on refunds;
create policy refunds_finance_access on refunds for all using (current_app_role() in ('owner', 'admin', 'finance')) with check (current_app_role() in ('owner', 'admin', 'finance'));

drop policy if exists notifications_role_read on notifications;
create policy notifications_role_read on notifications
for select using (
  current_app_role() in ('owner', 'admin', 'dispatcher', 'finance')
  or recipient_user_id = current_app_user_id()
);

drop policy if exists notifications_role_write on notifications;
create policy notifications_role_write on notifications
for all using (current_app_role() in ('owner', 'admin', 'dispatcher', 'finance'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher', 'finance'));

drop policy if exists pdpa_guard_access on pdpa_consents;
create policy pdpa_guard_access on pdpa_consents
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists audit_admin_read on audit_logs;
create policy audit_admin_read on audit_logs
for select using (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists audit_internal_insert on audit_logs;
create policy audit_internal_insert on audit_logs
for insert with check (current_app_role() in ('owner', 'admin', 'dispatcher', 'driver', 'care_assistant', 'trainer', 'finance'));

drop policy if exists ai_conversations_admin_access on ai_conversations;
create policy ai_conversations_admin_access on ai_conversations
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists ai_conversations_author_read on ai_conversations;
create policy ai_conversations_author_read on ai_conversations
for select using (created_by = current_app_user_id());

drop policy if exists ai_conversations_internal_insert on ai_conversations;
create policy ai_conversations_internal_insert on ai_conversations
for insert with check (
  current_app_role() in ('owner', 'admin', 'dispatcher')
  or (
    current_app_role() in ('driver', 'care_assistant', 'trainer', 'finance')
    and created_by = current_app_user_id()
  )
);

drop policy if exists ai_admin_tasks_admin_access on ai_admin_tasks;
create policy ai_admin_tasks_admin_access on ai_admin_tasks
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists ai_admin_tasks_owner_read on ai_admin_tasks;
create policy ai_admin_tasks_owner_read on ai_admin_tasks
for select using (
  assigned_to = current_app_user_id()
  or owner_user_id = current_app_user_id()
);

drop policy if exists realtime_events_admin_access on realtime_events;
create policy realtime_events_admin_access on realtime_events
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists realtime_events_booking_party_read on realtime_events;
create policy realtime_events_booking_party_read on realtime_events
for select using (
  actor_user_id = current_app_user_id()
  or exists (
    select 1
    from assignments a
    left join drivers d on d.id = a.driver_id
    where a.booking_id = realtime_events.booking_id
      and (a.care_assistant_id = current_app_user_id() or d.user_id = current_app_user_id())
  )
);

drop policy if exists realtime_events_internal_insert on realtime_events;
create policy realtime_events_internal_insert on realtime_events
for insert with check (
  current_app_role() in ('owner', 'admin', 'dispatcher')
  or (
    current_app_role() in ('driver', 'care_assistant', 'trainer', 'finance')
    and actor_user_id = current_app_user_id()
  )
);

drop policy if exists party_presence_admin_access on party_presence;
create policy party_presence_admin_access on party_presence
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists party_presence_recipient_read on party_presence;
create policy party_presence_recipient_read on party_presence
for select using (recipient_user_id = current_app_user_id());

drop policy if exists party_presence_booking_party_read on party_presence;
create policy party_presence_booking_party_read on party_presence
for select using (
  exists (
    select 1
    from assignments a
    left join drivers d on d.id = a.driver_id
    where a.booking_id = party_presence.booking_id
      and (a.care_assistant_id = current_app_user_id() or d.user_id = current_app_user_id())
  )
);

drop policy if exists party_presence_recipient_upsert on party_presence;
drop policy if exists party_presence_recipient_insert on party_presence;
create policy party_presence_recipient_insert on party_presence
for insert
with check (
  current_app_role() in ('driver', 'care_assistant', 'trainer', 'finance')
  and recipient_user_id = current_app_user_id()
);

drop policy if exists party_presence_recipient_update on party_presence;
create policy party_presence_recipient_update on party_presence
for update using (recipient_user_id = current_app_user_id())
with check (
  current_app_role() in ('driver', 'care_assistant', 'trainer', 'finance')
  and recipient_user_id = current_app_user_id()
);

drop policy if exists verification_checks_admin_access on verification_checks;
create policy verification_checks_admin_access on verification_checks
for all using (current_app_role() in ('owner', 'admin', 'dispatcher'))
with check (current_app_role() in ('owner', 'admin', 'dispatcher'));

drop policy if exists verification_checks_booking_party_read on verification_checks;
create policy verification_checks_booking_party_read on verification_checks
for select using (
  verified_by = current_app_user_id()
  or checked_by = current_app_user_id()
  or exists (
    select 1
    from assignments a
    left join drivers d on d.id = a.driver_id
    where a.booking_id = verification_checks.booking_id
      and (a.care_assistant_id = current_app_user_id() or d.user_id = current_app_user_id())
  )
);

drop policy if exists verification_checks_assigned_internal_insert on verification_checks;
create policy verification_checks_assigned_internal_insert on verification_checks
for insert with check (
  current_app_role() in ('owner', 'admin', 'dispatcher')
  or (
    current_app_role() in ('driver', 'care_assistant')
    and (verified_by = current_app_user_id() or checked_by = current_app_user_id())
    and exists (
      select 1
      from assignments a
      left join drivers d on d.id = a.driver_id
      where a.booking_id = verification_checks.booking_id
        and (a.care_assistant_id = current_app_user_id() or d.user_id = current_app_user_id())
    )
  )
);
