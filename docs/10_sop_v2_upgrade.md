# SOP v2 Upgrade Notes

This upgrade aligns the ERP starter with `MASTER SOP — ELDERCARE MULTI-SERVICE ERP PLATFORM` version 2.0.

## Added service scope

Supported `service_type` values now include:

- `basic_ride`
- `assisted_ride`
- `elderly_transport`
- `hospital_companion`
- `home_companion`
- `medical_coordination`
- `family_monitoring`
- `monthly_transport`

## Core controls implemented

- Booking creation generates a `booking_workflows` row and stores a workflow snapshot on `bookings`.
- Confirmation checks mandatory SOP consent state through `general_service`, `sensitive_health`, `family_notification`, and `photo` where applicable.
- Hospital/home/coordination/monitoring workflows require approved visit summaries before completion.
- Family updates are stored in `family_updates` and also logged into timeline events.
- Completion through `POST /api/bookings/:id/complete` blocks unresolved high/critical incidents, missing workflow events, missing approved summary, and missing family notification.
- Field updates are checked for non-diagnostic language before saving family summaries.
- High/critical incidents create SLA escalation rows and freeze booking closure via `incident_hold`.
- Branch opening/closing checklists, leads, and elder assessments are available through `/api/sop/*`.

## Database migration

Run `database/001_schema.sql` again in Supabase SQL Editor. The file is rerunnable and uses `create table if not exists`, `alter table ... add column if not exists`, and constraint replacement for the SOP v2 fields.

## Verification

Backend verification:

```bash
cd backend
npm test
```

Current suite covers SOP risk classification, mandatory consent enforcement hooks, workflow event ordering, visit summary/closure guards, incident closure, assignment rules, pricing, AI realtime, and executive dashboard behavior.
