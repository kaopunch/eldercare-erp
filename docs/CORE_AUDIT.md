# CORE_AUDIT.md — ผล Audit ระบบ Eldercare Core เดิม (PHASE 0)

> จัดทำ: 2026-06-11 ตามข้อบังคับ PHASE 0 ใน `DEVELOPMENT_SPEC.md`
> ขอบเขต: repo `eldercare_erp_starter_v1/` + ฐานข้อมูล Supabase project `wmzaqpueifmlcereluxy`

---

## 1. สรุปผลสำคัญที่สุด (Executive Summary)

**ระบบเดิมไม่ตรงกับ assumption หลักของสเปค**: สเปค assume ว่า Core เป็น
Python/FastAPI + SQLAlchemy + Alembic แต่ของจริงคือ:

| ด้าน | สเปค assume | ของจริง |
|---|---|---|
| Backend | FastAPI (Python 3.11) | **Node.js / Express** (CommonJS) |
| DB access | SQLAlchemy 2.x | **@supabase/supabase-js** (service role) |
| Migration | Alembic | **ไฟล์ SQL ดิบ** ใน `database/` (apply ผ่าน SQL editor) |
| DB | PostgreSQL self-host + PostGIS | **Supabase managed PG 17** — PostGIS **ยังไม่ติดตั้ง** (มี 3.3.7 ให้เปิดได้) |
| Cache/Realtime | Redis pub/sub | **ไม่มี Redis** — มี `ws` (WebSocket) + event bus ในโปรเซส (`aiEventBus.js`, `aiRealtime.js`) |
| Frontend | React + Vite PWA | **HTML หน้าเดียว** (admin/staff console) ใน `frontend/index.html` |
| Validation | Pydantic | zod |
| Test | pytest | `node --test` (43 ผ่านทั้งหมด ณ 2026-06-09) |
| Deploy | docker-compose | Render (`render.yaml`) |

ตามกติกาสเปคข้อ "Tech stack — ยึดตามนี้**เว้นแต่ audit พบว่าระบบเดิมใช้อย่างอื่น**"
และ PHASE 0 ข้อ 3 (schema ขัดแย้ง → เสนอ migration plan ให้ user อนุมัติก่อน)
→ **ต้องให้ user ตัดสินใจเรื่อง stack ก่อนเริ่ม M1** — ดูข้อ 6

อีกประเด็นเชิงแนวคิด: ระบบเดิมเป็น **ERP แบบ dispatcher-centric**
(แอดมิน/dispatcher เป็นคนจ่ายงานให้ driver/care_assistant ผ่าน `assignments`)
ส่วนสเปคใหม่เป็น **marketplace แบบ broadcast + first-accept-wins**
— โมเดลนี้อยู่ร่วมกันได้ แต่ matching engine ต้องสร้างใหม่

---

## 2. ตาราง/Model ที่มีอยู่แล้ว (45+ ตาราง)

แหล่งความจริง: `database/001_schema.sql` … `005_security_sessions.sql` (+ 002/006 RLS)
ทุกตารางมี RLS เปิดแล้ว (18 ตารางมี policy เต็ม, ที่เหลือ backend-only)

### กลุ่มที่ map ตรงกับสเปคใหม่ได้

