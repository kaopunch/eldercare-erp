# DEVELOPMENT SPEC — อุ่นใจ Care Platform
## Customer Portal + Caregiver Portal (ต่อยอดจากระบบ Eldercare Core เดิม)

> **เอกสารนี้เขียนสำหรับ Claude Code** ใช้เป็น single source of truth ในการพัฒนา
> วางไฟล์นี้ไว้ที่ root ของ repo และอ้างอิงทุกครั้งที่เริ่ม session ใหม่
> ภาษา UI: ไทยเป็นหลัก / โครงสร้างโค้ด ตัวแปร comment: อังกฤษ

---

## 0. บริบทโปรเจกต์

แพลตฟอร์ม two-sided marketplace จับคู่ **ครอบครัว (Customer)** กับ **ผู้ดูแลผู้สูงวัย (Caregiver)**
สำหรับบริการพาผู้สูงวัยไปโรงพยาบาล/ทำธุระรายครั้ง โดยมี **Eldercare Core** (ระบบเดิมที่พัฒนาไว้แล้ว)
เป็นชั้นควบคุม: state machine ของงาน, GPS tracking, บันทึกสุขภาพ, แจ้งเตือนครอบครัว

สิ่งที่ต้องพัฒนาใหม่ในงานนี้:
1. **Customer Portal** — เว็บ/PWA ฝั่งครอบครัว
2. **Caregiver Portal** — เว็บ/PWA ฝั่งผู้ดูแล (ใช้งานหน้างานบนมือถือ)

สิ่งที่ **ไม่อยู่ใน scope** งานนี้: Admin dashboard, B2B module, ระบบประกันภัย (เตรียม interface ไว้พอ)

---

## PHASE 0 — Audit ระบบเดิมก่อนเขียนโค้ดใดๆ (บังคับ)

ก่อนเริ่มพัฒนา Claude Code ต้อง:

1. สำรวจ repo เดิมของ Eldercare Core: โครงสร้างโฟลเดอร์, framework/version, database schema ที่มีอยู่
2. สร้างไฟล์ `docs/CORE_AUDIT.md` สรุป:
   - ตาราง/model ที่มีอยู่แล้ว (ชื่อ, field สำคัญ)
   - API endpoint ที่มีอยู่แล้ว
   - ระบบ auth เดิม (ถ้ามี)
   - ส่วนที่ตรง/ไม่ตรงกับ assumption ในเอกสารนี้
3. **ถ้า schema เดิมขัดแย้งกับสเปคนี้** → เสนอ migration plan ให้ user อนุมัติก่อน ห้าม drop/alter ตารางเดิมโดยพลการ
4. ถ้า Eldercare Core เดิมยังไม่มีส่วนใดตามที่สเปคนี้ assume (เช่น ยังไม่มี state machine) → สร้างส่วนนั้นเป็นโมดูลใหม่ใน `core/` ตามสเปคข้อ 3

**Assumption เกี่ยวกับระบบเดิม** (ปรับตามผล audit):
- Backend: Python / FastAPI
- DB: PostgreSQL (ถ้ายังไม่มี PostGIS ให้เพิ่ม extension)
- มีแนวคิด health record / elder profile อยู่บ้างแล้ว

---

## 1. สถาปัตยกรรมรวม

```
┌─────────────────┐   ┌─────────────────┐
│ Customer Portal │   │ Caregiver Portal│   (PWA, mobile-first)
└────────┬────────┘   └────────┬────────┘
         │      REST + WebSocket │
┌────────┴───────────────────────┴────────┐
│            FastAPI Backend              │
│  /api/v1/customer/*   /api/v1/caregiver/*│
│  ┌────────────────────────────────────┐ │
│  │        ELDERCARE CORE (เดิม)        │ │
│  │ job state machine · geofencing     │ │
│  │ health records · notification engine│ │
│  └────────────────────────────────────┘ │
└──────┬──────────┬───────────┬───────────┘
   PostgreSQL   Redis      External:
   + PostGIS  (pub/sub,   LINE Messaging API
              cache)      Payment GW (Omise)
```

