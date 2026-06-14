# 20 — Deploy อุ่นใจ Care Platform บน Render

> สถานะ (2026-06-14): โค้ด M0–M6 อยู่บน `main` แล้ว, migration 007–014 apply ขึ้น Supabase แล้ว,
> backend `eldercare-erp` auto-deploy โค้ดใหม่แล้ว **แต่ยังขาด env ของ care platform**
> และ static PWA สองตัวยังไม่ถูกสร้าง/sync ครบ — ทำตามขั้นตอนด้านล่างให้จบ

## สถาปัตยกรรม deploy (3 services จาก `render.yaml`)

| Service | ชนิด | URL | สถานะตอนนี้ |
|---|---|---|---|
| `eldercare-erp` | web (node) | https://eldercare-erp.onrender.com | โค้ด live, ขาด env care |
| `aunjai-care-customer` | static | https://aunjai-care-customer.onrender.com | live แต่ build ไม่มี API base |
| `aunjai-care-caregiver` | static | https://aunjai-care-caregiver.onrender.com | ยังไม่ถูกสร้าง (404) |

---

## ขั้นที่ 1 — เพิ่ม env ของ care ใน backend service เดิม

ไปที่ Render Dashboard → service **eldercare-erp** → **Environment** → เพิ่มทีละตัว
(service นี้ถูกสร้าง manual ก่อนมี blueprint จึงไม่ดึง env ใหม่อัตโนมัติ):

```
CARE_JWT_SECRET=MQAtIR_xBPXbmzcczVqihVnsYmToPZ2aAHNQ0LhFF2zHdwI6yKTqeDkEiWjGiRLM
CARE_ENCRYPTION_KEY=IJnVsIh2uXmGpG5Ir3aj_mosyBmebydpBcvoXWCJVvVDaxaqhxd35jgcSVV68wo-
CARE_DOCUMENTS_BUCKET=care-documents
CARE_PAYMENT_GATEWAY=mock
CARE_SMS_PROVIDER=mock
CARE_AUTH_RATE_LIMIT_MAX=30
CARE_API_RATE_LIMIT_MAX=600
CARE_PORTAL_BASE_URL=https://aunjai-care-customer.onrender.com
CARE_CAREGIVER_PORTAL_BASE_URL=https://aunjai-care-caregiver.onrender.com
```

แล้วแก้ค่าเดิมหนึ่งตัวให้ครอบ origin ของ portal:
```
ELDERCARE_CORS_ORIGINS=https://eldercare-erp.onrender.com,https://aunjai-care-customer.onrender.com,https://aunjai-care-caregiver.onrender.com
```

> **สำคัญ:** `CARE_JWT_SECRET` / `CARE_ENCRYPTION_KEY` ด้านบน generate ไว้ให้แล้ว — เก็บเป็นความลับ
> ถ้าเปลี่ยน `CARE_ENCRYPTION_KEY` ภายหลัง เลขบัตร ปชช. ที่เข้ารหัสไว้เดิมจะ decrypt ไม่ได้

กด **Save** → service จะ redeploy เอง

## ขั้นที่ 2 — สร้าง static PWA สองตัวจาก Blueprint

Render Dashboard → **Blueprints** → เลือก repo `kaopunch/eldercare-erp` →
**Sync** (Render จะอ่าน `render.yaml` แล้วสร้าง `aunjai-care-customer` + `aunjai-care-caregiver`
พร้อม `VITE_API_BASE_URL=https://eldercare-erp.onrender.com` ที่ฝังตอน build)

> ถ้า `aunjai-care-customer` มีอยู่แล้วแต่ build เก่าไม่มี API base → เข้า service นั้น →
> ตรวจว่ามี env `VITE_API_BASE_URL=https://eldercare-erp.onrender.com` → **Manual Deploy → Clear build cache & deploy**

## ขั้นที่ 3 — ตรวจหลัง deploy

```bash
# backend care api ต้อง login ได้ (ได้ access_token ไม่ใช่ CONFIG_MISSING)
curl -s -X POST https://eldercare-erp.onrender.com/api/v1/customer/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"0800000001","password":"password123"}'

# PWA ทั้งสองตอบ 200
curl -s -o /dev/null -w "%{http_code}\n" https://aunjai-care-customer.onrender.com/
curl -s -o /dev/null -w "%{http_code}\n" https://aunjai-care-caregiver.onrender.com/
```

เปิด https://aunjai-care-customer.onrender.com → สมัคร/login → จองได้ครบ flow
(โหมด mock: OTP + ชำระเงินจะสำเร็จทันที)

---

## เปิดใช้ของจริง (ภายหลัง — ไม่ block pilot)

### Omise (payment จริง)
1. สมัคร https://dashboard.omise.co → เอา test keys (`pkey_test_`, `skey_test_`)
2. backend env: `OMISE_SECRET_KEY=skey_test_...` แล้วเปลี่ยน `CARE_PAYMENT_GATEWAY=omise`
3. Omise Dashboard → Webhooks → เพิ่ม `https://eldercare-erp.onrender.com/api/v1/payments/webhook/omise`
   (โค้ด verify โดย re-fetch charge จาก Omise API ไม่เชื่อ payload ตรงๆ)

### LINE (แจ้งเตือนจริง)
1. ทำตาม `docs/19_line_integration_setup.md` (มีอยู่แล้ว) — ออก Channel Access Token + Channel Secret
2. backend env: `LINE_CHANNEL_ACCESS_TOKEN=...`, `LINE_CHANNEL_SECRET=...`
   (มี secret → webhook จะ verify `X-Line-Signature`), `CARE_LINE_OA_URL=...`,
   `CARE_LINE_ADMIN_GROUP_ID=...` (กลุ่มรับ SOS/geofence)
3. LINE Developers Console → Webhook URL = `https://eldercare-erp.onrender.com/api/v1/line/webhook`
4. ผู้ใช้กด "เชื่อม LINE" ในแอป → ได้รหัส `CARE-XXXXXX` → พิมพ์ในแชท OA → ผูก `line_user_id`

> ไม่ตั้ง 2 อย่างนี้ ระบบยังเดินได้: payment = mock (สำเร็จทันที), แจ้งเตือน = log ลง `care_notifications`