| ตารางเดิม | field สำคัญ | เทียบกับสเปคใหม่ |
|---|---|---|
| `customers` | name, phone, email, line_id, address | ≈ users(role=customer) — **แต่ไม่มี login/password** (เข้าผ่าน signed portal token) |
| `elders` | name, birth_date, conditions, mobility, hospital, address | ≈ `elder_profiles` — ไม่มี geography(Point), ไม่มี medications/allergies แยก jsonb |
| `app_users` | role (13 internal roles: admin, dispatcher, driver, care_assistant, …), PIN/password login | ≈ users(role=caregiver/admin) — caregiver ทับซ้อนกับ `drivers` + role `care_assistant` |
| `drivers` | license, screening, training, status pipeline (pending→active) | ≈ `caregiver_profiles` บางส่วน — ไม่มี service_area, rate, wallet, rating denormalized |
| `bookings` | booking_no, service_type, status (12 ค่า), quoted_price/final_price `numeric(12,2)` **บาท VAT-in**, payment_status | ≈ `bookings` สเปค — state machine คนละชุด (ดูข้อ 4), เงินเป็น numeric บาท **ไม่ใช่ int สตางค์** |
| `assignments` | driver_id, vehicle_id, assignment_score, accepted_at, rejected_reason | ≈ ครึ่งหนึ่งของ matching — dispatcher assign แล้ว driver กด accept/reject (มี endpoint แล้ว) |
| `trip_events` | booking_id, event_type, occurred_at | ≈ `booking_events` — ไม่มี location point, ไม่มี payload รูป |
| `trip_locations` | booking_id, lat/lng, recorded_at | ≈ `location_pings` — lat/lng เป็น numeric ไม่ใช่ geography, ไม่มี partition |
| `trip_checklists` | per-booking checklist | ส่วนหนึ่งของ check-in/out flow |
| `visit_summaries` | summary + approve workflow (draft→submitted→approved) | ≈ `service_health_records` — โครงต่างกัน ไม่มี vital_signs/medications_received/next_appointment แยก field |
| `elder_assessments` | ประเมินผู้สูงวัย | เสริม Health Profile |
| `ratings` | booking rating | ≈ `reviews` — ทิศทางเดียว (customer→service) ไม่มี tags |
| `payments` / `invoices` / `refunds` | amount numeric, evidence upload, สถานะ unpaid→paid | ≈ `payments` สเปค — **ไม่มี Omise/escrow**, จ่ายแบบโอน+แนบหลักฐาน |
| `service_price_rules` | base_fee, per_km_fee, waiting_fee, multiplier (4 rows seeded) | ≈ `pricing_rules` — config ใน DB ตามแนวสเปคแล้ว แต่สูตรคนละแบบ |
| `pdpa_consents` | consent record ต่อ elder | ตรงข้อกำหนด PDPA ในสเปค ✓ |
| `notifications` | queued→sent, ผูก LINE push (`lib/line.js`) | ≈ notification engine — LINE code เสร็จแล้ว รอ `LINE_CHANNEL_ACCESS_TOKEN` |
| `booking_cancellations` | cancel record | สเปคต้องการ fee rules เพิ่ม (ยังไม่มี) |
| `audit_logs` | actor, action | ฐานของ PDPA access log ✓ |

### กลุ่มที่สเปคใหม่ไม่มี (ของ ERP เดิม — ห้ามกระทบ)

`companies`, `branches` (multi-tenant), `vehicles`, `driver_documents`,
`driver_screenings`, `training_modules`/`training_attempts`, `incidents`,
`sla_escalations`, `leads`, `booking_workflows`, `family_updates`,
`branch_operation_checklists`, `driver_quality_reviews`,
`ai_conversations`/`ai_admin_tasks`/`realtime_events`/`party_presence` (AI ops)

### ตารางในสเปคที่ **ยังไม่มีเลย**

- `caregiver_profiles` (service_area, rates, verification_status, wallet_balance)
- `caregiver_availability` (ปฏิทินรับงาน)
- `payout_ledger` (append-only wallet ledger)
- escrow states ใน payments (`held_escrow`, `released`)
- ตาราง OTP / refresh token สำหรับ customer & caregiver auth

---

## 3. API Endpoint ที่มีอยู่แล้ว

Base: Express app ใน `backend/src/server.js`, ทุก route ใต้ `/api/*`

| กลุ่ม | ตัวอย่าง endpoint | หมายเหตุ |
|---|---|---|
| Auth (staff) | `POST /api/auth/session` (email+password), PIN login | สำหรับ internal roles เท่านั้น |
| Bookings (ops) | CRUD + `/:id/quote`, `/:id/confirm`, `/:id/cancel`, `/:id/complete`, `/:id/visit-summary(+approve)`, `/:id/family-updates`, `/:id/compliance` | flow ฝั่งแอดมิน/dispatcher |
| Assignments | `GET /recommend` (มี scoring แล้ว), `POST /`, `/:id/accept`, `/:id/reject` | จุดต่อยอด matching |
| Trips | `/:booking_id/checklist`, `/events`, `/location`, `/complete` | จุดต่อยอด GPS tracking |
| Portal (customer ไม่มี account) | `/register`, `/book`, `/status-token/:token`, rating, payment-evidence, consent | **มี customer journey เบื้องต้นแล้ว** ผ่าน signed token ไม่ใช่ login |
| Elders / Customers / Drivers / Users | CRUD | |
| Finance | invoices, payments, refunds | VAT bug แก้แล้ว 2026-06-10 |
| AI ops | `/api/ai/*`, inbound LINE webhook `/api/ai/inbound/line`, SSE/WS stream | notification + realtime ฐานมีแล้ว |
| อื่นๆ | dashboard, reports (PDF), incidents, quality, readiness, privacy, sop | ERP features |