### Tech stack (ยึดตามนี้เว้นแต่ audit พบว่าระบบเดิมใช้อย่างอื่น)
| ชั้น | เทคโนโลยี |
|---|---|
| Backend | FastAPI (Python 3.11+), SQLAlchemy 2.x, Alembic migrations |
| DB | PostgreSQL 15+ + PostGIS |
| Cache / Realtime | Redis (pub/sub สำหรับ location updates) |
| Frontend | React 18 + Vite, PWA (service worker), TailwindCSS |
| Realtime client | WebSocket (native) ผ่าน endpoint `/ws/*` |
| Auth | JWT (access 15 นาที + refresh 30 วัน), OTP ผ่าน SMS สำหรับสมัคร |
| แจ้งเตือน | LINE Messaging API (push) + in-app + SMS fallback |
| Payment | Omise (PromptPay + card) — wrap ไว้หลัง `PaymentGateway` interface เพื่อสลับเป็น 2C2P ได้ |
| Maps | Longdo Map หรือ Google Maps JS (ทำเป็น adapter, default Google) |

### โครงสร้าง repo (monorepo)
```
/backend
  /app
    /core          # Eldercare Core (เดิม + ส่วนเสริม)
    /modules
      /auth
      /customer
      /caregiver
      /booking
      /payment
      /notification
    /models
    /schemas       # Pydantic
    main.py
  /alembic
  /tests
/frontend
  /customer        # Customer Portal (React PWA)
  /caregiver       # Caregiver Portal (React PWA)
  /shared          # UI components, api client, types ที่ใช้ร่วม
/docs
  CORE_AUDIT.md
  API.md           # auto-generate จาก OpenAPI + คำอธิบายเพิ่ม
```

---

## 2. Database Schema (ตารางใหม่ + ส่วนต่อขยาย)

> ใช้ Alembic migration ทุกครั้ง ห้ามแก้ schema ตรงๆ
> ทุกตารางมี `id UUID PK`, `created_at`, `updated_at` (timezone-aware, เก็บ UTC)

### users
| field | type | note |
|---|---|---|
| phone | varchar(15) unique | login หลัก, format E.164 |
| email | varchar nullable | |
| password_hash | varchar | argon2 |
| role | enum: customer, caregiver, admin | user หนึ่งคนมีได้ role เดียว |
| line_user_id | varchar nullable | ผูกตอน user เพิ่มเพื่อน LINE OA |
| status | enum: active, suspended, pending_verification | |

### elder_profiles (ฝั่ง customer สร้าง — อาจมีบางส่วนใน Core เดิมแล้ว)
| field | note |
|---|---|
| owner_user_id FK users | ลูกหลานที่สร้างโปรไฟล์ |
| full_name, nickname, birth_date, gender | |
| blood_type, weight_kg, height_cm | optional |
| chronic_conditions | jsonb array เช่น ["เบาหวาน","ความดัน"] |
| medications | jsonb array {name, dose, schedule} |
| allergies | jsonb array |
| mobility | enum: walk, cane, walker, wheelchair, bedridden(ปฏิเสธงาน) |
| primary_hospital | varchar |
| home_address + home_location geography(Point) | |
| special_notes | text เช่น "หูตึงข้างซ้าย พูดดังๆ" |
| photo_url | |

### caregiver_profiles
| field | note |
|---|---|
| user_id FK users unique | |
| full_name, birth_date, gender, photo_url | |
| id_card_number_encrypted | เข้ารหัส AES, แสดงเฉพาะ admin |
| background | enum: nurse_retired, nurse_assistant, health_student, trained_general |
| certificates | jsonb array {type, file_url, verified_at} |
| languages | jsonb array เช่น ["th","en"] — "en" = รับงาน premium ได้ |
| service_area | geography(Polygon) หรือ center point + radius_km |
| base_rate_half_day, base_rate_full_day | int (บาท) |
| verification_status | enum: pending, documents_submitted, verified, rejected |
| verified_badge | bool — ผ่านตรวจประวัติอาชญากรรม + อบรม |
| rating_avg numeric(3,2), rating_count int | denormalized, อัปเดตผ่าน trigger/service |
| wallet_balance | int (สตางค์) — single source ใน ledger, field นี้ denormalized |

