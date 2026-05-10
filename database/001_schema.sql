
-- ElderCare Transport ERP Starter v1
-- PostgreSQL / Supabase compatible

create extension if not exists "uuid-ossp";

create table if not exists companies (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  tax_id text,
  phone text,
  email text,
  address text,
  created_at timestamptz default now()
);

create table if not exists branches (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id) on delete cascade,
  name text not null,
  phone text,
  address text,
  service_area jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists app_users (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  branch_id uuid references branches(id),
  full_name text not null,
  phone text,
  email text unique,
  role text not null check (role in ('owner','super_admin','admin','branch_admin','dispatcher','coordinator','driver','care_assistant','hospital_companion','home_companion','trainer','finance','family_viewer')),
  status text default 'active' check (status in ('active','inactive','suspended')),
  created_at timestamptz default now()
);

create table if not exists customers (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  full_name text not null,
  phone text,
  line_id text,
  email text,
  relationship_to_elder text,
  address text,
  created_at timestamptz default now()
);

create table if not exists elders (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  customer_id uuid references customers(id),
  full_name text not null,
  nickname text,
  birth_date date,
  gender text,
  mobility_level text check (mobility_level in ('walk_independent','cane','walker','wheelchair','bed_to_wheelchair')),
  medical_notes text,
  allergies text,
  medication_notes text,
  communication_notes text,
  emergency_contact_name text,
  emergency_contact_phone text,
  pdpa_sensitive_consent boolean default false,
  created_at timestamptz default now()
);

create table if not exists vehicles (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  branch_id uuid references branches(id),
  plate_number text not null,
  province text,
  vehicle_type text check (vehicle_type in ('sedan','suv','van','wheelchair_van')),
  public_transport_license_status text default 'pending',
  insurance_expiry date,
  condition_score int default 80,
  status text default 'available' check (status in ('available','maintenance','inactive')),
  created_at timestamptz default now()
);

create table if not exists drivers (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  branch_id uuid references branches(id),
  user_id uuid references app_users(id),
  full_name text not null,
  phone text not null,
  line_id text,
  driver_level text default 'bronze' check (driver_level in ('bronze','silver','gold','blacklist')),
  status text default 'pending' check (status in ('pending','screening','training','approved','active','suspended','rejected')),
  rating_avg numeric(3,2) default 0,
  total_jobs int default 0,
  joined_at timestamptz default now()
);

create table if not exists driver_documents (
  id uuid primary key default uuid_generate_v4(),
  driver_id uuid references drivers(id) on delete cascade,
  doc_type text not null check (doc_type in ('id_card','driver_license','public_driver_license','criminal_record','vehicle_registration','insurance','training_certificate')),
  file_url text,
  verified boolean default false,
  expiry_date date,
  verified_by uuid references app_users(id),
  verified_at timestamptz
);

create table if not exists driver_screenings (
  id uuid primary key default uuid_generate_v4(),
  driver_id uuid references drivers(id) on delete cascade,
  document_score int default 0,
  interview_score int default 0,
  behavior_score int default 0,
  driving_test_score int default 0,
  total_score int generated always as (document_score + interview_score + behavior_score + driving_test_score) stored,
  result text default 'pending' check (result in ('pending','approved','rejected','retest')),
  notes text,
  approved_by uuid references app_users(id),
  approved_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists training_modules (
  id uuid primary key default uuid_generate_v4(),
  code text unique not null,
  title text not null,
  description text,
  required boolean default true,
  pass_score int default 80,
  sort_order int default 0
);

create table if not exists driver_training_records (
  id uuid primary key default uuid_generate_v4(),
  driver_id uuid references drivers(id) on delete cascade,
  module_id uuid references training_modules(id),
  status text default 'pending' check (status in ('pending','in_progress','completed','failed')),
  score int,
  completed_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists bookings (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  branch_id uuid references branches(id),
  customer_id uuid references customers(id),
  elder_id uuid references elders(id),
  booking_no text unique,
  service_type text not null check (service_type in ('basic_ride','assisted_ride','elderly_transport','hospital_companion','home_companion','medical_coordination','family_monitoring','monthly_transport')),
  pickup_address text not null,
  dropoff_address text not null,
  pickup_at timestamptz not null,
  estimated_return_at timestamptz,
  status text default 'draft' check (status in ('draft','confirmed','assigned','arrived','onboard','in_progress','completed','cancelled','no_show')),
  special_notes text,
  quoted_price numeric(12,2) default 0,
  final_price numeric(12,2) default 0,
  created_at timestamptz default now()
);

create table if not exists assignments (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  driver_id uuid references drivers(id),
  care_assistant_id uuid references app_users(id),
  vehicle_id uuid references vehicles(id),
  assigned_by uuid references app_users(id),
  status text default 'assigned' check (status in ('assigned','accepted','rejected','completed','cancelled')),
  assigned_at timestamptz default now()
);

create table if not exists trip_events (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  assignment_id uuid references assignments(id),
  event_type text not null check (event_type in ('driver_accepted','arrived_pickup','arrived_at_location','identity_verified','pickup_condition_checked','elder_onboard','patient_onboarded','trip_started','service_started','patient_checked_in','in_consultation','lab_or_xray','pharmacy','home_check_in','midpoint_update','home_check_out','coordination_started','coordination_update','coordination_completed','monitoring_started','monitoring_completed','family_update','visit_summary_submitted','arrived_dropoff','handover_completed','trip_completed','completed')),
  event_at timestamptz default now(),
  lat numeric,
  lng numeric,
  photo_url text,
  notes text,
  created_by uuid references app_users(id)
);

create table if not exists incidents (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id),
  driver_id uuid references drivers(id),
  elder_id uuid references elders(id),
  incident_type text not null check (incident_type in ('late','fall','injury','complaint','accident','lost_item','medical_warning','other')),
  severity text not null check (severity in ('low','medium','high','critical')),
  description text not null,
  action_taken text,
  status text default 'open' check (status in ('open','reviewing','closed')),
  created_at timestamptz default now(),
  created_by uuid references app_users(id)
);

create table if not exists ratings (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id),
  driver_id uuid references drivers(id),
  customer_id uuid references customers(id),
  rating int check (rating between 1 and 5),
  comment text,
  created_at timestamptz default now()
);

