# UAT Playbook: Core Workflow and Finance

เอกสารนี้ใช้สำหรับทดสอบ UAT ก่อน pilot go-live โดยให้ทีมแอดมิน, dispatcher, coordinator, finance, driver และ care assistant ทำตามลำดับเดียวกัน และบันทึกผล pass/fail พร้อม screenshot หรือ booking number ที่เกี่ยวข้อง

## UAT Entry Criteria

ก่อนเริ่ม UAT ต้องมีสถานะเหล่านี้:

- Render `/health` ตอบ `200`
- `GET /api/auth/config` เป็น `mode=pin` และ `demo_allowed=false`
- Supabase migration `001-005` ถูก apply ครบ
- มีผู้ใช้ active พร้อม PIN อย่างน้อย: admin, dispatcher, coordinator, finance, driver, care assistant
- มีข้อมูลพื้นฐาน: company, branch, vehicle, driver, training modules, consent text version
- Private bucket `payment-evidence` พร้อมใช้งาน
- ถ้ามี LINE integration ให้ตั้ง `LINE_CHANNEL_ACCESS_TOKEN`; ถ้ายังไม่มี ให้ทดสอบ fallback/queued notification

คำสั่งตรวจเบื้องต้น:

```bash
cd backend
npm test
npm audit --omit=dev --audit-level=moderate
npm run verify:runtime -- --base-url=https://eldercare-erp.onrender.com
```

## Test Data Convention

ใช้ prefix เดียวกันเพื่อค้นหาข้อมูลง่าย:

- Customer name: `UAT Family <date>`
- Elder name: `UAT Elder <date>`
- Booking note: `UAT core workflow`
- Payment transaction ref: `UAT-PAY-<booking_no>`

ตัวอย่างวันที่ให้ใช้รูปแบบ `2026-06-08` หรือวันทดสอบจริง

## UAT 1: Lead to Qualified Case

Role: coordinator หรือ dispatcher

Steps:

1. เปิดเมนู Lead Intake
2. สร้าง lead ใหม่จากช่องทาง `LINE OA` หรือ `phone`
3. ใส่ชื่อผู้ติดต่อ, เบอร์โทร, ชื่อผู้สูงวัย, service interest และ urgency
4. บันทึก lead
5. กลับมาที่รายการ lead แล้วกรอง/ค้นหา lead ที่เพิ่งสร้าง
6. เปลี่ยนสถานะเป็น contacted/qualified ถ้า UI รองรับ หรือบันทึก note ต่อท้าย

Expected result:

- Lead ถูกสร้างสำเร็จ
- Lead แสดงในรายการล่าสุด
- Audit log มี action `lead.created`

Pass/Fail:

- Pass เมื่อ operator เห็น lead และนำไปทำ assessment/booking ต่อได้
- Fail ถ้าบันทึกไม่ได้, ข้อมูลหาย, หรือ error message ไม่ชัดเจน

## UAT 2: Customer, Elder, Consent, Assessment

Role: coordinator

Steps:

1. สร้าง customer profile
2. สร้าง elder profile ใต้ customer เดียวกัน
3. บันทึก consent อย่างน้อย:
   - `general_service`
   - `sensitive_health`
   - `family_notification`
   - `location_tracking` ถ้าจะทดสอบ tracking/portal journey
4. เปิด Elder Assessment
5. บันทึก mobility, fall risk, chronic diseases, wheelchair required และ risk level
6. ตรวจว่า elder profile แสดง risk/mobility ล่าสุด

Expected result:

- Customer และ elder ถูกสร้างสำเร็จ
- Consent ล่าสุดของ elder เป็น consented=true สำหรับ consent ที่จำเป็น
- Assessment ถูกบันทึกและ sync กลับ elder profile

Pass/Fail:

- Pass เมื่อ assessment ใช้เปิด booking form ต่อได้
- Fail ถ้า assisted/hospital booking ไม่เห็น consent ทั้งที่บันทึกแล้ว

## UAT 3: Booking, Quote, Confirmation

Role: dispatcher