### bookings (หัวใจของระบบ — ผูกกับ state machine ของ Core)
| field | note |
|---|---|
| customer_user_id FK, elder_profile_id FK, caregiver_user_id FK nullable | |
| service_type | enum: hospital_visit, errand, companion |
| scheduled_date, pickup_time | |
| pickup_location geography(Point) + pickup_address | |
| destination_name, destination_location, destination_address | |
| appointment_detail | text — แผนก, ชื่อแพทย์, เลขนัด |
| special_requirements | jsonb เช่น {"wheelchair": true, "english": false} |
| duration_type | enum: half_day, full_day |
| price_total, platform_fee, caregiver_payout | int สตางค์ — snapshot ตอนยืนยัน |
| status | enum — ดู state machine ข้อ 3 |
| cancelled_by, cancel_reason, cancelled_at | nullable |

### booking_events (append-only event log — Core เดิมอาจมีแล้ว)
| field | note |
|---|---|
| booking_id FK | |
| event_type | enum: created, paid, matched, accepted, checkin_home, arrived_destination, service_note_added, departing, checkout_home, customer_confirmed, completed, cancelled, sos, geofence_alert |
| actor | enum: customer, caregiver, system, admin |
| location geography(Point) nullable | |
| payload jsonb | รูปถ่าย url, ข้อความ ฯลฯ |

### service_health_records (เชื่อม Health Profile ของ Core)
| field | note |
|---|---|
| booking_id FK, elder_profile_id FK | |
| vital_signs jsonb | {bp, pulse, temp} optional |
| doctor_summary | text — ผู้ดูแลสรุปสิ่งที่แพทย์แจ้ง |
| medications_received | jsonb array |
| next_appointment | {date, department, note} nullable |
| attachments | jsonb array of file urls (ใบนัด, ฉลากยา) |

### payments / payout_ledger / reviews / notifications
- `payments`: booking_id, amount, method, omise_charge_id, status (pending, held_escrow, released, refunded), timestamps
- `payout_ledger`: caregiver_user_id, booking_id nullable, type (earning, withdrawal, adjustment), amount signed, balance_after — **append-only**
- `reviews`: booking_id, direction (customer_to_caregiver / caregiver_to_customer), stars 1–5, comment, tags jsonb
- `caregiver_availability`: caregiver_user_id, date, slots jsonb — ปฏิทินรับงาน
- `location_pings`: booking_id, location, recorded_at — partition รายเดือน, เก็บ 90 วัน

---

## 3. Booking State Machine (สัญญากลางระหว่างสองพอร์ทัล)

```
draft → pending_payment → searching → matched → confirmed
  → in_progress_pickup → at_destination → returning
  → pending_confirmation → completed
                         ↘ disputed (admin จัดการ)
ยกเลิกได้จาก: pending_payment..confirmed → cancelled (มีกติกาค่าธรรมเนียมข้อ 3.1)
```

| สถานะ | เปลี่ยนโดย | side effects (Core notification engine ยิงทุกจุด) |
|---|---|---|
| pending_payment | system หลัง customer สร้าง booking | หมดอายุใน 30 นาทีถ้าไม่จ่าย → cancelled |
| searching | system หลังจ่ายสำเร็จ (escrow held) | broadcast งานไป caregiver ที่ match (ข้อ 5.2) |
| matched | caregiver กดรับงาน | แจ้ง customer + เริ่มนับ confirm window |
| confirmed | อัตโนมัติเมื่อ customer ไม่ปฏิเสธใน 2 ชม. หรือกดยืนยันเอง | ส่งรายละเอียดเต็มให้สองฝั่ง |
| in_progress_pickup | caregiver check-in ที่บ้าน (ถ่ายรูป + GPS ห่างจุดรับ ≤ 300 ม.) | LINE → ครอบครัว, เริ่ม location ping ทุก 30 วิ |
| at_destination | อัตโนมัติจาก geofence ถึงจุดหมาย หรือ caregiver กดยืนยัน | LINE → ครอบครัว |
| returning | caregiver กด "เริ่มเดินทางกลับ" | LINE → ครอบครัว |
| pending_confirmation | caregiver check-out ที่บ้าน (GPS ≤ 300 ม. จากจุดรับ) | LINE ขอให้ customer กดยืนยัน |
| completed | customer กดยืนยัน หรือ auto หลัง 24 ชม. | ปล่อย escrow → payout_ledger, เปิดรีวิว, บันทึก service_health_records เข้า Health Profile |

