# Agent Execution Plan: Production Readiness

เอกสารนี้เป็นแผนปฏิบัติงานสำหรับ agent ที่ต้องพัฒนา ElderCare ERP ต่อจากสถานะปัจจุบัน โดยให้ทำตามลำดับความเสี่ยงก่อน: production blocker, security, UAT workflow, integrations, monitoring และ pilot go-live

## Current Baseline

วันที่ตั้งต้น: 2026-06-08

สถานะที่ตรวจแล้ว:

- Backend test ผ่านครบ `35/35` ด้วย `npm test`
- Backend boot ได้ และ `/health` ตอบ `200`
- Local `.env` มี `SUPABASE_URL` และ `SUPABASE_SERVICE_ROLE_KEY`
- Supabase key decode ได้เป็น `service_role`
- มี migration SQL `database/001_schema.sql` ถึง `database/005_security_sessions.sql`
- มี Render Blueprint ที่ `render.yaml`
- มี uncommitted change ที่ `frontend/index.html` ซึ่งเป็นงาน mobile public header และต้องไม่ถูก revert โดย agent

ข้อจำกัดที่พบ:

- เครื่องนี้ resolve Supabase host ไม่ได้ในรอบตรวจล่าสุด: `Could not resolve host: wmzaqpueifmlcereluxy.supabase.co`
- ยังยืนยัน schema/storage readiness บน Supabase จริงไม่ได้
- `npm audit` พบ moderate vulnerabilities ใน `qs` และ `ws`
- Express production hardening ยังไม่ครบ: CORS เปิดกว้าง, logging แบบ dev, ยังไม่มี rate limit/standard security headers

## Agent Operating Rules

1. ห้าม revert หรือแก้ `frontend/index.html` ที่มี change ค้างอยู่ ยกเว้นผู้ใช้สั่งชัดเจน
2. ก่อนแก้ไฟล์ ให้ตรวจ `git status --short`
3. หลังแก้ backend ให้รัน `npm test`
4. หลังแก้ dependency ให้รัน `npm audit --omit=dev --audit-level=moderate`
5. หลังแก้ server/security ให้ boot server และตรวจ `/health`
6. ห้ามพิมพ์ secret หรือค่า `.env` จริงลง terminal output หรือเอกสาร
7. ถ้า Supabase/network fail ให้แยกผลเป็น environment blocker ไม่ปะปนกับ code failure
8. ทุกงานต้องมี acceptance criteria ก่อนถือว่าเสร็จ

## P0: Production Blockers

### P0.1 Fix Dependency Audit

Goal: ปิด vulnerability ระดับ moderate ขึ้นไปใน production dependencies

Steps:

- รัน `npm audit fix` ใน `backend/`
- ตรวจว่า `package-lock.json` และ `package.json` เปลี่ยนอย่างไร
- รัน `npm test`
- รัน `npm audit --omit=dev --audit-level=moderate`

Acceptance criteria:

- `npm test` ผ่าน
- `npm audit --omit=dev --audit-level=moderate` ไม่มี moderate/high/critical
- ไม่มีการเปลี่ยนไฟล์นอก scope โดยไม่จำเป็น

### P0.2 Verify Supabase Runtime Readiness

Goal: ยืนยันว่า Supabase project, schema, RLS, storage และ readiness endpoint ใช้งานได้จริง

Steps:

- ตรวจ DNS/connectivity ไปยัง Supabase host
- รัน migration ตามลำดับถ้ายังไม่ครบ:
  - `database/001_schema.sql`
  - `database/002_rls_policies.sql`
  - `database/003_app_user_login.sql`
  - `database/004_ai_realtime_operations.sql`
  - `database/005_security_sessions.sql`
- ตรวจตารางสำคัญแบบ metadata-only:
  - `app_users`
  - `app_user_credentials`
  - `audit_logs`
  - `booking_workflows`
  - `visit_summaries`
  - `family_updates`
  - `sla_escalations`
  - `branch_operation_checklists`
  - `app_user_session_revocations`
- ตรวจ private bucket `payment-evidence`
- Login ด้วย admin PIN แล้วเรียก `GET /api/readiness`

Acceptance criteria:

- Supabase host resolve ได้
- ตารางสำคัญ query ได้
- storage bucket พร้อม หรือ readiness แสดง warning ที่แก้ได้
- `/api/readiness` ไม่มี fail สำหรับ auth/schema/core storage

### P0.3 Harden Server Runtime