WebSocket: มี `ws` server ฝั่ง AI realtime แล้ว (`lib/aiRealtime.js`) — ยังไม่มี
channel แบบ `/ws/bookings/:id/track`

## 3.1 ระบบ Auth เดิม

- **Staff**: `app_users` + `app_user_credentials` (PIN/password), session token ออกเอง
  (`lib/session.js`), revocation list, role-based middleware (`middleware/auth.js`)
- **Customer**: ไม่มี account — ใช้ **signed token ต่อ booking/elder** (`PORTAL_TOKEN_SECRET`)
- **ไม่มี**: OTP SMS, JWT access/refresh แบบสเปค, argon2 (ใช้กลไกของตัวเอง)
- Demo: 7 users PIN `1234` (ต้องเปลี่ยนก่อน production)

---

## 4. State Machine เปรียบเทียบ

```
เดิม:  draft → pending_dispatch_approval → confirmed → assigned → arrived
       → onboard → in_progress → waiting_return → completed
       (+ cancelled, no_show, incident_hold)

สเปค: draft → pending_payment → searching → matched → confirmed
       → in_progress_pickup → at_destination → returning
       → pending_confirmation → completed (+ cancelled, disputed)
```

- เดิม**ไม่มี**: pending_payment (escrow gate), searching/matched (marketplace),
  pending_confirmation (customer ยืนยันจบงาน), disputed
- เดิม**มีเกิน**: pending_dispatch_approval, no_show, incident_hold, waiting_return
- transition เดิมกระจายอยู่ใน route handlers — **ไม่มีคลาส state machine กลาง**
  ที่บังคับ allowed transitions + idempotency ตามสเปค
- geofencing: ยังไม่มีเลย (ไม่มี PostGIS, ไม่มี route deviation check)

## 4.1 Drift / ความเสี่ยงที่พบ

1. **Migration tracking ไม่ตรง**: Supabase บันทึก migration แค่ `002`, `006` —
   ไฟล์ 001/003/004/005 ถูก apply ตรงโดยไม่ track → ก่อนเพิ่ม schema ใหม่ควร
   baseline ให้ตรงก่อน
2. เงินเป็น `numeric(12,2)` บาท (VAT รวมแล้ว) ทั้งระบบ — สเปคสั่ง int สตางค์
   → ตารางใหม่ใช้สตางค์ได้ แต่จุดเชื่อมกับตารางเดิมต้องแปลงระวัง
3. `latest` dependencies ใน package.json (express, supabase-js ฯลฯ) — ควร pin version
4. ไม่มี CI ใดๆ ใน repo

---

## 5. สิ่งที่สเปค assume ว่า "Core มีแล้ว" — สถานะจริง

| สเปค assume | สถานะจริง |
|---|---|
| Job state machine | มีสถานะ+flow แต่คนละชุด, ไม่มีคลาสกลาง → ต้องสร้าง `BookingStateMachine` ใหม่ |
| GPS tracking | มี `trip_locations` + endpoint รับพิกัด แต่ไม่มี WS push ไป customer, ไม่มี geofence |
| Health records | มี `visit_summaries`/`elder_assessments` แต่โครงไม่ตรง `service_health_records` |
| Notification engine | **มีจริงและใช้ได้** — notifications table + LINE push + mock fallback + webhook ✓ |
| Elder/health profile | มี `elders` ครบพอสมควร ✓ (ขาด geo point + medications jsonb) |

---