**Geofencing rules (อยู่ใน Core — ถ้ายังไม่มีให้สร้าง):**
- ระหว่าง in_progress_pickup → at_destination: ถ้าออกนอกเส้นทาง (เบี่ยงเกิน 2 กม. จาก route) หรือหยุดนิ่ง > 20 นาทีโดยไม่อยู่ที่จุดหมาย → สร้าง `geofence_alert` event + แจ้ง ops (เฟสนี้: log + LINE ไป admin group)
- ปุ่ม SOS ใน caregiver app: สร้าง `sos` event ทันที ไม่ผ่าน queue

### 3.1 กติกายกเลิก (เขียนเป็น config ไม่ hardcode)
| ยกเลิกเมื่อ | customer ได้คืน | caregiver ได้ |
|---|---|---|
| ก่อนงาน > 24 ชม. | 100% | 0 |
| 6–24 ชม. | 80% | 10% ของ payout |
| < 6 ชม. | 50% | 30% ของ payout |
| caregiver ยกเลิกหลัง confirmed | 100% + คูปอง | โดน strike (3 strikes = suspend) |

---

## 4. CUSTOMER PORTAL — สเปคหน้าจอและ API

Mobile-first ทุกหน้า รองรับ desktop แบบ responsive
เส้นทาง: `app.aunjaicare.com` (ตัวอย่าง)

### 4.1 หน้าและฟีเจอร์

**C1. Auth**
- สมัคร: เบอร์โทร + OTP (SMS) → ตั้งรหัสผ่าน → ชื่อ
- Login: เบอร์ + รหัสผ่าน / OTP
- หน้า "เชื่อม LINE" — ปุ่มเพิ่มเพื่อน LINE OA พร้อม link token เพื่อผูก line_user_id

**C2. จัดการโปรไฟล์ผู้สูงวัย** (`/elders`)
- CRUD โปรไฟล์ผู้สูงวัย (customer หนึ่งคนมีได้หลายโปรไฟล์ เช่น พ่อและแม่)
- ฟอร์มตาม schema `elder_profiles` — แบ่ง 3 step: ข้อมูลทั่วไป → สุขภาพ/ยา → ที่อยู่+ความช่วยเหลือ
- ปักหมุดบ้านบนแผนที่ (สำคัญ: ใช้เป็นจุด pickup default)

**C3. จองบริการ** (`/book`) — flow หลัก 4 ขั้น
1. เลือกผู้สูงวัย + ประเภทงาน + วันเวลา + จุดหมาย (search สถานพยาบาล autocomplete) + รายละเอียดนัด
2. ความต้องการพิเศษ (checkbox: วีลแชร์, ภาษาอังกฤษ, เพศผู้ดูแล)
3. เห็นราคาทันที (pricing engine ข้อ 5.1) — โปร่งใส แตกบรรทัด: ค่าบริการ + ประกัน + ค่าธรรมเนียม
4. ชำระเงิน: PromptPay QR / บัตร → เข้าสถานะ searching
- รองรับ "จองด่วน" (วันนี้/พรุ่งนี้) และจองล่วงหน้าสูงสุด 30 วัน

**C4. หน้าติดตามเรียลไทม์** (`/bookings/:id/track`) — **หน้า signature ของผลิตภัณฑ์**
- แผนที่เต็มจอ: ตำแหน่ง caregiver สด (WebSocket), จุดรับ, จุดหมาย
- Timeline เหตุการณ์ด้านล่าง (จาก booking_events) พร้อมรูป check-in
- แสดงชื่อ+รูป+เบอร์ caregiver (เบอร์ masked, โทรผ่าน app proxy ถ้าทำได้ — เฟสแรกแสดงเบอร์จริงหลัง confirmed)
- ปุ่มฉุกเฉิน "ติดต่อทีมงาน"