Scenario A: assisted ride หรือ hospital companion

Steps:

1. สร้าง booking จาก elder ที่ผ่าน UAT 2
2. เลือก service type `hospital_companion` หรือ `assisted_ride`
3. ใส่ pickup/dropoff, pickup time, appointment details และ family contact
4. บันทึก booking
5. สร้าง quote และ approve quote
6. Confirm booking

Expected result:

- Booking มี booking number
- Workflow snapshot ถูกสร้างใน `booking_workflows`
- ถ้าเป็น hospital/home companion ต้องมี care assistant ก่อนยืนยันตาม rule
- ถ้า risk high/critical ต้องมี dispatcher approval ก่อน confirm
- Confirm ไม่ผ่านถ้าไม่มี consent/quote ที่จำเป็น

Pass/Fail:

- Pass เมื่อ booking status เป็น `confirmed`
- Fail ถ้าระบบยืนยันงานที่ขาด consent หรือ quote ได้

## UAT 4: Assignment and Field Acceptance

Role: dispatcher, driver, care assistant

Steps:

1. เปิด Assignment recommendation สำหรับ booking ที่ confirmed
2. เลือก driver ที่ active และผ่าน training
3. เลือก vehicle ที่ available
4. เลือก care assistant ถ้า service type ต้องใช้
5. Assign งาน
6. Login เป็น driver หรือใช้ role driver ในสภาพแวดล้อมทดสอบ
7. Accept assignment

Expected result:

- ระบบ block driver inactive/suspended หรือ vehicle maintenance
- Assignment status เปลี่ยนเป็น accepted
- Booking พร้อมเริ่ม trip execution

Pass/Fail:

- Pass เมื่อ driver/care assistant เห็นงานที่เกี่ยวข้องเท่านั้น
- Fail ถ้า role ที่ไม่เกี่ยวข้องเห็นข้อมูลเกินจำเป็น

## UAT 5: Trip Execution and Family Updates

Role: driver, care assistant, dispatcher

Steps:

1. ทำ pre-trip/pre-visit checklist ให้ completed
2. ส่ง event ตาม workflow:
   - arrived pickup
   - identity verified หรือ pickup condition checked
   - elder onboard/patient onboarded
   - service started หรือ trip started
   - family update
   - arrived dropoff
   - handover completed
3. ทดสอบ event ผิดลำดับหนึ่งครั้งใน booking ทดสอบแยก
4. ตรวจ Notification Center ว่ามี customer/family notification queued หรือ sent

Expected result:

- Event ต้องเรียงตาม SOP
- Event ผิดลำดับต้องถูก block
- Family update ถูกบันทึกและมี notification payload
- Severe symptom payload ต้องสร้าง incident และ hold booking

Pass/Fail:

- Pass เมื่อ timeline ถูกต้องและครอบครัวเห็น update
- Fail ถ้าข้าม checklist หรือปิดงานก่อน workflow ครบได้

## UAT 6: Visit Summary and Completion

Role: care assistant, dispatcher

Steps:

1. ส่ง visit summary แบบ factual เช่น "ถึงโรงพยาบาลตามเวลา รับยาเรียบร้อย"
2. ส่ง visit summary ที่มีคำวินิจฉัยเชิงแพทย์ใน booking ทดสอบแยก
3. Approve visit summary
4. Complete booking

Expected result:

- Summary factual ถูกบันทึกได้
- Summary เชิงวินิจฉัยต้องถูก block
- Booking complete ได้หลัง workflow, family update, summary และ incident checks ผ่าน

Pass/Fail:

- Pass เมื่อ booking status เป็น `completed`
- Fail ถ้าปิดงานทั้งที่ยังขาด summary หรือมี open high/critical incident

## UAT 7: Finance and Payment Evidence

Role: finance

Steps:

1. เปิด Finance Desk สำหรับ booking ที่ completed หรือ confirmed พร้อมยอด
2. สร้าง invoice
3. บันทึก payment
4. แนบ evidence เป็น PNG/JPEG/PDF/WebP
5. เปิด signed URL เพื่อดู evidence
6. สร้าง receipt
7. ทดสอบ refund กรณีมี overpayment หรือ cancellation scenario

