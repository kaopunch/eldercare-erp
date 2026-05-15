# Customer Delight Plan: Family Confidence Layer

เป้าหมายรอบนี้คือเปลี่ยน Customer Portal จากหน้าดูสถานะพื้นฐานให้เป็น family confidence layer ที่ครอบครัวเห็นความปลอดภัย ความคืบหน้า การชำระเงิน และสรุปหลังจบงานได้ในที่เดียว

## Priority 1: Live Customer Portal

- แสดง customer journey ตาม workflow ของแต่ละ service type ไม่ใช่ timeline รถรับส่งแบบเดียว
- แสดง current step, progress, last update และ next action ให้ญาติเข้าใจทันทีว่าตอนนี้ต้องทำอะไร
- แสดง trust card ของ driver, care assistant และ vehicle พร้อมสัญญาณความพร้อม เช่น driver level, rating, training, verified documents และสถานะรถ
- แสดง payment balance, invoice/payment history และ rating action ในหน้าเดียว
- แสดง latest location เฉพาะเมื่อมี location consent

## Priority 2: LINE / Customer Notification Experience

- customer notification เปลี่ยน default channel เป็น LINE สำหรับ family audience
- notification payload แนบ portal links เช่น status, rating และ consent link
- LINE message copy เป็นภาษาไทยตาม event type เช่น booking confirmed, arrived pickup, trip started, summary approved และ service completed
- ข้อความแนบ family summary/message เมื่อเป็นข้อมูลที่ลูกค้าควรเห็น

## Priority 3: Post-Service Care Summary

- Portal อ่าน approved visit summary และ family updates มาแสดงเป็น care summary
- แสดง visit outcome, family summary, next appointment และ follow-up requirement
- ไม่ส่ง `hidden_operational_note` หรือ internal concern ออกไปที่ customer portal
- หลังจบงาน หากยังไม่มี approved summary ให้หน้า portal บอกว่าทีมกำลังสรุป

## Priority 4: Service Recovery

- ถ้าลูกค้าให้ rating ต่ำ ระบบมี service recovery state สำหรับเปิดเคสติดตาม
- Driver ถูกตั้งสถานะ reviewing และ queue notification ให้ทีม operation
- Portal แสดง recovery card เฉพาะเคสที่ active หรือ rating ต่ำจริง

## Implemented In This Milestone

- Backend customer experience helper: `backend/src/lib/customerExperience.js`
- Portal payload now includes:
  - `journey` / `customer_journey`
  - `trust` / `trust_card`
  - `care_summary`
  - `line_experience`
  - `service_recovery`
  - `next_action`
  - `latest_location` gated by location consent
- LINE/customer notification copy improved in `backend/src/lib/line.js`
- Customer notification payload links improved in `backend/src/lib/notifications.js`
- Customer Portal UI upgraded in `frontend/index.html`
- Focused tests added in `backend/tests/customerJourney.test.js`

## Next Recommended Milestone

- Add portal token expiry and stronger access rules for public status/rating links
- Add payment QR/payment link and customer-side slip upload
- Add LINE read receipt / acknowledgement sync
- Add mobile-first visual QA with real seeded bookings for completed, in-progress, low-rating, and no-assignment states
