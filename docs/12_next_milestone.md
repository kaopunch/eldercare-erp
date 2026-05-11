# Next Milestone: Intake to SOP v2 Booking

Added the first customer acquisition flow for SOP v2: lead intake, elder assessment, and handoff into the existing booking creation workflow.

## Frontend

- New `Lead Intake` navigation item under Customers & care.
- Lead form writes to `POST /api/sop/leads`.
- Elder assessment form writes to `POST /api/sop/elder-assessments`.
- Recent lead and assessment tables read from Supabase.
- Assessment rows can open the real booking form with the assessed elder selected.
- Profile rows now show risk level and wheelchair requirement from the latest elder profile data.

## Backend

Added read endpoints for the frontend Lead Intake and Elder Assessment screens:

- `GET /api/sop/leads`
  - Returns `{ ok, leads }`.
  - Fixed ordering: newest `created_at` first.
  - Query filters: `company_id`, `branch_id`, `status`, `lead_source`, `service_interest`, `urgency_level`, `assigned_coordinator_id`, `customer_id`, `elder_id`.
  - `limit` is clamped to 1-200 and defaults to 100.

- `GET /api/sop/elder-assessments`
  - Returns `{ ok, assessments }`.
  - Fixed ordering: newest `assessed_at` first.
  - Query filters: `elder_id`, `assessed_by`, `risk_level`, `wheelchair_required=true|false`.
  - `limit` is clamped to 1-200 and defaults to 100.