Goal: ลดความเสี่ยงก่อนเปิด staging/production

Steps:

- จำกัด CORS ด้วย allowlist จาก env
- ปรับ production logging ไม่ log query string ที่มี token
- เพิ่ม security headers
- เพิ่ม rate limit สำหรับ auth, AI inbound webhook, portal public endpoint และ API ทั่วไป
- เพิ่ม `PORTAL_TOKEN_SECRET` ใน `.env.example` และ `render.yaml`
- เพิ่ม readiness check สำหรับ portal token secret และ CORS origin config

Acceptance criteria:

- `npm test` ผ่าน
- `/health` ผ่าน
- local frontend ยังเรียก backend ได้ใน development
- production สามารถตั้ง allowed origins ผ่าน env ได้

## P1: UAT Workflow Readiness

### P1.1 Core Workflow UAT

Goal: ทีมทดลอง flow งานจริงตั้งแต่รับ lead ถึงปิดงานได้

Flow ที่ต้องทดสอบ:

- Lead intake
- Elder assessment
- Customer/elder/consent creation
- Booking creation
- Quote approval
- Booking confirmation
- Assignment recommendation
- Driver/care assistant assignment
- Trip checklist
- Trip events ตาม SOP
- Family update
- Visit summary approval
- Booking completion

Acceptance criteria:

- UAT script ภาษาไทยพร้อมใช้
- flow สำคัญทำได้โดยไม่แก้ข้อมูลหลังบ้าน
- error message อ่านเข้าใจสำหรับ operator

### P1.2 Finance and Evidence UAT

Goal: งานการเงินแนบหลักฐานและตรวจเอกสารได้จริง

Flow ที่ต้องทดสอบ:

- Create payment
- Upload evidence
- View evidence through signed URL
- Create invoice
- Create refund
- Generate report/PDF ที่มีภาษาไทยถูกต้อง

Acceptance criteria:

- private storage ไม่เปิด public
- finance role เข้าถึงได้ตามสิทธิ์
- signed URL ใช้งานได้และหมดอายุได้

## P2: Integrations

### P2.1 LINE and Customer Notifications

Goal: ลูกค้าและครอบครัวได้รับสถานะสำคัญผ่าน LINE/portal

Steps:

- ตั้ง `LINE_CHANNEL_ACCESS_TOKEN`
- ทดสอบ notification events:
  - booking confirmed
  - driver arrived
  - elder onboard
  - family update
  - visit summary approved
  - service completed
- ตรวจ fallback เมื่อไม่มี LINE recipient id

Acceptance criteria:

- ข้อความภาษาไทยพร้อมใช้งานจริง
- delivery status ถูกบันทึกในระบบ
- failed delivery retry/manual handling ได้

### P2.2 AI Operations

Goal: AI-assisted operations ทำงานแบบมี human approval

Steps:

- ตั้ง `ELDERCARE_AI_WEBHOOK_SECRET`
- ตั้ง `ELDERCARE_AI_ANALYSIS_URL` ถ้ามี provider จริง
- ทดสอบ inbound channels: LINE, WhatsApp, Twilio, web chat
- ทดสอบ task verification และ approval
- ทดสอบ outbound delivery หลัง approved เท่านั้น

Acceptance criteria:

- production webhook ไม่มี shared secret ไม่รับงาน
- critical/safety case ต้อง human review
- outbound delivery ไม่เกิดก่อน approval

## P3: Monitoring and Compliance

### P3.1 Observability

Goal: เห็นสุขภาพระบบและปัญหาปฏิบัติการเร็ว

Metrics:

- uptime
- API error rate
- login failure and lockouts
- readiness fail/warn count
- failed notification count
- open incident count
- unapproved visit summary count
- booking stuck by status

Acceptance criteria:

- มี dashboard หรือ report ที่ทีมดูทุกวัน
- มี runbook สำหรับ P0 incident

### P3.2 PDPA and Audit Review

Goal: ลดความเสี่ยงข้อมูลส่วนบุคคลและข้อมูลสุขภาพ

Checks:

- consent required before sensitive workflow
- audit log for auth, data access, payment evidence, incident closure
- minimum-needed access per role
- data retention/export/delete request process

Acceptance criteria:

- checklist PDPA ผ่านสำหรับ pilot
- admin manual ระบุขั้นตอน handling ข้อมูลอ่อนไหว

## P4: Pilot Go-Live