create table if not exists pdpa_consents (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references customers(id),
  elder_id uuid references elders(id),
  consent_type text not null check (consent_type in ('general_service','sensitive_health','family_notification','photo','location_tracking','marketing')),
  consented boolean not null,
  consent_text_version text,
  consented_at timestamptz default now(),
  ip_address text,
  user_agent text
);

create table if not exists audit_logs (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  actor_user_id uuid references app_users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

insert into training_modules (code,title,description,required,pass_score,sort_order)
values
('ELDERLY_CARE_BASIC','Basic Elderly Care','การดูแลผู้สูงวัยเบื้องต้น การพยุง การสื่อสาร และข้อควรระวัง',true,80,1),
('SAFETY_DRIVING','Safety Driving','การขับรถนุ่มนวล ปลอดภัย ไม่เร่ง ไม่เบรกแรง',true,80,2),
('SERVICE_MINDSET','Service Mindset','มารยาทบริการ ความอดทน และการจัดการสถานการณ์',true,80,3),
('SOP_WORKFLOW','ERP Job SOP','ขั้นตอนรับงาน เช็คอิน รับตัว ส่งถึง และบันทึกหลักฐาน',true,80,4),
('INCIDENT_RESPONSE','Incident Response','การแจ้งเหตุ บันทึกเหตุ และ escalation',true,80,5)
on conflict (code) do nothing;

create index if not exists idx_bookings_pickup_at on bookings(pickup_at);
create index if not exists idx_bookings_status on bookings(status);
create index if not exists idx_drivers_status on drivers(status);
create index if not exists idx_incidents_severity on incidents(severity);

-- SOP Phase 1 foundation
-- These ALTER statements keep the starter schema safe to rerun on an existing Supabase project.

alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check check (
  role in (
    'owner',
    'super_admin',
    'admin',
    'branch_admin',
    'dispatcher',
    'coordinator',
    'driver',
    'care_assistant',
    'hospital_companion',
    'home_companion',
    'trainer',
    'finance',
    'family_viewer'
  )
);

alter table elders add column if not exists walking_ability text;
alter table elders add column if not exists fall_risk text;
alter table elders add column if not exists cognitive_status text;
alter table elders add column if not exists hearing_condition text;
alter table elders add column if not exists vision_condition text;
alter table elders add column if not exists emotional_condition text;
alter table elders add column if not exists chronic_diseases text;
alter table elders add column if not exists hospital_history text;
alter table elders add column if not exists risk_level text;
alter table elders add column if not exists wheelchair_required boolean default false;
alter table elders add column if not exists communication_note text;
alter table elders drop constraint if exists elders_risk_level_check;
alter table elders add constraint elders_risk_level_check check (
  risk_level is null or risk_level in ('low','medium','high','critical')
);

alter table bookings add column if not exists risk_level text;
alter table bookings add column if not exists appointment_at timestamptz;
alter table bookings add column if not exists appointment_place text;
alter table bookings add column if not exists need_care_assistant boolean default false;
alter table bookings add column if not exists need_wheelchair_support boolean default false;
alter table bookings add column if not exists booking_source text;
alter table bookings add column if not exists consent_checked boolean default false;
alter table bookings add column if not exists dispatcher_approved_by uuid references app_users(id);
alter table bookings add column if not exists dispatcher_approved_at timestamptz;
alter table bookings add column if not exists confirmed_at timestamptz;
alter table bookings add column if not exists payment_status text default 'unpaid';
alter table bookings add column if not exists handover_to_name text;
alter table bookings add column if not exists handover_to_phone text;
alter table bookings add column if not exists handover_note text;
alter table bookings add column if not exists hospital_name text;
alter table bookings add column if not exists department text;
alter table bookings add column if not exists doctor_name text;
alter table bookings add column if not exists support_level text;
alter table bookings add column if not exists family_contact_name text;
alter table bookings add column if not exists family_contact_phone text;
alter table bookings add column if not exists preferred_communication_channel text;
alter table bookings add column if not exists booking_confirmed boolean default false;
alter table bookings add column if not exists confirmation_time timestamptz;
alter table bookings add column if not exists coordinator_id uuid references app_users(id);
alter table bookings add column if not exists workflow_template_code text;
alter table bookings add column if not exists workflow_snapshot jsonb default '{}'::jsonb;
alter table bookings add column if not exists family_notified_at timestamptz;
alter table bookings add column if not exists service_completed_at timestamptz;
alter table bookings add column if not exists completion_blocked_reason text;

alter table bookings drop constraint if exists bookings_service_type_check;
alter table bookings add constraint bookings_service_type_check check (
  service_type in (
    'basic_ride',
    'assisted_ride',
    'elderly_transport',
    'hospital_companion',
    'home_companion',
    'medical_coordination',
    'family_monitoring',
    'monthly_transport'
  )
);

alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check check (
  status in (
    'draft',
    'pending_dispatch_approval',
    'confirmed',
    'assigned',
    'arrived',
    'onboard',
    'in_progress',
    'waiting_return',
    'completed',
    'cancelled',
    'no_show',
    'incident_hold'
  )
);
alter table bookings drop constraint if exists bookings_risk_level_check;
alter table bookings add constraint bookings_risk_level_check check (
  risk_level is null or risk_level in ('low','medium','high','critical')
);
alter table bookings drop constraint if exists bookings_payment_status_check;
alter table bookings add constraint bookings_payment_status_check check (
  payment_status in ('unpaid','deposit_paid','paid','refunded','partial_refunded')
);

alter table assignments add column if not exists assignment_score numeric;
alter table assignments add column if not exists assignment_reason text;
alter table assignments add column if not exists accepted_at timestamptz;
alter table assignments add column if not exists rejected_reason text;
alter table assignments add column if not exists notification_payload jsonb default '{}'::jsonb;

alter table pdpa_consents drop constraint if exists pdpa_consents_consent_type_check;
alter table pdpa_consents add constraint pdpa_consents_consent_type_check check (
  consent_type in ('general_service','sensitive_health','family_notification','photo','location_tracking','marketing')
);

alter table trip_events add column if not exists event_payload jsonb default '{}'::jsonb;
alter table trip_events drop constraint if exists trip_events_event_type_check;
alter table trip_events add constraint trip_events_event_type_check check (
  event_type in (
    'driver_accepted',
    'arrived_pickup',
    'arrived_at_location',
    'identity_verified',
    'pickup_condition_checked',
    'elder_onboard',
    'patient_onboarded',
    'trip_started',
    'service_started',
    'patient_checked_in',
    'in_consultation',
    'lab_or_xray',
    'pharmacy',
    'home_check_in',
    'midpoint_update',
    'home_check_out',
    'coordination_started',
    'coordination_update',
    'coordination_completed',
    'monitoring_started',
    'monitoring_completed',
    'family_update',
    'visit_summary_submitted',
    'arrived_dropoff',
    'handover_completed',
    'trip_completed',
    'completed',
    'exception_opened',
    'return_pickup',
    'return_trip_started',
    'return_handover_completed'
  )
);

alter table incidents add column if not exists reported_at timestamptz;
alter table incidents add column if not exists reported_by uuid references app_users(id);
alter table incidents add column if not exists resolved_by uuid references app_users(id);
alter table incidents add column if not exists resolved_at timestamptz;
alter table incidents add column if not exists root_cause text;
alter table incidents add column if not exists preventive_action text;
alter table incidents add column if not exists customer_notified boolean default false;
alter table incidents add column if not exists emergency_contact_notified boolean default false;
alter table incidents add column if not exists regulatory_report_required boolean default false;
alter table incidents add column if not exists location text;
alter table incidents add column if not exists witnesses text;
alter table incidents add column if not exists attachment_url text;
alter table incidents add column if not exists family_notified_at timestamptz;
alter table incidents add column if not exists admin_notified_at timestamptz;
alter table incidents add column if not exists emergency_services_contacted boolean default false;
alter table incidents add column if not exists closure_frozen boolean default false;
alter table incidents drop constraint if exists incidents_incident_type_check;
alter table incidents add constraint incidents_incident_type_check check (
  incident_type in (
    'late',
    'fall',
    'injury',
    'complaint',
    'accident',
    'lost_item',
    'medical_warning',
    'no_show',
    'wrong_location',
    'privacy_issue',
    'other'
  )
);
alter table incidents drop constraint if exists incidents_status_check;
alter table incidents add constraint incidents_status_check check (status in ('open','reviewing','escalated','closed'));

alter table drivers drop constraint if exists drivers_status_check;
alter table drivers add constraint drivers_status_check check (
  status in ('pending','screening','training','approved','active','reviewing','inactive','suspended','rejected')
);

alter table driver_screenings add column if not exists critical_fail boolean default false;
alter table driver_screenings add column if not exists critical_fail_reason text;
alter table driver_screenings add column if not exists interview_payload jsonb default '{}'::jsonb;
alter table driver_screenings add column if not exists driving_test_payload jsonb default '{}'::jsonb;
alter table driver_screenings add column if not exists roleplay_payload jsonb default '{}'::jsonb;

alter table training_modules add column if not exists module_type text default 'required';
alter table training_modules add column if not exists version text default '1.0';
alter table training_modules add column if not exists content_url text;
alter table training_modules add column if not exists quiz_required boolean default true;
alter table training_modules add column if not exists max_attempts int default 3;

create table if not exists service_price_rules (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  branch_id uuid references branches(id),
  service_type text not null check (service_type in ('basic_ride','assisted_ride','elderly_transport','hospital_companion','home_companion','medical_coordination','family_monitoring','monthly_transport')),
  base_fee numeric(12,2) default 0,
  per_km_fee numeric(12,2) default 0,
  waiting_fee_per_hour numeric(12,2) default 0,
  care_assistant_fee numeric(12,2) default 0,
  wheelchair_fee numeric(12,2) default 0,
  hospital_companion_fee numeric(12,2) default 0,
  out_of_area_fee numeric(12,2) default 0,
  after_hours_multiplier numeric(6,2) default 1,
  holiday_multiplier numeric(6,2) default 1,
  active boolean default true,
  created_at timestamptz default now()
);

alter table service_price_rules drop constraint if exists service_price_rules_service_type_check;
alter table service_price_rules add constraint service_price_rules_service_type_check check (
  service_type in (
    'basic_ride',
    'assisted_ride',
    'elderly_transport',
    'hospital_companion',
    'home_companion',
    'medical_coordination',
    'family_monitoring',
    'monthly_transport'
  )
);

create table if not exists booking_quotes (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  quote_no text unique not null,
  subtotal numeric(12,2) default 0,
  discount numeric(12,2) default 0,
  tax numeric(12,2) default 0,
  total numeric(12,2) default 0,
  quote_status text default 'draft' check (quote_status in ('draft','approved','rejected','expired')),
  approved_by uuid references app_users(id),
  approved_at timestamptz,
  expires_at timestamptz,
  pricing_snapshot jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists trip_checklists (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  assignment_id uuid references assignments(id),
  checklist_type text not null check (checklist_type in ('pre_trip','pickup','dropoff','t24_confirmation','t2_review','pre_visit','home_entry','vehicle_inspection','branch_opening','branch_closing')),
  items jsonb default '[]'::jsonb,
  completed boolean default false,
  completed_by uuid references app_users(id),
  completed_at timestamptz,
  created_at timestamptz default now()
);

alter table trip_checklists drop constraint if exists trip_checklists_checklist_type_check;
alter table trip_checklists add constraint trip_checklists_checklist_type_check check (
  checklist_type in ('pre_trip','pickup','dropoff','t24_confirmation','t2_review','pre_visit','home_entry','vehicle_inspection','branch_opening','branch_closing')
);

create table if not exists trip_locations (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  assignment_id uuid references assignments(id),
  lat numeric,
  lng numeric,
  speed numeric,
  recorded_at timestamptz default now()
);

create table if not exists booking_segments (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  segment_type text not null check (segment_type in ('outbound','return','extra_stop')),
  pickup_address text not null,
  dropoff_address text not null,
  scheduled_at timestamptz,
  status text default 'draft' check (status in ('draft','scheduled','in_progress','waiting','completed','cancelled')),
  sequence_no int default 1,
  created_at timestamptz default now()
);

create table if not exists booking_cancellations (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  cancelled_by_role text,
  cancelled_by_user_id uuid references app_users(id),
  reason_code text not null,
  reason_text text,
  fee_amount numeric(12,2) default 0,
  evidence jsonb default '{}'::jsonb,
  cancelled_at timestamptz default now()
);

create table if not exists leads (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id),
  branch_id uuid references branches(id),
  lead_source text,
  contact_name text not null,
  contact_phone text,
  elder_name text,
  service_interest text,
  preferred_date timestamptz,
  urgency_level text default 'normal' check (urgency_level in ('low','normal','urgent','critical')),
  status text default 'new' check (status in ('new','contacted','qualified','converted','closed')),
  assigned_coordinator_id uuid references app_users(id),
  customer_id uuid references customers(id),
  elder_id uuid references elders(id),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists elder_assessments (
  id uuid primary key default uuid_generate_v4(),
  elder_id uuid references elders(id) on delete cascade,
  assessed_by uuid references app_users(id),
  walking_ability text,
  fall_risk text,
  cognitive_status text,
  hearing_condition text,
  vision_condition text,
  emotional_condition text,
  chronic_diseases text,
  allergies text,
  current_medication text,
  hospital_history text,
  wheelchair_required boolean default false,
  communication_note text,
  support_requirement jsonb default '{}'::jsonb,
  risk_level text check (risk_level in ('low','medium','high','critical')),
  assessed_at timestamptz default now()
);

create table if not exists booking_workflows (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  service_type text not null,
  template_code text not null,
  required_events jsonb default '[]'::jsonb,
  optional_events jsonb default '[]'::jsonb,
  required_checklists jsonb default '[]'::jsonb,
  summary_required boolean default false,
  generated_by uuid references app_users(id),
  generated_at timestamptz default now(),
  status text default 'active' check (status in ('active','superseded','cancelled'))
);

create table if not exists family_updates (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  elder_id uuid references elders(id),
  update_type text not null default 'family_update' check (update_type in ('booking_confirmed','staff_assigned','service_started','consultation_started','pharmacy_completed','service_completed','family_update','incident_update','midpoint_update')),
  channel text default 'in_app',
  message text not null,
  factual_only boolean default true,
  sent_by uuid references app_users(id),
  sent_at timestamptz default now(),
  recipient_name text,
  recipient_contact text,
  payload jsonb default '{}'::jsonb
);

create table if not exists visit_summaries (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  elder_id uuid references elders(id),
  prepared_by uuid references app_users(id),
  visit_outcome text not null,
  medication_pickup_status text,
  next_appointment timestamptz,
  follow_up_requirement text,
  family_summary text not null,
  staff_concern text,
  hidden_operational_note text,
  status text default 'submitted' check (status in ('draft','submitted','approved','rejected')),
  submitted_at timestamptz default now(),
  approved_by uuid references app_users(id),
  approved_at timestamptz,
  rejected_reason text,
  created_at timestamptz default now()
);

create table if not exists branch_operation_checklists (
  id uuid primary key default uuid_generate_v4(),
  branch_id uuid references branches(id) on delete cascade,
  checklist_type text not null check (checklist_type in ('opening','closing')),
  checklist_date date not null default current_date,
  items jsonb default '[]'::jsonb,
  completed boolean default false,
  completed_by uuid references app_users(id),
  completed_at timestamptz,
  unresolved_issues jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

create table if not exists sla_escalations (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  incident_id uuid references incidents(id) on delete set null,
  escalation_type text not null check (escalation_type in ('staff_late','no_update','high_incident','booking_incomplete','summary_late','family_response')),
  severity text default 'medium' check (severity in ('low','medium','high','critical')),
  status text default 'open' check (status in ('open','acknowledged','resolved','cancelled')),
  due_at timestamptz,
  triggered_at timestamptz default now(),
  acknowledged_by uuid references app_users(id),
  acknowledged_at timestamptz,
  resolved_by uuid references app_users(id),
  resolved_at timestamptz,
  payload jsonb default '{}'::jsonb
);

create table if not exists training_attempts (
  id uuid primary key default uuid_generate_v4(),
  driver_id uuid references drivers(id) on delete cascade,
  module_id uuid references training_modules(id),
  attempt_no int default 1,
  score int,
  answers jsonb default '{}'::jsonb,
  passed boolean default false,
  attempted_at timestamptz default now()
);

create table if not exists driver_quality_reviews (
  id uuid primary key default uuid_generate_v4(),
  driver_id uuid references drivers(id) on delete cascade,
  review_period_start date not null,
  review_period_end date not null,
  jobs_completed int default 0,
  avg_rating numeric(3,2) default 0,
  on_time_rate numeric(5,2) default 0,
  incident_count int default 0,
  complaint_count int default 0,
  review_result text,
  reviewed_by uuid references app_users(id),
  reviewed_at timestamptz default now()
);

create table if not exists payments (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  payment_method text,
  amount numeric(12,2) not null,
  payment_status text default 'unpaid' check (payment_status in ('unpaid','deposit_paid','paid','refunded','partial_refunded')),
  paid_at timestamptz,
  transaction_ref text,
  evidence_url text,
  created_at timestamptz default now()
);

create table if not exists invoices (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  invoice_no text unique not null,
  customer_id uuid references customers(id),
  subtotal numeric(12,2) default 0,
  tax numeric(12,2) default 0,
  total numeric(12,2) default 0,
  status text default 'draft' check (status in ('draft','issued','paid','void')),
  issued_at timestamptz default now()
);

create table if not exists refunds (
  id uuid primary key default uuid_generate_v4(),
  payment_id uuid references payments(id) on delete cascade,
  booking_id uuid references bookings(id) on delete cascade,
  amount numeric(12,2) not null,
  reason text not null,
  approved_by uuid references app_users(id),
  approved_at timestamptz,
  status text default 'pending' check (status in ('pending','approved','rejected','paid')),
  created_at timestamptz default now()
);

create table if not exists notifications (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid references bookings(id) on delete cascade,
  assignment_id uuid references assignments(id),
  recipient_user_id uuid references app_users(id),
  channel text default 'in_app',
  notification_type text not null,
  payload jsonb default '{}'::jsonb,
  status text default 'queued' check (status in ('queued','sent','failed','read')),
  created_at timestamptz default now(),
  sent_at timestamptz
);

insert into training_modules (code,title,description,required,pass_score,sort_order,module_type,version,quiz_required,max_attempts)
values
('SAFE_TRANSFER_MOBILITY','Safe Transfer & Mobility Support','การพยุงขึ้นลงรถ การใช้ walker/wheelchair และการประเมินความพร้อมแบบ non-medical',true,80,6,'required','1.0',true,3),
('PDPA_PRIVACY','PDPA & Privacy','การใช้ข้อมูลเท่าที่จำเป็น การปกปิดข้อมูลสุขภาพ และการบันทึก audit trail',true,80,7,'required','1.0',true,3),
('HOSPITAL_COMPANION','Hospital Companion Workflow','การพาเข้ารพ./คลินิก ประสานงานเบื้องต้น รอรับยา และ handover note',true,80,8,'advanced','1.0',true,3),
('HOME_COMPANION','Home Companion Workflow','การเข้าเยี่ยมที่บ้าน การอัปเดตครอบครัว และข้อห้ามด้านการแพทย์/ทรัพย์สิน',true,80,9,'advanced','2.0',true,3),
('FAMILY_COMMUNICATION','Family Communication & Non-diagnostic Updates','การสื่อสารกับครอบครัวแบบ factual, calm, privacy compliant และไม่วินิจฉัยโรค',true,80,10,'required','2.0',true,3),
('SOP_V2_INCIDENT_ESCALATION','SOP v2 Incident Escalation','ขั้นตอน freeze closure, แจ้งครอบครัว/แอดมิน และบันทึกหลักฐานครบถ้วน',true,80,11,'required','2.0',true,3)
on conflict (code) do nothing;

insert into service_price_rules (
  id,
  service_type,
  base_fee,
  per_km_fee,
  waiting_fee_per_hour,
  care_assistant_fee,
  wheelchair_fee,
  hospital_companion_fee,
  after_hours_multiplier,
  holiday_multiplier,
  active
)
values
('11111111-1111-1111-1111-111111111111','basic_ride',600,28,180,0,0,0,1.25,1.35,true),
('22222222-2222-2222-2222-222222222222','assisted_ride',900,32,220,500,300,0,1.25,1.35,true),
('33333333-3333-3333-3333-333333333333','hospital_companion',1400,35,300,800,400,900,1.30,1.40,true),
('44444444-4444-4444-4444-444444444444','monthly_transport',1000,30,240,600,300,0,1.20,1.30,true),
('55555555-5555-5555-5555-555555555555','elderly_transport',850,32,220,450,300,0,1.25,1.35,true),
('66666666-6666-6666-6666-666666666666','home_companion',1200,0,350,700,0,0,1.20,1.30,true),
('77777777-7777-7777-7777-777777777777','medical_coordination',1500,0,300,0,0,0,1.20,1.30,true),
('88888888-8888-8888-8888-888888888888','family_monitoring',900,0,250,0,0,0,1.15,1.25,true)
on conflict (id) do nothing;

create index if not exists idx_bookings_risk_level on bookings(risk_level);
create index if not exists idx_booking_quotes_booking_status on booking_quotes(booking_id, quote_status);
create index if not exists idx_trip_events_booking_event on trip_events(booking_id, event_type, event_at);
create index if not exists idx_trip_checklists_booking_type on trip_checklists(booking_id, checklist_type);
create index if not exists idx_trip_locations_booking_recorded on trip_locations(booking_id, recorded_at);
create index if not exists idx_booking_segments_booking_seq on booking_segments(booking_id, sequence_no);
create index if not exists idx_booking_cancellations_booking on booking_cancellations(booking_id);
create index if not exists idx_leads_status_source on leads(status, lead_source);
create index if not exists idx_elder_assessments_elder_at on elder_assessments(elder_id, assessed_at desc);
create index if not exists idx_booking_workflows_booking_status on booking_workflows(booking_id, status);
create index if not exists idx_family_updates_booking_sent on family_updates(booking_id, sent_at desc);
create index if not exists idx_visit_summaries_booking_status on visit_summaries(booking_id, status, submitted_at desc);
create index if not exists idx_branch_operation_checklists_branch_date on branch_operation_checklists(branch_id, checklist_date, checklist_type);
create index if not exists idx_sla_escalations_booking_status on sla_escalations(booking_id, status, triggered_at desc);
create index if not exists idx_training_attempts_driver_module on training_attempts(driver_id, module_id);
create index if not exists idx_driver_quality_reviews_driver_period on driver_quality_reviews(driver_id, review_period_start, review_period_end);
create index if not exists idx_payments_booking on payments(booking_id);
create index if not exists idx_invoices_booking on invoices(booking_id);
create index if not exists idx_notifications_recipient_status on notifications(recipient_user_id, status);

-- AI Realtime Operations foundation
-- Rerunnable tables for AI call center intake, admin approvals, realtime sync,
-- party acknowledgement state, and verification guardrails.

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
  raw_payload jsonb default '{}'::jsonb,
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
alter table ai_conversations add column if not exists raw_payload jsonb default '{}'::jsonb;
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
alter table ai_conversations drop constraint if exists ai_conversations_contact_role_check;
alter table ai_conversations add constraint ai_conversations_contact_role_check check (
  contact_role is null or contact_role in ('employer','contractor','service_recipient','admin','family','driver','care_assistant','customer','elder','other')
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
  task_summary text,
  risk_level text not null default 'low',
  required_checks jsonb default '[]'::jsonb,
  approval_status text not null default 'pending',
  status text not null default 'open',
  assigned_to uuid references app_users(id) on delete set null,
  owner_user_id uuid references app_users(id) on delete set null,
  due_at timestamptz,
  approved_by uuid references app_users(id) on delete set null,
  approved_at timestamptz,
  completed_at timestamptz,
  payload jsonb default '{}'::jsonb,
  action_payload jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table ai_admin_tasks add column if not exists task_type text default 'admin_review';
alter table ai_admin_tasks add column if not exists summary text;
alter table ai_admin_tasks add column if not exists task_summary text;
alter table ai_admin_tasks add column if not exists status text default 'open';
alter table ai_admin_tasks add column if not exists assigned_to uuid references app_users(id) on delete set null;
alter table ai_admin_tasks add column if not exists owner_user_id uuid references app_users(id) on delete set null;
alter table ai_admin_tasks add column if not exists payload jsonb default '{}'::jsonb;
alter table ai_admin_tasks add column if not exists action_payload jsonb default '{}'::jsonb;
alter table ai_admin_tasks add column if not exists updated_at timestamptz default now();
alter table ai_admin_tasks alter column task_type set default 'admin_review';
alter table ai_admin_tasks alter column status set default 'open';
update ai_admin_tasks
set summary = coalesce(summary, task_summary)
where summary is null and task_summary is not null;
update ai_admin_tasks
set payload = coalesce(nullif(payload, '{}'::jsonb), action_payload, '{}'::jsonb)
where action_payload is not null;

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
  payload jsonb default '{}'::jsonb,
  delivery_status text not null default 'queued',
  created_at timestamptz default now()
);

alter table realtime_events add column if not exists conversation_id uuid references ai_conversations(id) on delete cascade;
alter table realtime_events add column if not exists task_id uuid references ai_admin_tasks(id) on delete cascade;
alter table realtime_events add column if not exists event_payload jsonb default '{}'::jsonb;
alter table realtime_events add column if not exists payload jsonb default '{}'::jsonb;
update realtime_events
set event_payload = coalesce(nullif(event_payload, '{}'::jsonb), payload, '{}'::jsonb)
where payload is not null;

alter table realtime_events drop constraint if exists realtime_events_actor_role_check;
alter table realtime_events add constraint realtime_events_actor_role_check check (
  actor_role is null or actor_role in ('owner','admin','dispatcher','driver','care_assistant','trainer','finance','customer','elder','family','ai','system','other')
);
alter table realtime_events drop constraint if exists realtime_events_recipient_role_check;
alter table realtime_events add constraint realtime_events_recipient_role_check check (
  recipient_role is null or recipient_role in ('owner','admin','dispatcher','driver','care_assistant','trainer','finance','customer','elder','family','employer','contractor','service_recipient','ai','system','all','other')
);
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
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table party_presence add column if not exists party_name text;
alter table party_presence add column if not exists recipient_user_id uuid references app_users(id) on delete set null;
alter table party_presence add column if not exists last_acknowledged_event_id uuid references realtime_events(id) on delete set null;
alter table party_presence add column if not exists acknowledged_at timestamptz;
alter table party_presence add column if not exists payload jsonb default '{}'::jsonb;
alter table party_presence add column if not exists metadata jsonb default '{}'::jsonb;
alter table party_presence add column if not exists updated_at timestamptz default now();
update party_presence
set payload = coalesce(nullif(payload, '{}'::jsonb), metadata, '{}'::jsonb)
where metadata is not null;

alter table party_presence drop constraint if exists party_presence_party_role_check;
alter table party_presence add constraint party_presence_party_role_check check (
  party_role in ('employer','contractor','service_recipient','owner','admin','dispatcher','driver','care_assistant','trainer','finance','customer','elder','family','ai','system','other')
);
alter table party_presence drop constraint if exists party_presence_channel_check;
alter table party_presence add constraint party_presence_channel_check check (
  channel in ('phone','line','whatsapp','web_chat','in_app','email','sms','other')
);
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
  result_payload jsonb default '{}'::jsonb,
  checked_by uuid references app_users(id) on delete set null,
  checked_at timestamptz,
  created_at timestamptz default now()
);

alter table verification_checks add column if not exists required boolean default true;
alter table verification_checks add column if not exists evidence jsonb default '{}'::jsonb;
alter table verification_checks add column if not exists notes text;
alter table verification_checks add column if not exists verified_by uuid references app_users(id) on delete set null;
alter table verification_checks add column if not exists verified_at timestamptz;
alter table verification_checks add column if not exists result_payload jsonb default '{}'::jsonb;
alter table verification_checks add column if not exists checked_by uuid references app_users(id) on delete set null;
alter table verification_checks add column if not exists checked_at timestamptz;
update verification_checks
set evidence = coalesce(nullif(evidence, '{}'::jsonb), result_payload, '{}'::jsonb)
where result_payload is not null;
update verification_checks
set verified_by = coalesce(verified_by, checked_by),
    verified_at = coalesce(verified_at, checked_at)
where checked_by is not null or checked_at is not null;

alter table verification_checks drop constraint if exists verification_checks_check_type_check;
alter table verification_checks add constraint verification_checks_check_type_check check (
  check_type in ('identity','consent','route','pickup_time','elder_mobility','medical','driver','vehicle','license','training','availability','incident','payment','message_preview','audit','other')
);
alter table verification_checks drop constraint if exists verification_checks_status_check;
alter table verification_checks add constraint verification_checks_status_check check (
  status in ('pending','approved','rejected','passed','failed','warning','skipped')
);

create index if not exists idx_ai_conversations_booking_status_created on ai_conversations(booking_id, status, created_at desc);
create index if not exists idx_ai_conversations_customer_created on ai_conversations(customer_id, created_at desc);
create index if not exists idx_ai_conversations_risk_status on ai_conversations(risk_level, status);
create index if not exists idx_ai_admin_tasks_booking_status_due on ai_admin_tasks(booking_id, approval_status, due_at);
create index if not exists idx_ai_admin_tasks_conversation on ai_admin_tasks(conversation_id);
create index if not exists idx_ai_admin_tasks_assigned_status on ai_admin_tasks(assigned_to, approval_status);
create index if not exists idx_ai_admin_tasks_owner_status on ai_admin_tasks(owner_user_id, approval_status);
create index if not exists idx_realtime_events_booking_created on realtime_events(booking_id, created_at desc);
create index if not exists idx_realtime_events_task_created on realtime_events(task_id, created_at desc);
create index if not exists idx_realtime_events_conversation_created on realtime_events(conversation_id, created_at desc);
create index if not exists idx_realtime_events_recipient_status_created on realtime_events(recipient_role, delivery_status, created_at desc);
create index if not exists idx_party_presence_booking_role on party_presence(booking_id, party_role);
create index if not exists idx_party_presence_recipient_status on party_presence(recipient_user_id, status);
create unique index if not exists idx_party_presence_booking_role_recipient_channel on party_presence(booking_id, party_role, recipient_user_id, channel);
create index if not exists idx_verification_checks_task_status on verification_checks(task_id, status);
create index if not exists idx_verification_checks_booking_type_status on verification_checks(booking_id, check_type, status);
create index if not exists idx_verification_checks_conversation on verification_checks(conversation_id);