**C5. รายการจอง** (`/bookings`) — upcoming / past, ใบเสร็จ, ปุ่มยกเลิก (แสดงกติกาคืนเงินก่อนยืนยัน)

**C6. Health Profile** (`/elders/:id/health`) — จุดขาย switching cost
- Timeline บันทึกสุขภาพจากทุกเที่ยว (service_health_records)
- นัดครั้งถัดไปที่ระบบจับได้ → ปุ่ม "จองผู้ดูแลสำหรับนัดนี้" (prefill ฟอร์มจอง)
- Export PDF สรุปประวัติ (เฟสนี้: print stylesheet พอ)

**C7. รีวิว** — หลัง completed บังคับ popup ครั้งแรกที่เปิด app: ดาว + tag + comment

### 4.2 Customer API (prefix `/api/v1/customer`)
```
POST   /auth/register            POST /auth/otp/verify     POST /auth/login
GET    /elders                   POST /elders              PATCH /elders/{id}
POST   /bookings/quote           # คำนวณราคาก่อนจอง
POST   /bookings                 # สร้าง draft → pending_payment
POST   /bookings/{id}/pay        # สร้าง charge Omise, webhook ยืนยัน
GET    /bookings?status=         GET  /bookings/{id}
POST   /bookings/{id}/cancel     POST /bookings/{id}/confirm-complete
GET    /bookings/{id}/events     # timeline
GET    /elders/{id}/health-records
POST   /reviews
WS     /ws/bookings/{id}/track   # auth ด้วย JWT query param, ส่ง location + event ใหม่
```

---

## 5. CAREGIVER PORTAL — สเปคหน้าจอและ API

ออกแบบเพื่อ **ใช้มือเดียวบนมือถือหน้างาน** ปุ่มใหญ่ ตัวหนังสือใหญ่ ทำงานต่อได้เมื่อสัญญาณหลุดชั่วคราว (queue request ใน service worker แล้ว retry)

### 5.1 Pricing engine (shared module `modules/booking/pricing.py`)
- input: service_type, duration_type, special_requirements, pickup↔destination distance, premium(english)
- ราคา = base ของ duration + distance surcharge + premium multiplier (config ใน DB table `pricing_rules` — แก้ได้โดยไม่ deploy)
- output: price_total, platform_fee (20% default), caregiver_payout, insurance_fee
- เขียน unit test ครอบทุก rule

### 5.2 Matching (shared module `modules/booking/matching.py`)
เมื่อ booking เข้า searching:
1. Query caregiver ที่: verified, available วันนั้น (caregiver_availability), service_area ครอบ pickup point (PostGIS `ST_Contains`/`ST_DWithin`), ผ่าน filter special_requirements (เพศ/ภาษา)
2. จัดอันดับ: rating desc → ระยะทางใกล้ → จำนวนงานสำเร็จ
3. ส่ง push แจ้งงานใหม่ทีละชุด (batch 5 คน, รอ 10 นาที, แล้วชุดถัดไป) — first-accept-wins ด้วย row lock กัน race
4. ไม่มีใครรับใน 4 ชม. (หรือเหลือ < 3 ชม. ก่อนเวลานัด) → แจ้ง customer + เสนอเลื่อน/คืนเงินเต็ม

### 5.3 หน้าและฟีเจอร์

**G1. สมัครและยืนยันตัวตน** (`/onboard`) — wizard 4 step
1. ข้อมูลส่วนตัว + รูปถ่ายหน้าตรง
2. อัปโหลดเอกสาร: บัตรประชาชน, วุฒิ/ใบรับรอง (เก็บ private bucket, URL หมดอายุ)
3. พื้นที่ให้บริการ (วาดวงรัศมีบนแผนที่) + อัตราค่าบริการ + ภาษา
4. สถานะรอตรวจ → หน้า pending พร้อมเช็คลิสต์ว่าขาดอะไร
- ยังไม่ verified: เข้าระบบได้แต่รับงานไม่ได้

