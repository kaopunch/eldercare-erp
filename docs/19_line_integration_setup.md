# LINE Integration Setup

เอกสารนี้เป็น checklist สำหรับเปิดใช้งาน LINE จริง (ออกจาก mock mode) ทั้งฝั่งส่งข้อความแจ้งเตือนลูกค้า (outbound) และฝั่งรับข้อความเข้า AI Ops (inbound)

## สถานะ Code (พร้อมแล้ว)

- `backend/src/lib/line.js` — ส่ง LINE push message ผ่าน Messaging API; ถ้าไม่ตั้ง `LINE_CHANNEL_ACCESS_TOKEN` จะ fallback เป็น mock (`provider: line_mock_no_token`) อัตโนมัติ ไม่ error
- `GET /api/readiness` มี check `line.config` (`pass` เมื่อมี `LINE_CHANNEL_ACCESS_TOKEN`)
- `POST /api/notifications/:id/send` — ส่งข้อความจริงผ่าน LINE (หรือ mock ถ้า `force_mock:true` หรือยังไม่ตั้ง token)
- `POST /api/ai/inbound/line` — รับ webhook event จาก LINE Messaging API เข้า AI Ops Center (ป้องกันด้วย `ELDERCARE_AI_WEBHOOK_SECRET`)
- ข้อความเป็นภาษาไทยทั้งหมด อยู่ใน `TYPE_MESSAGES` (`backend/src/lib/line.js`)

สิ่งที่เหลือคือ **งาน setup ภายนอก** (ต้องทำโดยคุณ เพราะต้องใช้บัญชี LINE/อีเมลธุรกิจของบริษัท):

## ขั้นตอนที่ต้องทำ (ภายนอกระบบ)

### 1. สร้าง LINE Official Account + Messaging API Channel

1. ไปที่ https://entry.line.biz/start/th/ สมัคร LINE Official Account (ใช้บัญชี LINE ของบริษัท)
2. ไปที่ https://developers.line.biz/console/ (LINE Developers Console) → login ด้วยบัญชีเดียวกัน
3. สร้าง **Provider** (ชื่อบริษัท เช่น "SandyCare" หรือ "ElderCare ERP")
4. ภายใต้ Provider สร้าง **Channel** ชนิด **Messaging API**
5. กรอกข้อมูล channel: ชื่อ, คำอธิบาย, หมวดหมู่ธุรกิจ, ไอคอน

### 2. ดึง Channel Access Token

1. ในหน้า Channel → แท็บ **Messaging API**
2. เลื่อนไปที่ **Channel access token** → กด **Issue** เพื่อสร้าง long-lived token
3. คัดลอก token นี้ไว้ (จะใช้เป็นค่า `LINE_CHANNEL_ACCESS_TOKEN`) — **ห้ามแชร์ในที่สาธารณะ**

### 3. ตั้งค่า Webhook (สำหรับรับข้อความเข้า AI Ops)

1. ในแท็บ **Messaging API** → **Webhook settings**
2. ตั้ง Webhook URL เป็น:
   ```
   https://<your-render-domain>/api/ai/inbound/line?secret=<ELDERCARE_AI_WEBHOOK_SECRET>
   ```
   (ระบบตรวจสิทธิ์ inbound webhook ด้วย shared secret ผ่าน query string `secret=` หรือ header `x-eldercare-webhook-secret`/`Authorization: Bearer <secret>` — **ไม่ใช่** LINE signature `x-line-signature` ดังนั้นต้องแนบ `secret` ผ่าน query string ตามรูปแบบข้างต้น)
3. เปิด **Use webhook** = Enabled
4. ปิด **Auto-reply messages** และ **Greeting messages** ของ LINE OA default (เพื่อไม่ให้ชนกับข้อความที่ระบบส่งเอง) — ทำได้ใน LINE Official Account Manager (https://manager.line.biz/)

### 4. ตั้งค่า Environment Variables

**Local (`backend/.env`)** — uncomment และใส่ค่า:
```
LINE_CHANNEL_ACCESS_TOKEN=<token จากขั้นตอนที่ 2>
```

**Render Dashboard** (`eldercare-erp` service → Environment):
```
LINE_CHANNEL_ACCESS_TOKEN=<token จากขั้นตอนที่ 2>
```
(`render.yaml` มีตัวแปรนี้เป็น `sync: false` อยู่แล้ว — ต้องไปกรอกค่าใน Dashboard เอง)

### 5. ทำให้ลูกค้ามี `line_id` (สำหรับรับ push message)

ระบบส่ง push message ไปยัง `customers.line_id` (LINE userId ของลูกค้า) ซึ่งต้องได้มาจาก:

- ลูกค้า**เพิ่มเพื่อน LINE OA** ของบริษัทก่อน (push message ส่งได้เฉพาะคนที่ add friend แล้วเท่านั้น)
- ตอนลงทะเบียนผ่าน portal (`POST /api/portal/register`) ให้กรอกฟิลด์ `line_id` (LINE userId) — ปกติต้องใช้ LINE Login/LIFF เพื่อดึง userId อัตโนมัติ ซึ่ง**ยังไม่ได้ทำใน frontend ของโปรเจกต์นี้** (เป็นงานเพิ่มเติมถ้าต้องการ auto-capture)
- ทางเลือก manual: staff กรอก `line_id` ของลูกค้าใน `customers` table ผ่าน admin UI/API (`PATCH` ที่ `customers.js`)

## วิธีทดสอบหลังตั้งค่าเสร็จ

1. ตั้ง `LINE_CHANNEL_ACCESS_TOKEN` ใน `.env` แล้ว restart server
2. เช็ค readiness: `GET /api/readiness` → `line.config` ควรเป็น `pass`
3. หา/สร้าง customer ที่มี `line_id` เป็น LINE userId ของแอดมิน/เพื่อนร่วมทีมที่ add friend LINE OA แล้ว (ทดสอบกับตัวเองก่อน)
4. สร้าง notification แล้วส่งจริง:
   ```
   POST /api/notifications  { "booking_id": "...", "notification_type": "booking_confirmed", "channel": "line", "payload": {} }
   POST /api/notifications/:id/send   (ไม่ส่ง force_mock)
   ```
5. ตรวจว่าได้รับข้อความใน LINE จริง และ response มี `provider: "line"`, `provider_status: "sent"`
6. ทดสอบ inbound: ส่งข้อความหา LINE OA จากมือถือ → ตรวจ `GET /api/ai/ops-center` ว่ามี conversation ใหม่เข้ามา

## Rollback / Fallback

- ถ้ายังไม่พร้อม หรือ token หมดอายุ/ผิด ระบบจะ fallback เป็น mock โดยอัตโนมัติ ไม่ทำให้ flow หลักพัง (`provider: line_mock` หรือ `line_mock_no_token`)
- ถ้า LINE push ส่งไม่สำเร็จ (`LINE_PUSH_FAILED`) ให้ดู `notifications.payload.provider_response` สำหรับ error message จาก LINE API (เช่น token หมดอายุ, ลูกค้ายังไม่ add friend)
