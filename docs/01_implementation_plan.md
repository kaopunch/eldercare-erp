# แผนพัฒนา ERP ใหม่: ElderCare Transport ERP

## Phase 1: Core Foundation
- Company / Branch / User / Role
- Customer / Elder Profile
- PDPA Consent
- Booking + risk classification
- Quote + booking confirmation guard
- Driver / Vehicle
- Assignment recommendation + assignment lock
- Trip checklist/event timeline
- Incident workflow baseline

สถานะใน starter: schema และ backend core API สำหรับรายการด้านบนถูกเพิ่มแล้วใน `database/001_schema.sql` และ `backend/src/routes/*` พร้อม business-rule tests ใน `backend/tests/businessRules.test.js`

## Phase 2: Driver Quality System
- Driver application
- Document verification
- Screening score
- Training module
- Certification level

## Phase 3: Operations
- Dispatch board
- Trip status tracking
- Photo evidence
- LINE notification
- Driver mobile UI

## Phase 4: Safety & Compliance
- Incident report
- Auto escalation
- Driver suspension rule
- Audit log
- Privacy access control

## Phase 5: Business Intelligence
- Revenue dashboard
- Utilization per vehicle
- Driver rating
- Repeat booking
- CAC/LTV marketing metrics

## หลักการออกแบบ
- Pre-booked service ไม่ใช่ taxi on-demand
- Non-emergency assisted transport ไม่ใช่ ambulance
- เก็บข้อมูลสุขภาพเท่าที่จำเป็นและมี consent
- ขยายแบบหลายสาขาได้