**G2. ปฏิทินรับงาน** (`/availability`) — กดเปิด/ปิดเป็นรายวัน + ช่วง (เช้า/บ่าย/เต็มวัน), ตั้ง recurring รายสัปดาห์ได้

**G3. งานใหม่** (`/jobs`) — การ์ดงานที่ match: วันเวลา, พื้นที่ (ไม่โชว์บ้านเลขที่เต็มก่อนรับ), ค่าตอบแทนสุทธิที่จะได้, requirement
- ปุ่ม "รับงาน" → confirm dialog → matched
- countdown แสดงเวลาที่งานจะถูกส่งให้คนอื่น

**G4. หน้างาน Active Job** (`/jobs/{id}/active`) — **หน้าใช้งานหนักสุด ออกแบบเป็น step ตาม state machine**
- ปุ่มใหญ่ปุ่มเดียวต่อ step: "เช็คอินรับผู้สูงวัย" (เปิดกล้องถ่ายรูป → ยืนยัน GPS) → "ถึงจุดหมาย" → "บันทึกข้อมูลสุขภาพ" → "เริ่มเดินทางกลับ" → "เช็คเอาท์ส่งถึงบ้าน"
- ฟอร์มบันทึกสุขภาพ (step 4): สรุปคำแพทย์ (textarea + ปุ่มอัดเสียงแปลงเป็นข้อความถ้า browser รองรับ), ยาที่ได้ (เพิ่มทีละรายการ + ถ่ายรูปฉลากยา), นัดถัดไป (date picker), แนบรูปใบนัด
- ข้อมูลผู้สูงวัยที่จำเป็นแสดงตลอด: รูป, ชื่อเล่น, mobility, โรคประจำตัว, special_notes, เบอร์ฉุกเฉินครอบครัว
- ปุ่ม **SOS สีแดง** มุมขวาบนทุก step
- ระหว่างงาน: ส่ง location ping ทุก 30 วิ (Geolocation watchPosition → WS; ถ้า WS หลุด เก็บ buffer ส่งย้อนหลัง)

**G5. กระเป๋าเงิน** (`/wallet`) — ยอดคงเหลือ, ประวัติ ledger, ถอนเข้าบัญชีธนาคาร (เฟสนี้: สร้างคำขอถอน → admin โอน manual → กดยืนยัน; เตรียม interface ไว้ต่อ payout API)

**G6. โปรไฟล์สาธารณะ + รีวิวที่ได้รับ** (`/profile`)

### 5.4 Caregiver API (prefix `/api/v1/caregiver`)
```
POST   /onboard/profile          POST /onboard/documents    GET /onboard/status
GET    /availability             PUT  /availability
GET    /jobs/offers              POST /jobs/{id}/accept
GET    /jobs/active              GET  /jobs/history
POST   /jobs/{id}/checkin        # multipart: photo + lat/lng — validate ระยะ
POST   /jobs/{id}/arrive         POST /jobs/{id}/departing
POST   /jobs/{id}/health-record  POST /jobs/{id}/checkout
POST   /jobs/{id}/sos
GET    /wallet                   POST /wallet/withdraw
WS     /ws/caregiver             # รับ offer ใหม่ + ส่ง location pings
```

---

## 6. Notification matrix (ผ่าน Core notification engine)

| เหตุการณ์ | ถึง customer | ถึง caregiver | ช่องทาง |
|---|---|---|---|
| จ่ายเงินสำเร็จ | ✓ ใบเสร็จ | — | LINE + in-app |
| มีงานใหม่ match | — | ✓ | LINE + push |
| caregiver รับงาน | ✓ โปรไฟล์ผู้ดูแล | ✓ ยืนยัน | LINE |
| ทุก checkpoint (checkin/arrive/departing/checkout) | ✓ ข้อความ + เวลา + ลิงก์ track | — | LINE |
| geofence/SOS | — (เฟสนี้ไป admin) | — | LINE admin group |
| ขอยืนยันจบงาน | ✓ | — | LINE |
| เงินเข้ากระเป๋า | — | ✓ | LINE |
- ทุกข้อความ LINE มี deep link กลับเข้า portal
- ถ้า user ไม่ผูก LINE → fallback SMS เฉพาะ event สำคัญ (รับงาน, checkin, checkout)

