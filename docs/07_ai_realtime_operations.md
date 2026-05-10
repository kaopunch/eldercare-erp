# AI Realtime Operations Blueprint

เป้าหมายคือทำให้ระบบ ElderCare Transport เป็น operations network ที่ทุกฝ่ายเห็นสถานะเดียวกันแบบ realtime และใช้ AI call center ช่วยแอดมินลดงานซ้ำ ลดการสื่อสารผิด และบังคับตรวจข้อมูลสำคัญก่อนส่งต่อ

## Actors
- ผู้ว่าจ้าง: เจ้าของ booking หรือผู้จ่ายเงิน ต้องเห็นราคา เวลา คนขับ สถานะ และหลักฐาน
- ผู้รับจ้าง: คนขับ ผู้ช่วยดูแล หรือ partner ต้องเห็นงานที่ได้รับ route เงื่อนไขผู้สูงวัย และ SLA
- ผู้รับบริการ: ผู้สูงวัยหรือญาติหน้างาน ต้องได้รับข้อมูลที่เข้าใจง่ายและถูกต้อง
- แอดมินระบบ: ผู้ตรวจสอบขั้นสุดท้ายเมื่อ AI confidence ต่ำ หรือเป็น action ที่มีความเสี่ยง

## AI Call Center Flow
1. รับสายหรือข้อความจาก phone, LINE, WhatsApp, web chat
2. ถอดความและแยก intent เช่น create booking, reschedule, route confirm, complaint, medical warning
3. ดึง context จาก booking, elder profile, driver status, consent และ incident history
4. สรุปเป็น admin task พร้อม confidence score และข้อมูลที่ต้องตรวจ
5. ถ้า confidence สูงและเป็น low-risk action ให้เสนอ one-click approval
6. ถ้า confidence ต่ำ มีข้อมูลสุขภาพ หรือกระทบความปลอดภัย ให้ escalate ให้แอดมินยืนยัน
7. เมื่อยืนยันแล้ว ระบบส่งข้อความมาตรฐานให้ทุกฝ่ายจาก source of truth เดียวกัน
8. บันทึก audit log ของ input, AI summary, human approval, outgoing messages และ state changes

## Realtime Model
- ทุก event ต้องเขียนลง `trip_events`, `assignments`, `incidents`, `audit_logs`
- frontend subscribe event channel แยกตาม role และ permission
- booking status, driver status, ETA, incident status และ consent status ต้องอัปเดตทันที
- notification ทุกชิ้นต้องอ้างอิง `booking_id`, `actor`, `recipient_role`, `message_template`, `delivery_status`

## Zero-tolerance Guardrails
- ยืนยันตัวตนผู้ติดต่อก่อนแก้ booking
- ตรวจ PDPA consent ก่อนใช้ข้อมูลสุขภาพหรือ location
- ตรวจ route, pickup time, elder mobility, medical notes ก่อนแจ้งคนขับ
- ตรวจ driver availability, license, training, vehicle status ก่อน assign
- critical/high incident ต้อง lock งานและแจ้งแอดมินทันที
- ทุกข้อความที่ AI เตรียมส่งต้องมี preview และ approval state
- ไม่มีการลบ audit log; ใช้ append-only history

## Suggested Backend Modules
- `ai_conversations`: transcript, intent, confidence, summary, source channel
- `ai_admin_tasks`: generated task, risk level, required checks, approval status
- `notifications`: normalized outbound messages and delivery receipts
- `realtime_events`: event stream for dashboards and mobile apps
- `party_presence`: latest online/acknowledged state per role
- `verification_checks`: identity, consent, route, medical, driver, audit checks

## Current Implementation
- Database schema and RLS policies now include the AI realtime tables above.
- Backend API is mounted at `/api/ai` for owner, admin, and dispatcher roles.
- `GET /api/ai/ops-center` returns conversations, admin tasks, verification checks, party presence, and realtime events for the AI Ops Center.
- `POST /api/ai/conversations` classifies risk/confidence, creates a conversation, creates admin tasks when human review is required, seeds verification checks, writes realtime events, and writes audit logs.
- `POST /api/ai/tasks/:id/verify` updates guardrail checks and only approves a task when all checks are approved.
- `POST /api/ai/tasks/:id/notify` queues normalized notifications to the relevant parties and records the outgoing realtime event.
- `PATCH /api/ai/presence` updates each party's online/acknowledged state for realtime status visibility.
- `GET /api/ai/stream` provides a role-protected Server-Sent Events stream for AI realtime events after login.
- The AI realtime stream now allows admin/dispatcher full visibility while driver and care-assistant sessions only receive events targeted to their role or assigned booking context.
- `POST /api/ai/inbound/:channel` accepts provider webhooks for `line`, `whatsapp`, `phone`, `sms`, `web_chat`, and generic `in_app` messages. Protect this route with `ELDERCARE_AI_WEBHOOK_SECRET` before connecting real providers.
- Optional external AI analysis can be enabled with `ELDERCARE_AI_ANALYSIS_URL` and `ELDERCARE_AI_ANALYSIS_SECRET`. If it is not configured or fails, the backend falls back to deterministic guardrail rules.
- Executive Dashboard summary from `/api/dashboard/summary` now includes backend-computed `executive` charts, progress rows, alerts, and AI/realtime counters.
- `POST /api/ai/tasks/:id/notify` now requires approved AI tasks before outbound delivery, creates per-recipient notifications, sends immediately when possible, writes recipient realtime events, and updates `party_presence`.
- LINE can be delivered directly with `LINE_CHANNEL_ACCESS_TOKEN`. Other outbound channels can be bridged through `ELDERCARE_OUTBOUND_DELIVERY_URL`; without a provider, those notifications remain queued with delivery hints instead of silently pretending to send.
- Frontend AI Ops Center now reads `/api/ai/ops-center`, calls the create/verify/notify endpoints, and falls back to demo data when the API or migration is unavailable.
- For an existing Supabase database that already has the core ERP tables, run `database/004_ai_realtime_operations.sql` to add only the AI realtime schema and policies.

## Provider Webhook Examples
LINE Messaging API text events can call:
`POST /api/ai/inbound/line`

WhatsApp Cloud API message events can call:
`POST /api/ai/inbound/whatsapp`

Twilio Voice/SMS callbacks can call:
`POST /api/ai/inbound/twilio`

Use either `Authorization: Bearer <ELDERCARE_AI_WEBHOOK_SECRET>` or `X-Eldercare-Webhook-Secret: <ELDERCARE_AI_WEBHOOK_SECRET>` on every provider webhook request.

## Success Metrics
- 100% critical actions have human approval or explicit policy approval
- 100% outbound updates are generated from canonical booking state
- 0 unverified high-risk field changes
- median admin response time under 2 minutes for AI-generated tasks
- all parties can see current status and last confirmed update