Goal: เปิดใช้งานจริงแบบจำกัดความเสี่ยง

Pilot scope:

- 5-10 bookings แรก
- 1 branch
- operator/admin/dispatcher/finance/driver/care assistant กลุ่มเล็ก
- daily review หลังจบงาน

Go/no-go criteria:

- ไม่มี P0 defect ค้าง
- P1 defect มี workaround ชัดเจน
- team training เสร็จ
- backup/rollback พร้อม
- support owner ชัดเจน

## Verification Commands

ใช้คำสั่งเหล่านี้ตามงานที่เกี่ยวข้อง:

```bash
cd backend
npm test
npm audit --omit=dev --audit-level=moderate
npm run verify:runtime -- --base-url=https://eldercare-erp.onrender.com
npm run check:supabase-key
PORT=18080 npm start
curl -s http://127.0.0.1:18080/health
```

## Execution Log

Agent ต้องอัปเดตส่วนนี้เมื่อทำงานเสร็จในแต่ละช่วง

| Date | Task | Status | Notes |
| --- | --- | --- | --- |
| 2026-06-08 | Baseline readiness review | Done | Tests passed 35/35; Supabase DNS failed; audit found qs/ws moderate vulnerabilities |
| 2026-06-08 | P0.1 dependency audit fix | Done | `npm audit fix` updated `qs` to 6.15.2 and `ws` to 8.21.0; `npm audit --omit=dev --audit-level=moderate` found 0 vulnerabilities |
| 2026-06-08 | P0.3 server hardening pass 1 | Done | Added CORS allowlist support, basic security headers, API/auth/portal/AI inbound rate limits, safe URL logging, dedicated portal secret config, and readiness checks; `npm test` passed 40/40 |
| 2026-06-08 | P0.2 runtime readiness tooling | Done | Added `npm run verify:runtime` to check Supabase DNS/schema/storage plus Render health/auth/readiness without printing secrets; current Supabase host still fails DNS in this environment |
| 2026-06-08 | P1 UAT playbook | Done | Added `docs/16_uat_playbook.md` covering lead, profile, consent, booking, assignment, trip, completion, finance, portal, rating, readiness, and sign-off |
| 2026-06-08 | P3 operations monitoring pass 1 | Done | Added operations health builder, `/api/dashboard/operations-health`, tests, and `docs/17_operations_monitoring_runbook.md` for daily pilot monitoring |
| 2026-06-08 | Render runtime env checklist | Done | Added public base URL/CORS values and `docs/18_render_runtime_env_checklist.md` so required secret/public env setup is explicit before pilot |
| 2026-06-08 | Render deploy verification | Partial | Live `/health` is healthy after deploy; Render did not expose `Access-Control-Allow-Origin` for `https://eldercare-erp.onrender.com`, so existing service likely still needs `ELDERCARE_CORS_ORIGINS` set in Render Dashboard; Supabase DNS remains the only hard P0.2 blocker |
| 2026-06-09 | P0.2 Supabase RLS + user setup | Done | Applied 002_rls_policies.sql (18 tables with full policies) and 006_rls_backend_only_tables (24 tables, service_role only); seeded demo data (7 users, 4 bookings, 4 elders); set PIN 1234 for all 7 demo users; readiness: 16/23 pass, 7 warn, 0 fail; login working via POST /api/auth/session |
| 2026-06-09 | Readiness warn items | Done | Created payment-evidence Storage bucket (private, 10MB, jpg/png/webp/pdf); set PORTAL_TOKEN_SECRET and ELDERCARE_AI_WEBHOOK_SECRET in .env; fixed must_rotate_pin for trainer/finance/owner; set PIN 1234 for all 10 demo users; readiness: 20/23 pass, 3 warn (LINE/AI external), 0 fail |
| 2026-06-10 | P1.1/P1.2 Full UAT (UAT1-9) | Done | Ran full `docs/16_uat_playbook.md` end-to-end on local server with demo data; all 9 scenarios Pass; seeded `service_price_rules` (4 rows) to unblock quote/confirm; fixed DEFECT-1 (P2) — `req.body` undefined crash on `/api/assignments/:id/accept` and `/:id/reject`, fixed in `assignments.js`; found DEFECT-2 (P2, open) — invoice total includes 7% VAT but payment balance check uses `final_price` without VAT, causing full-invoice payment to be rejected; `npm test` 43/43 pass after fix; results recorded in `docs/16_uat_playbook.md` UAT Run Results section |