## 6. ข้อเสนอ Migration Plan (ต้องให้ user เลือกก่อนเริ่ม M1)

### ทางเลือก A — ต่อยอด Node/Express + Supabase เดิม (แนะนำ)
ตามกติกาสเปคเอง ("ยึด tech stack ตามสเปค*เว้นแต่ระบบเดิมใช้อย่างอื่น*"):
- Backend เดิมขยายเป็น `/api/v1/customer/*`, `/api/v1/caregiver/*` โมดูลใหม่
  แยกโฟลเดอร์ ไม่แตะ route เดิม; สร้าง `BookingStateMachine` กลางใช้ร่วม
- DB: เปิด PostGIS, เพิ่มตารางใหม่ (caregiver_profiles, availability, payout_ledger,
  booking_events ใหม่ ฯลฯ) ผ่าน Supabase migrations (track ทุกไฟล์) —
  **ไม่ drop/alter ตารางเดิม** เพิ่ม column แบบ additive เท่านั้น
- Realtime: ใช้ `ws` ที่มี + Supabase Realtime แทน Redis (ยังไม่จำเป็นที่สเกลนี้)
- Storage: Supabase Storage (private bucket + signed URL) ตรงข้อกำหนด PDPA
- Frontend: สร้าง React PWA ใหม่ 2 ตัวตามสเปคเต็มรูป (`frontend/customer`, `frontend/caregiver`)
- ข้อดี: ไม่ทิ้งของที่ UAT ผ่านแล้ว 9/9, ทีมมีระบบเดียว, เร็วสุดสู่ pilot
- ข้อเสีย: ไม่ได้ FastAPI/pytest ตามตัวอักษรของสเปค (แต่สเปคเปิดช่องไว้)

### ทางเลือก B — เขียน Backend ใหม่เป็น FastAPI ตามสเปคตรงตัว
- สร้าง monorepo ใหม่ตามสเปคข้อ 1, FastAPI ชี้เข้า Supabase PG ตัวเดียวกัน
- ข้อดี: ตรงสเปค/CLAUDE.md ทุกบรรทัด, ได้ Alembic + pytest
- ข้อเสีย: สองระบบ backend ดูแลคู่กัน, business logic ที่ debug แล้ว
  (quote, LINE, notifications) ต้อง port ใหม่, ช้ากว่ามาก, เสี่ยง drift สอง stack

### ทางเลือก C — Greenfield FastAPI ทั้งหมด ใช้ระบบเดิมเป็น reference เท่านั้น
- ข้อเสีย: ทิ้งการลงทุนเดิมทั้งหมด รวม UAT/RLS/LINE ที่ทำไว้

**คำแนะนำของผู้จัดทำ audit: ทางเลือก A** — แล้วแก้ `CLAUDE.md` ส่วนคำสั่ง
(uvicorn/alembic/pytest → npm) ให้ตรง stack จริง โดยคงกติกาเหล็กทุกข้อ
(state machine กลาง, int สตางค์สำหรับตารางใหม่, ห้าม log เลขบัตร/ข้อมูลสุขภาพ,
i18n, offline queue) ไว้ครบ

---

## 7. รายการตัดสินใจที่รอ user (จะบันทึกลง docs/DECISIONS.md เมื่อได้คำตอบ)

1. เลือก stack ทางเลือก A / B / C (ข้อ 6)
2. ตารางใหม่ใช้เงิน int สตางค์ตามสเปค ขณะที่ตารางเดิมเป็น numeric บาท — ยืนยัน?
3. Customer auth: สเปคสั่ง OTP SMS — ยังไม่มี SMS provider ใน repo
   (มีแต่ LINE) → เฟสแรกใช้เบอร์+รหัสผ่าน และ mock OTP ไว้หลัง interface ได้หรือไม่?
4. Payment: สเปคสั่ง Omise escrow — ระบบเดิมเป็นโอน+แนบหลักฐาน →
   M2 ทำ Omise sandbox ตามสเปค หรือคง manual flow ไว้ก่อน?
5. Redis: เสนอ**ไม่ใช้**ในเฟสนี้ (ใช้ ws + Supabase Realtime) — ยืนยัน?
