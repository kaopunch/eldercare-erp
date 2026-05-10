# ElderCare Multi-Service ERP Starter v2

ระบบ ERP สำหรับธุรกิจดูแลผู้สูงวัยแบบ multi-service ตาม MASTER SOP v2 ครอบคลุม transport, hospital companion, home companion, medical coordination และ family monitoring

## เป้าหมายระบบ
- บริหารลูกค้า/ผู้สูงวัย/ผู้ติดต่อฉุกเฉิน
- บริหาร lead, assessment, consent และ booking หลายประเภทบริการ
- บริหารคนขับ/ผู้ช่วยดูแล/รถ
- สร้าง workflow timeline ตาม service type
- บันทึก family update, visit summary, incident escalation และ branch checklist
- Screening + Training + Certification
- Dispatch งาน
- Incident / Complaint / Rating
- PDPA consent และ audit log
- Dashboard สำหรับผู้บริหาร

## โครงสร้าง
- `database/001_schema.sql` : Supabase/PostgreSQL schema
- `backend/` : Node.js Express API
- `frontend/index.html` : UI mockup แบบพร้อมเปิดดู
- `docs/` : SOP, legal checklist, training manual, implementation plan

## SOP workflow ที่มีใน backend
- Customer/Elder/Consent: `POST /api/customers`, `POST /api/elders`, `PATCH /api/elders/:id`, `POST /api/consents`, `GET /api/elders/:id/consents`
- Booking core: `POST /api/bookings`, `POST /api/bookings/:id/quote`, `POST /api/bookings/:id/confirm`, `POST /api/bookings/:id/cancel`, `POST /api/bookings/:id/segments`
- SOP v2 workflow: `GET /api/sop/v2/templates`, `POST /api/sop/leads`, `POST /api/sop/elder-assessments`, `POST /api/sop/branch-checklists`, `GET /api/sop/sla-escalations`
- Visit execution control: `POST /api/bookings/:id/family-updates`, `POST /api/bookings/:id/visit-summary`, `POST /api/bookings/:id/complete`, `GET /api/bookings/:id/compliance`
- Assignment: `GET /api/assignments/recommend?booking_id=...`, `POST /api/assignments`, `POST /api/assignments/:id/accept`, `POST /api/assignments/:id/reject`
- Trip operation: `POST /api/trips/:booking_id/checklist`, `POST /api/trips/:booking_id/events`, `POST /api/trips/:booking_id/location`, `POST /api/trips/:booking_id/complete`
- Incident/finance/training: `POST /api/incidents`, `POST /api/incidents/:id/close`, `POST /api/drivers/:id/training-attempts`, `POST /api/payments`, `POST /api/invoices`, `POST /api/refunds`

ระบบ backend บังคับ business rules หลักจาก SOP แล้ว เช่น assisted/hospital/home ต้องมี sensitive consent, confirmation ต้องมี mandatory consent ตาม SOP v2, hospital/home companion ต้องมี care assistant, high/critical ต้อง dispatcher approve ก่อน confirm, confirmed booking ต้องมี approved quote, inactive driver/รถ maintenance assign ไม่ได้, event ต้องเรียงตาม workflow template, high incident จะ freeze closure, visit summary ต้องไม่วินิจฉัยโรค และ completion ต้องผ่าน compliance check ก่อนปิดงาน

## วิธีเริ่มใช้งานแบบเร็ว
1. สร้าง Supabase project
2. เปิด SQL Editor แล้วรัน `database/001_schema.sql`
3. เข้าโฟลเดอร์ `backend`
4. คัดลอก `.env.example` เป็น `.env`
5. ใส่ค่า `SUPABASE_URL` และ `SUPABASE_SERVICE_ROLE_KEY`
6. รัน:
```bash
npm install
npm run dev
```
7. เปิด `http://localhost:8080` เพื่อใช้งานผ่าน backend จริง หรือเปิด `frontend/index.html` เพื่อดู mockup แบบไฟล์โลคัล

ถ้าเปิดผ่าน `frontend/index.html` โดยตรง หน้าเว็บจะพยายามเชื่อม API ที่ `http://localhost:8081` แล้วค่อยลอง `http://localhost:8080` อัตโนมัติ สามารถ override ได้จาก browser console:
```js
localStorage.setItem('eldercare.apiBase', 'http://localhost:8080')
```

ถ้าฐานข้อมูลเดิมยังไม่มีตาราง AI realtime ให้รันไฟล์นี้ใน Supabase SQL Editor:
```sql
database/004_ai_realtime_operations.sql
```

AI inbound webhook สำหรับ provider จริง:
- `POST /api/ai/inbound/line`
- `POST /api/ai/inbound/whatsapp`
- `POST /api/ai/inbound/twilio`
- `POST /api/ai/inbound/web_chat`

ตั้งค่า `ELDERCARE_AI_WEBHOOK_SECRET` เพื่อป้องกัน webhook และตั้งค่า `ELDERCARE_AI_ANALYSIS_URL` ถ้าต้องการให้ระบบเรียก external AI classifier ก่อน fallback เป็น guardrail rule ภายใน

Dashboard ผู้บริหารอ่าน `executive` payload จาก `GET /api/dashboard/summary` โดย backend คำนวณ status chart, progress, alerts และ AI/realtime counters จากฐานข้อมูลจริง

AI outbound หลังอนุมัติงานใช้ `POST /api/ai/tasks/:id/notify` เพื่อสร้าง notification ราย recipient, ส่ง LINE ได้ทันทีเมื่อมี `LINE_CHANNEL_ACCESS_TOKEN`, หรือส่งผ่าน gateway กลางด้วย `ELDERCARE_OUTBOUND_DELIVERY_URL` สำหรับ WhatsApp/SMS/โทรศัพท์ พร้อมอัปเดต `party_presence` และ `realtime_events`

## ตรวจสอบ logic
ในโฟลเดอร์ `backend` รัน:
```bash
npm test
```

ชุด test ปัจจุบันครอบคลุม risk classification, consent enforcement, quote/confirmation, assignment lock, trip event order, no-show evidence, incident close และ driver activation rule

## Deploy ฟรีขึ้นคลาวด์

แนะนำ Render Free Web Service + Supabase เดิมของระบบ ดูขั้นตอนที่ `docs/11_free_cloud_deploy_render.md`

ไฟล์ `render.yaml` เตรียมไว้แล้วสำหรับ Render Blueprint โดยใช้:
- Build command: `cd backend && npm ci`
- Start command: `cd backend && npm start`
- Health check: `/health`

## หมายเหตุสำคัญ
ระบบนี้ถูกออกแบบเป็น ERP ใหม่เฉพาะธุรกิจ ElderCare Transport ไม่ใช่โมดูลเสริมจาก ERP เดิม
แต่ยังจัดโครงสร้างแบบ integration-ready เพื่อเชื่อมกับบัญชี, POS, CRM หรือระบบเดิมได้ในอนาคต