---

## 7. Non-functional requirements

**ความปลอดภัย / PDPA**
- ข้อมูลสุขภาพ = sensitive data: เก็บ consent record (เวอร์ชันข้อความ + timestamp) ตอนสร้าง elder_profile
- เลขบัตรประชาชน เข้ารหัส at-rest, ไม่ log, ไม่ส่งกลับ API ใดๆ
- ไฟล์เอกสาร/รูป: private storage, signed URL อายุ ≤ 15 นาที
- Rate limit auth endpoints, RBAC ตรวจ role ทุก route (dependency injection)
- Audit: ทุก endpoint ที่อ่านข้อมูลสุขภาพ log access (user, เวลา, record)

**คุณภาพ**
- pytest coverage ≥ 80% สำหรับ `modules/booking` (state machine, pricing, matching, cancel rules)
- ทุก state transition ต้อง idempotent (กดซ้ำไม่พัง) และตรวจ allowed transition ก่อนเสมอ
- OpenAPI docs สมบูรณ์ — frontend gen types จาก schema
- ภาษาไทยทั้ง UI; แยก string ไว้ใน i18n file ตั้งแต่แรก (เตรียม EN สำหรับ premium tier)
- Lighthouse PWA installable ทั้งสอง portal; caregiver portal ต้องทำงาน offline-tolerant ใน active job

---

## 8. ลำดับการพัฒนา (ให้ Claude Code ทำทีละ milestone, ขอ review ก่อนขึ้น milestone ถัดไป)

| M | ขอบเขต | Definition of done |
|---|---|---|
| M0 | Phase 0 audit + scaffold repo + CI (lint, test) + docker-compose (pg+postgis, redis) | `docs/CORE_AUDIT.md` ผ่าน review, `docker compose up` รันได้ |
| M1 | Auth + users + elder_profiles + caregiver onboarding (G1) + migration ทั้งหมด | สมัคร/ล็อกอินสองฝั่งได้จริง, เอกสารอัปโหลดเข้า private storage |
| M2 | Booking core: quote → create → pay (Omise sandbox) → state machine + cancel rules + unit tests | จองและจ่าย sandbox ครบ flow ถึง searching |
| M3 | Matching + caregiver jobs (G2, G3) + accept flow | งาน broadcast และรับงานได้ first-accept-wins |
| M4 | Active job (G4) + check-in/out + health record + location WS + tracking page (C4) | เดิน flow จริงครบ in_progress → completed, customer เห็นแผนที่สด |
| M5 | LINE integration + notification matrix + Health Profile page (C6) + reviews + wallet | ทุก checkpoint เด้ง LINE, ledger ถูกต้องหลัง completed |
| M6 | Hardening: PDPA audit log, rate limit, offline queue caregiver, Lighthouse, E2E test หลัก 1 เส้น | E2E booking→complete ผ่านอัตโนมัติ |

**กติกาการทำงานของ Claude Code:**
1. ก่อนแก้ Eldercare Core เดิมทุกครั้ง → อธิบาย impact + ขอยืนยัน
2. ทุก milestone จบด้วย: รายการไฟล์ที่เพิ่ม/แก้, วิธีทดสอบด้วยมือ, สิ่งที่ตัดสินใจแทน user (พร้อมเหตุผล)
3. ไม่เพิ่ม dependency ใหญ่โดยไม่ถาม (อนุญาตล่วงหน้า: fastapi, sqlalchemy, alembic, pydantic, redis, httpx, pytest, react, vite, tailwind, react-router, zustand/jotai)
4. Secret ทั้งหมดอ่านจาก env (.env.example ต้องครบ) ห้าม hardcode
5. เจอความกำกวมในสเปค → ถามก่อนเดา และบันทึกคำตอบลง `docs/DECISIONS.md`
