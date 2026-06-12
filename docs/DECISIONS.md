# DECISIONS.md — บันทึกการตัดสินใจ (อุ่นใจ Care Platform)

> format: วันที่ / คำถาม / คำตอบ / ผลต่อโค้ด

## 2026-06-11 — Backend stack (PHASE 0)

- **คำถาม**: สเปค assume FastAPI/Python แต่ Eldercare Core จริงเป็น Node.js/Express + Supabase — ใช้ stack ไหน?
- **คำตอบ (user)**: ทางเลือก A — ต่อยอด Node/Express + Supabase เดิม
- **ผลต่อโค้ด**:
  - Backend ใหม่อยู่ใน `backend/src/modules/{auth,customer,caregiver,booking,payment,notification}` mount ที่ `/api/v1/customer/*` และ `/api/v1/caregiver/*` — ไม่แตะ route เดิมใต้ `/api/*`
  - DB ผ่าน Supabase migrations (track ทุกไฟล์) แบบ additive เท่านั้น; เปิด PostGIS ใน M1
  - ไม่ใช้ Redis เฟสนี้ — realtime ใช้ `ws` ที่มีอยู่ + Supabase Realtime
  - ไม่ใช้ docker-compose (DB เป็น Supabase managed) — M0 DoD ปรับเป็น "backend tests ผ่าน + frontend dev server รันได้"
  - ไฟล์เก็บใน Supabase Storage private bucket + signed URL (≤ 15 นาที)
  - `CLAUDE.md` ส่วนคำสั่ง/stack ปรับให้ตรง Node — กติกาเหล็กคงเดิมทุกข้อ
  - ตารางใหม่ใช้เงิน **int สตางค์** ตามสเปค; จุดเชื่อมกับตารางเดิม (numeric บาท) แปลงที่ boundary เดียวพร้อม test

## 2026-06-11 — Payment (M2)

- **คำถาม**: Omise escrow ตามสเปค หรือ manual โอน+หลักฐานแบบเดิม?
- **คำตอบ (user)**: Omise sandbox ตามสเปค
- **ผลต่อโค้ด**: สร้าง `PaymentGateway` interface + `OmiseGateway` (sandbox) ใน `modules/payment`; payments ตารางใหม่มีสถานะ escrow (pending → held_escrow → released/refunded); user ต้องสมัคร Omise account เพื่อเอา test keys ใส่ `.env` ก่อนเริ่ม M2

## 2026-06-11 — OTP SMS (M1)

- **คำถาม**: สมัครสมาชิกด้วย OTP SMS แต่ยังไม่มี SMS provider?
- **คำตอบ (user)**: Mock OTP หลัง interface
- **ผลต่อโค้ด**: สร้าง `SmsProvider` interface ใน `modules/notification` + `MockSmsProvider` (dev: คืน OTP ใน response/log เฉพาะ `NODE_ENV !== 'production'`); flow OTP ครบตามสเปค เปลี่ยน provider จริงภายหลังโดยไม่แก้ flow

## 2026-06-11 — เครื่องมือ build frontend (M0)

- **คำถาม**: สเปคบังคับ PWA แต่ whitelist dependency ไม่ได้ระบุ plugin
- **คำตอบ (ตัดสินใจแทน — เป็น build tooling ไม่ใช่ runtime dependency ใหญ่)**: ใช้ `vite-plugin-pwa` สำหรับ service worker/manifest และ TanStack Query ตามที่ `CLAUDE.md` กำหนด
- **ผลต่อโค้ด**: devDependencies ของ `frontend/customer` และ `frontend/caregiver`

## 2026-06-11 — M1 implementation decisions (ตัดสินใจแทนระหว่างพัฒนา)

