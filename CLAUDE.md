# CLAUDE.md — อุ่นใจ Care Platform

> ไฟล์นี้คือกติกาประจำ repo สำหรับ Claude Code — อ่านคู่กับ `DEVELOPMENT_SPEC.md` เสมอ
> `DEVELOPMENT_SPEC.md` = อะไรต้องสร้าง / ไฟล์นี้ = สร้างอย่างไร

## ภาพรวม

Two-sided marketplace จับคู่ครอบครัวกับผู้ดูแลผู้สูงวัย ต่อยอดจากระบบ Eldercare Core เดิม
- Backend: **Node.js/Express + Supabase (PostgreSQL + PostGIS)** — ตามมติ user 2026-06-11
  (ดู `docs/CORE_AUDIT.md` + `docs/DECISIONS.md`; สเปคเดิม assume FastAPI แต่ audit พบระบบจริงเป็น Node)
- ไม่ใช้ Redis เฟสนี้ — realtime ใช้ `ws` + Supabase Realtime
- Frontend: React 18 + Vite + Tailwind (PWA สองตัว: customer, caregiver)
- ดูสถาปัตยกรรม, schema, state machine ทั้งหมดใน `DEVELOPMENT_SPEC.md`

## คำสั่งหลัก

```bash
cd backend && npm run dev              # Express API (อ่าน .env — ชี้ Supabase)
cd backend && npm test                 # node --test (ต้องผ่านก่อน commit ทุกครั้ง)
cd frontend/customer && npm run dev    # port 5173
cd frontend/caregiver && npm run dev   # port 5174
```

DB migration: ไฟล์ SQL เรียงเลขใน `database/` + apply ผ่าน Supabase migration
(track ทุกไฟล์) — **additive เท่านั้น** ห้าม drop/alter ตารางเดิมของ ERP

## กติกาเหล็ก (ห้ามละเมิด)

1. **ห้ามแก้โค้ด Eldercare Core เดิม** (`backend/src/routes/`, `backend/src/lib/` เดิม) โดยไม่อธิบาย impact และขอยืนยันก่อน — โค้ดใหม่อยู่ใน `backend/src/modules/`
2. **ห้ามแก้ schema ตรงๆ** — ทุกการเปลี่ยน DB เป็นไฟล์ SQL เรียงเลขใน `database/` apply ผ่าน Supabase migration (track ทุกไฟล์) พร้อม comment วิธี rollback; additive เท่านั้น
3. **Secret อ่านจาก env เท่านั้น** — เพิ่ม key ใหม่ต้องอัปเดต `.env.example` พร้อม comment
4. **ห้ามเพิ่ม dependency นอก whitelist** (ดู SPEC ข้อ 8) โดยไม่ถาม
5. **state transition ทุกตัว** ต้องเรียกผ่าน `BookingStateMachine.transition()` เท่านั้น ห้าม set `booking.status` ตรงๆ ที่ใดในโค้ด
6. **เลขบัตรประชาชน / ข้อมูลสุขภาพ**: ห้าม log, ห้ามใส่ใน error message, ห้าม return ใน API ที่ไม่ได้ระบุไว้ใน SPEC
7. เจอความกำกวม → ถามก่อนเดา แล้วบันทึกคำตอบลง `docs/DECISIONS.md` (format: วันที่ / คำถาม / คำตอบ / ผลต่อโค้ด)

## Convention — Backend

- Node.js 20+, CommonJS ตามโค้ดเดิม (`require`), JSDoc type hints ใน module ใหม่
- โครงสร้างต่อโมดูล: `router.js` (endpoint บางๆ) → `service.js` (business logic) → `repository.js` (Supabase query) — ห้ามเขียน query ใน router
- Validate input ด้วย zod schema แยก `xxxCreateSchema / xxxUpdateSchema` — response ตัด field ที่ไม่ได้ระบุใน SPEC ออกเสมอ (ไม่ส่ง row ดิบ)
- เงินทุกค่าเป็น **int สตางค์** ห้าม float — แปลงเป็นบาทเฉพาะชั้น presentation
- เวลาเก็บ UTC timezone-aware ทั้งหมด แปลงเป็น Asia/Bangkok เฉพาะตอนแสดงผล/แจ้งเตือน
- Custom exception สืบทอดจาก `AppError(code, message_th)` — handler กลางแปลงเป็น JSON `{code, message}` (message เป็นภาษาไทยสำหรับผู้ใช้)
- ทุก service function ที่เปลี่ยนสถานะ booking ต้อง idempotent — เขียน test ยืนยันการเรียกซ้ำ
- Test: `node --test` ตามเดิม — logic ล้วน (state machine, pricing, cancel rules) test แบบ unit; ชั้น repository mock Supabase client แบบบางตามแนว test เดิมใน `backend/tests/`

## Convention — Frontend

- ภาษา UI ไทยทั้งหมด — string อยู่ใน `shared/i18n/th.ts` ห้าม hardcode ใน component
- State: zustand (เลือกแล้ว ไม่ใช้ redux) / Server state: TanStack Query
- API client gen จาก OpenAPI (`npm run gen:api`) — ห้ามเขียน fetch ดิบนอก `shared/api/`
- Component ใช้ function + hooks, ไฟล์ละ component หลักเดียว, ชื่อไฟล์ PascalCase
- Caregiver portal: ทุกปุ่ม action หลักสูง ≥ 56px, font หลัก ≥ 16px, ออกแบบใช้มือเดียว
- Mutation ที่สำคัญหน้างาน (check-in/out, health record) ต้องเข้า offline queue (service worker) — ห้ามทำให้ user เสียข้อมูลเพราะสัญญาณหลุด

## Git

- Branch: `feat/m{N}-{สั้นๆ}` เช่น `feat/m2-booking-state-machine`
- Commit: conventional commits ภาษาอังกฤษ (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`)
- หนึ่ง milestone = หนึ่ง PR — จบ milestone ต้องสรุป: ไฟล์ที่แตะ, วิธีทดสอบด้วยมือ, decision ที่ตัดสินใจแทน

## สถานะปัจจุบัน

- [x] M0 — audit + scaffold   (2026-06-11 — ดู docs/CORE_AUDIT.md, docs/DECISIONS.md)
- [ ] M1 — auth + profiles + onboarding   ← **ถัดไป (รอ review M0)**
- [ ] M2 — booking core + payment
- [ ] M3 — matching + accept
- [ ] M4 — active job + tracking
- [ ] M5 — LINE + health profile + wallet
- [ ] M6 — hardening

(อัปเดต checklist นี้เมื่อจบแต่ละ milestone)
