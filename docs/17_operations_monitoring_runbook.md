# Operations Monitoring Runbook

เอกสารนี้ใช้หลัง deploy และระหว่าง pilot เพื่อให้ทีมรู้ว่าต้องดูอะไรทุกวัน และต้องทำอะไรเมื่อระบบส่งสัญญาณผิดปกติ

## Daily Checks

ให้ admin หรือ dispatcher lead ตรวจวันละ 2 รอบ: ก่อนเริ่มงาน และหลังจบงาน

1. เปิด `/health`
   - ต้องตอบ `200`
   - ถ้าไม่ตอบ ให้ตรวจ Render service status และ redeploy ล่าสุด

2. เปิด Security / Readiness หลัง login admin
   - core fail ต้องแก้ก่อนรับ booking ใหม่
   - warning เรื่อง LINE/AI/outbound ยอมรับได้เฉพาะถ้ายังไม่เปิด integration นั้น

3. เปิด Executive Dashboard
   - ดู high risk booking
   - ดู incident hold
   - ดู open incident
   - ดู booking ที่รอ assignment

4. เรียก `GET /api/dashboard/operations-health`
   - ต้อง login เป็น owner/super_admin/admin/branch_admin/dispatcher/coordinator/finance
   - ดู `operations_health.status`
   - ดู `actions` และ `watchlists`

## Operations Health Status

| Status | Meaning | Required action |
| --- | --- | --- |
| `healthy` | ไม่มี action สำคัญค้าง | เดินงานต่อได้ |
| `attention` | มี failed notification หรือ action non-critical | Dispatcher/finance ต้องเคลียร์ภายในวันเดียวกัน |
| `critical` | มี high/critical incident เปิดอยู่ | หยุดปิดงานที่เกี่ยวข้องและ escalate ทันที |

## Metrics to Watch

- `active_bookings`: booking ที่ยังอยู่ใน workflow
- `upcoming_high_risk_24h`: งาน high/critical ใน 24 ชั่วโมง
- `open_incidents`: incident ที่ยังไม่ปิด
- `open_severe_incidents`: high/critical incident ที่ยังไม่ปิด
- `failed_notifications`: notification หรือ realtime delivery ที่ fail
- `pending_visit_summaries`: งาน companion/coordination/monitoring ที่ยังไม่มี approved summary
- `pending_ai_approvals`: AI task ที่ต้อง human review
- `payment_followups`: งานที่ต้องตามยอดชำระหรือหลักฐาน

## Incident Response

### P0: System Down

Trigger:

- `/health` ไม่ตอบ
- login ไม่ได้ทั้งทีม
- Render service crash loop

Actions:

1. ตรวจ Render deployment ล่าสุด
2. Rollback ไป deployment ก่อนหน้าถ้ามี production impact
3. ตรวจ env vars สำคัญ: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ELDERCARE_SESSION_SECRET`
4. เปิด incident log ภายในทีม
5. แจ้ง dispatcher ให้ใช้ manual fallback จนระบบกลับมา

### P0: Sensitive Data or PDPA Risk

Trigger:

- role เห็นข้อมูลเกินสิทธิ์
- consent หายแต่ระบบให้ confirm งาน sensitive
- evidence storage ถูกเปิด public

Actions:

1. หยุด flow ที่เกี่ยวข้องทันที
2. Revoke sessions ของ user ที่เกี่ยวข้อง
3. ตรวจ audit logs
4. ปิด public exposure หรือ rotate secret ถ้าจำเป็น
5. บันทึก remediation และผู้อนุมัติ

### P1: Failed Customer Notification

Trigger:

- `failed_notifications > 0`
- ลูกค้าไม่ได้รับ LINE/portal update

Actions:

1. เปิด Notification Center
2. Retry ถ้ามี provider พร้อม
3. ถ้ายัง fail ให้โทรหรือส่ง LINE manual
4. บันทึก manual contact ใน family update

### P1: Severe Incident Open

Trigger:

- `open_severe_incidents > 0`
- booking status เป็น `incident_hold`

Actions:

1. Dispatcher โทรหา driver/care assistant
2. แจ้งครอบครัวและ emergency contact ตาม SOP
3. บันทึก action taken
4. ห้าม complete booking จน incident review เสร็จ

## Manual Fallback

ถ้าระบบ down ระหว่างงานจริง:

- ใช้โทรศัพท์และ LINE OA/manual group ในการประสาน
- บันทึก timeline ใน shared sheet ชั่วคราว
- เก็บ payment evidence ใน private drive ชั่วคราว
- เมื่อระบบกลับมา ให้ admin backfill trip events, family updates, payment evidence และ audit note

## End-of-Day Sign-Off

ก่อนปิดวัน ทีมต้องยืนยัน:

- ไม่มี open severe incident ที่ยังไม่ assign owner
- booking วันนี้ไม่มีสถานะค้างผิดปกติ
- payment evidence ที่รับวันนี้ถูกอัปโหลดหรือมี fallback owner
- rating ต่ำถูกเปิด service recovery แล้ว
- dashboard/readiness ไม่มี core fail ใหม่