1. **ชื่อตารางใหม่ใช้ prefix `care_`** (`users` → `care_users`, `elder_profiles` → `care_elder_profiles`, ...) — กันชนกับตาราง ERP เดิม (`bookings`, `payments`, `notifications` มีอยู่แล้ว); mapping บันทึกใน header ของ `database/008_care_platform_m1.sql`
2. **Password hashing ใช้ pbkdf2_sha256 (Node built-in) แทน argon2** — argon2 เป็น native dependency นอก whitelist; ใช้ scheme/iterations เดียวกับ PIN hashing ของ ERP เดิม (`lib/session.js`)
3. **อัปโหลดเอกสารใช้ base64 JSON body แทน multipart** — ตาม pattern เดิมของ ERP (`lib/storage.js` payment evidence) ไม่ต้องเพิ่ม multer; จำกัด 6 MB, PDF/JPEG/PNG/WebP
4. **ปักหมุดแผนที่ M1 ใช้ geolocation + พิกัดตัวเลข** — ยังไม่มี Google Maps API key; Map adapter เต็มรูปจะทำใน M2 (หน้า booking ต้องใช้อยู่แล้ว)
5. **เพิ่ม column `home_lat/home_lng`, `service_area_lat/lng` (denormalized)** ควบคู่ geography — PostgREST คืน geography เป็น WKB hex ซึ่ง echo กลับเป็นพิกัดไม่ได้; geography ยังเป็น source สำหรับ PostGIS query ใน M3 (migration 009)
6. **Refresh token เป็น opaque token (48 bytes) + rotation single-use** เก็บ hash ใน `care_refresh_tokens` — เพิกถอนได้จริง ต่างจาก JWT refresh
7. **`shared/` ใน frontend เป็น pure TS เท่านั้น** (i18n, types, fetch client) — ไฟล์ที่ import react/zustand อยู่ใน app แต่ละตัว เพราะ node_modules ไม่ shared ระหว่างแอป

## 2026-06-12 — M2 implementation decisions

1. **MockGateway เป็น payment gateway default** (`CARE_PAYMENT_GATEWAY=mock`) — จ่ายสำเร็จทันทีให้ flow ถึง searching ครบตาม DoD; `OmiseGateway` เขียนเสร็จแล้ว (PromptPay source+charge, card token, refund, webhook charge.complete) สลับด้วย env เมื่อได้ test keys
2. **Booking expiry แบบ lazy** — pending_payment เกิน 30 นาทีจะถูกเปลี่ยนเป็น cancelled ตอนถูกอ่าน/จ่าย ไม่ใช้ cron (pilot scale เพียงพอ; เพิ่ม pg_cron ได้ภายหลัง)
3. **Concurrency ใช้ conditional update** (`WHERE status = from_status`) แทน row lock — first-writer-wins, ฝั่งแพ้ได้ TRANSITION_CONFLICT ให้อ่านใหม่
4. **ตาราง cancel tier**: เลือก tier จาก `min_hours_before` สูงสุดที่ <= ชั่วโมงก่อนนัด; ยกเลิกโดย caregiver/system/admin คืนเงิน 100% เสมอ (strike caregiver มาใน M3)
5. **จุดหมาย M2 ใช้พิกัด + ชื่อสถานที่พิมพ์เอง** — hospital autocomplete ต้องใช้ Places API จะมาพร้อม Map adapter
6. **Webhook Omise ไม่ตรวจ signature ในเฟสนี้** (Omise ไม่มี signing secret มาตรฐาน) — ความปลอดภัยมาจากการ lookup ด้วย charge id ที่เราสร้างเอง + idempotent transition; M6 จะเพิ่มการ verify ด้วย retrieve charge จาก API ก่อนเชื่อ

## 2026-06-12 — M3 implementation decisions

