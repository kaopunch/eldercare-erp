# API.md — อุ่นใจ Care Platform (`/api/v1`)

> Base: Express backend (port 8080) — auth ด้วย `Authorization: Bearer <access JWT>`
> Error format: `{code, message}` (message ภาษาไทย) — validation 422 มี `details`
> เงินทุกค่าเป็น **int สตางค์** (`*_satang`)

## Auth (สองพอร์ทัล: `/customer/auth/*` และ `/caregiver/auth/*`)

| Method | Path | Body | หมายเหตุ |
|---|---|---|---|
| POST | `/auth/register` | `{phone}` | ส่ง OTP (mock โชว์ `dev_otp` นอก production) |
| POST | `/auth/otp/verify` | `{phone, code, password}` | สมัครเสร็จ + ได้ token |
| POST | `/auth/login` | `{phone, password}` | |
| POST | `/auth/login/otp` | `{phone, code}` | ขอรหัสผ่าน `/auth/otp/request` |
| POST | `/auth/refresh` | `{refresh_token}` | rotation: ตัวเก่าใช้ซ้ำไม่ได้ |
| POST | `/auth/logout` | `{refresh_token}` | idempotent |

Token: access 15 นาที / refresh 30 วัน (opaque, เก็บ hash)

## Customer (`/api/v1/customer`)

| Method | Path | หมายเหตุ |
|---|---|---|
| GET/POST | `/elders` | สร้างต้องมี `consent_accepted: true` (PDPA) |
| GET/PATCH/DELETE | `/elders/:id` | DELETE = soft delete; ทุกการอ่าน audit log |
| GET | `/elders/:id/health-records` | สมุดสุขภาพ (C6) + signed URLs |
| POST | `/bookings/quote` | `{service_type, duration_type, pickup, destination, special_requirements}` |
| POST | `/bookings` | draft→pending_payment (หมดอายุ 30 นาที) |
| GET | `/bookings?scope=upcoming\|past` | |
| GET | `/bookings/:id` | รวมข้อมูล caregiver หลัง matched (เบอร์หลัง confirmed) |
| POST | `/bookings/:id/pay` | `{method: promptpay\|card\|mock}` → escrow → searching |
| POST | `/bookings/:id/confirm` | ยืนยันผู้ดูแล (auto ภายใน 2 ชม.) |
| GET | `/bookings/:id/cancel-preview` | ยอดคืนเงินตาม tier |
| POST | `/bookings/:id/cancel` | searching = คืน 100% เสมอ |
| POST | `/bookings/:id/confirm-complete` | ปล่อย escrow + ledger (auto 24 ชม.) |
| GET | `/bookings/:id/events` | timeline (รูปเป็น signed URL 15 นาที) |
| GET | `/bookings/:id/track` | snapshot สำหรับหน้าแผนที่ |
| GET | `/reviews/pending` / POST `/reviews` | รีวิวหลัง completed ครั้งเดียวต่องาน |
| POST | `/line/link-code` | รหัส `CARE-XXXXXX` อายุ 15 นาที |

## Caregiver (`/api/v1/caregiver`)

| Method | Path | หมายเหตุ |
|---|---|---|
| POST | `/onboard/profile` | เลขบัตรเข้ารหัส AES ไม่ส่งกลับ |
| POST | `/onboard/documents` | base64 JSON ≤6MB → private bucket |
| GET | `/onboard/status` | checklist + signed photo URL |
| GET/PUT | `/availability` | slots `{morning, afternoon}` รายวัน |
| GET | `/jobs/offers` | การ์ดงาน (ที่อยู่ masked ~1กม.) + lazy batch |
| POST | `/jobs/:id/accept` | first-accept-wins (แพ้ได้ 409 JOB_TAKEN) |
| GET | `/jobs/active` / `/jobs/history` / `/jobs/:id` | `:id` มี elder card (audit logged) |
| POST | `/jobs/:id/checkin` | photo + GPS ≤300ม. → in_progress_pickup |
| POST | `/jobs/:id/arrive` `/departing` | |
| POST | `/jobs/:id/health-record` | upsert; รูปยา/ใบนัดเข้า private bucket |
| POST | `/jobs/:id/checkout` | GPS ≤300ม. → pending_confirmation |
| POST | `/jobs/:id/sos` | event ทันที + แจ้ง admin group |
| POST | `/jobs/:id/location` | ping ทุก 30 วิ → WS broadcast + geofence >2กม. |
| GET | `/wallet` / POST `/wallet/withdraw` | ledger append-only; ถอนขั้นต่ำ 100 บาท |
| GET | `/reviews` | รีวิวที่ได้รับ |
| POST | `/line/link-code` | |

## Webhooks / Realtime

| Path | หมายเหตุ |
|---|---|
| POST `/api/v1/payments/webhook/omise` | charge.complete — re-verify ผ่าน Omise API ก่อนเชื่อ |
| POST `/api/v1/line/webhook` | link codes; ตรวจ X-Line-Signature เมื่อมี `LINE_CHANNEL_SECRET` |
| WS `/ws/care/track/:bookingId?token=JWT` | push `{type: status\|location\|event}` — เจ้าของ booking เท่านั้น |

## State machine (สถานะ booking)

```
draft → pending_payment → searching → matched → confirmed
  → in_progress_pickup → at_destination → returning
  → pending_confirmation → completed | disputed
ยกเลิกได้: pending_payment..confirmed → cancelled
```

## Ops scripts (`backend/scripts/`)

- `verify_caregiver.js --phone 08X [--reject "note"]`
- `process_withdrawal.js --list | --id <id> [--reject "note"]`
- `e2e_booking_flow.js` (= `npm run test:e2e`)