Expected result:

- Payment amount ต้องไม่เกิน remaining balance
- Evidence ถูกเก็บเป็น `storage://...` ไม่ใช่ public URL
- View evidence ใช้ signed URL อายุสั้น
- Invoice/receipt PDF แสดงภาษาไทยถูกต้อง

Pass/Fail:

- Pass เมื่อ finance ปิดยอดได้โดยไม่เปิด bucket public
- Fail ถ้า evidence เปิด public หรือ finance role เข้าถึงไม่ได้

## UAT 8: Portal, Rating, and Service Recovery

Role: family user/customer, dispatcher

Steps:

1. เปิด portal status ด้วย booking number หรือ token link
2. ตรวจ journey, team trust card, next action และ care summary
3. หลัง complete ให้ส่ง rating 5 ดาว
4. สร้าง booking ทดสอบอีกใบแล้วส่ง rating 1-2 ดาว
5. ตรวจ service recovery task/notification

Expected result:

- Customer เห็นเฉพาะข้อมูลที่ควรเห็น
- Rating ต่ำสร้าง service recovery review
- Care summary ต้องแสดงเฉพาะ summary ที่ approved

Pass/Fail:

- Pass เมื่อลูกค้าติดตามงานได้โดยไม่ต้องถามทีม
- Fail ถ้า portal expose ข้อมูลภายในหรือ summary ที่ยังไม่ approve

## UAT 9: Readiness, Security, and Admin

Role: admin

Steps:

1. Login ด้วย admin PIN
2. เปิด Security/Readiness
3. ตรวจ checks:
   - auth mode
   - demo auth disabled
   - session secret
   - portal token secret
   - CORS origins
   - Supabase service role
   - credential schema
   - PIN coverage
   - audit table
   - storage bucket
4. สร้าง user ใหม่และ set PIN
5. บังคับ rotate PIN หรือ revoke sessions
6. Logout แล้ว login ใหม่

Expected result:

- `/api/readiness` ไม่มี fail สำหรับ core auth/schema/storage
- Temporary PIN rotation แสดง warning จน user เปลี่ยน PIN
- Revoked session ใช้งานต่อไม่ได้

Pass/Fail:

- Pass เมื่อ admin จัดการ user/session ได้ครบ
- Fail ถ้า demo auth เปิดใน production หรือ readiness core fail

## UAT Sign-Off Template

| Test | Owner | Result | Evidence | Defect ID | Notes |
| --- | --- | --- | --- | --- | --- |
| UAT 1 Lead | Coordinator | Pending |  |  |  |
| UAT 2 Profile/Consent | Coordinator | Pending |  |  |  |
| UAT 3 Booking/Quote | Dispatcher | Pending |  |  |  |
| UAT 4 Assignment | Dispatcher/Driver | Pending |  |  |  |
| UAT 5 Trip | Driver/Care assistant | Pending |  |  |  |
| UAT 6 Completion | Dispatcher | Pending |  |  |  |
| UAT 7 Finance | Finance | Pending |  |  |  |
| UAT 8 Portal/Rating | Customer success | Pending |  |  |  |
| UAT 9 Security | Admin | Pending |  |  |  |

## Defect Severity

- P0: ข้อมูลผิด, เปิดข้อมูลส่วนบุคคลเกินสิทธิ์, ปิดงานผิด SOP, payment/evidence เสี่ยง, production login ใช้ไม่ได้
- P1: flow หลักติดแต่มี workaround ชัดเจน
- P2: UI/copy/รายงานไม่สมบูรณ์ แต่ไม่กระทบการเดินงานจริง
- P3: enhancement หลัง pilot

## Go/No-Go Rule

Go pilot ได้เมื่อ:

- UAT 1-9 ผ่าน หรือมีเฉพาะ P2/P3
- ไม่มี P0/P1 ค้าง
- ทีมรู้ workaround ที่อนุมัติแล้ว
- มี admin on-call และ rollback owner