1. **Matching คำนวณฝั่ง JS ด้วย lat/lng denormalized** (haversine) แทน PostGIS ST_DWithin — ถูกต้องเท่ากันที่ pilot scale, unit test ง่าย; เปลี่ยนเป็น PostGIS query เมื่อจำนวนผู้ดูแลโต
2. **Batch progression แบบ lazy** — batch ถัดไป (5 คน/10 นาที) ถูกสร้างเมื่อมีการอ่าน (caregiver poll offers ทุก 30 วิ หรือ customer เปิดหน้า booking) ไม่ใช้ background worker; แบบเดียวกับ payment expiry
3. **First-accept-wins ใช้ conditional update ของ state machine** (`WHERE status='searching'`) — คนแรกที่ DB commit ชนะ คนหลังได้ JOB_TAKEN
4. **ยกเลิกระหว่าง searching คืนเงิน 100% เสมอ** — tier 3.1 เริ่มใช้เมื่อมีผู้ดูแล (matched ขึ้นไป) เพราะยังไม่มีใครเสียโอกาสงาน
5. **Recurring availability ทำฝั่ง client** — ปุ่ม "ทำซ้ำ 4 สัปดาห์" copy pattern สัปดาห์นี้แล้ว upsert เป็นรายวัน ไม่มีตาราง recurring แยก (โครงสร้างข้อมูลเรียบกว่า แก้รายวันได้อิสระ)
6. **การ์ดงานปิดบังที่อยู่** — ส่งเฉพาะพิกัดปัดเศษ ~1 กม. + ระยะทาง + จุดหมาย; ที่อยู่เต็มเห็นหลังกดรับงานเท่านั้น (ตามสเปค G3)
7. **Verify caregiver ผ่านสคริปต์** `backend/scripts/verify_caregiver.js --phone X` — admin dashboard อยู่นอก scope
8. **แจ้ง search timeout (4 ชม./<3 ชม.ก่อนนัด)** — เฟสนี้แสดง banner ใน app + ยกเลิกคืนเต็ม; LINE notification มาใน M5

## 2026-06-12 — M4 implementation decisions

1. **แผนที่ใช้ Leaflet + OpenStreetMap** (dependency ใหม่ ~40KB, MIT) — ทางเดียวที่ไม่ต้องใช้ API key/บัตรเครดิต; โครงเป็น adapter อยู่แล้ว เปลี่ยนเป็น Google Maps ได้เมื่อ user มี key (สเปคให้ทำ adapter, default Google — เบี่ยงเพราะติด credential)
2. **WS ทิศทางเดียว (server→customer)** — caregiver ส่ง ping ผ่าน REST ทุก 30 วิ แล้ว server fan-out เข้า `/ws/care/track/:bookingId`; ลด surface ของ WS ลงครึ่งหนึ่ง โดย UX เท่ากัน (caregiver ไม่ต้องรับ push เพราะ offers ใช้ polling อยู่แล้ว)
3. **WS auth ด้วย JWT query param + เช็คความเป็นเจ้าของ booking** ตอน upgrade; token ปลอม → 401, ไม่ใช่เจ้าของ → 403 (ทดสอบแล้ว)
4. **Geofence เฟสนี้เช็ค "detour metric"** (ระยะ pickup→จุดปัจจุบัน→จุดหมาย ยาวกว่าเส้นตรง >2 กม. → `geofence_alert` event + log) — การเช็คหยุดนิ่ง >20 นาทีต้องมี history analysis จะมาพร้อม ops tooling; แจ้ง LINE admin group ใน M5
5. **Auto-complete 24 ชม. แบบ lazy** (จาก `checkout_at`) เหมือน auto-confirm/expiry — แนวเดียวกันทั้งระบบ
6. **Escrow release ตอน completed = mark payment released + jobs_completed++** — payout_ledger (เงินเข้ากระเป๋า caregiver) เป็นของ M5 ตามตาราง milestone
7. **Ping buffer ฝั่ง client เป็น in-memory retry** — offline queue เต็มรูป (service worker, ครอบ check-in/out + health record) เป็นข้อ M6 ตามสเปค
8. **location_pings ยังไม่ partition** — pilot scale ใช้ตาราง+index พอ มี comment ใน migration ให้ใช้ pg_partman ก่อนสเกล

## ค้างตัดสินใจ / ติดตาม

- Baseline Supabase migration tracking (ไฟล์ 001/003/004/005 ถูก apply โดยไม่ track) — จะทำตอนเริ่ม M1 ก่อน migration ใหม่ตัวแรก
- Pin version ใน `backend/package.json` (ตอนนี้เป็น `latest` หลายตัว) — แนะนำทำใน M6 hardening
- SMS provider จริง (Thaibulksms/SMSMKT) — ก่อน production
