require('dotenv').config();
const { getSupabase } = require('../src/db/supabase');

const ids = {
  company: '10000000-0000-4000-8000-000000000001',
  branch: '10000000-0000-4000-8000-000000000002',
  adminUser: '10000000-0000-4000-8000-000000000010',
  dispatcherUser: '10000000-0000-4000-8000-000000000011',
  careAssistantA: '10000000-0000-4000-8000-000000000012',
  careAssistantB: '10000000-0000-4000-8000-000000000013',
  driverUserA: '10000000-0000-4000-8000-000000000021',
  driverUserB: '10000000-0000-4000-8000-000000000022',
  driverUserC: '10000000-0000-4000-8000-000000000023',
  customerA: '10000000-0000-4000-8000-000000000101',
  customerB: '10000000-0000-4000-8000-000000000102',
  customerC: '10000000-0000-4000-8000-000000000103',
  customerD: '10000000-0000-4000-8000-000000000104',
  elderA: '10000000-0000-4000-8000-000000000201',
  elderB: '10000000-0000-4000-8000-000000000202',
  elderC: '10000000-0000-4000-8000-000000000203',
  elderD: '10000000-0000-4000-8000-000000000204',
  vehicleA: '10000000-0000-4000-8000-000000000301',
  vehicleB: '10000000-0000-4000-8000-000000000302',
  vehicleC: '10000000-0000-4000-8000-000000000303',
  driverA: '10000000-0000-4000-8000-000000000401',
  driverB: '10000000-0000-4000-8000-000000000402',
  driverC: '10000000-0000-4000-8000-000000000403',
  driverD: '10000000-0000-4000-8000-000000000404',
  bookingA: '10000000-0000-4000-8000-000000000501',
  bookingB: '10000000-0000-4000-8000-000000000502',
  bookingC: '10000000-0000-4000-8000-000000000503',
  bookingD: '10000000-0000-4000-8000-000000000504',
  assignmentA: '10000000-0000-4000-8000-000000000601',
  assignmentC: '10000000-0000-4000-8000-000000000603',
  incidentA: '10000000-0000-4000-8000-000000000701'
};

function demoUuid(group, index) {
  return `10000000-0000-4000-8000-${String(group).padStart(6, '0')}${String(index).padStart(6, '0')}`.slice(0, 36);
}

function bangkokTodayAt(hour, minute = 0) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [year, month, day] = formatter.format(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute, 0)).toISOString();
}

async function upsert(sb, table, rows) {
  const { error } = await sb.from(table).upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(`${table}: ${error.message}`);
}

async function main() {
  const sb = getSupabase();

  await upsert(sb, 'companies', [{
    id: ids.company,
    name: 'ElderCare Transport Demo',
    tax_id: '0105566000000',
    phone: '02-111-8899',
    email: 'ops@eldercare.example',
    address: 'Bangkok'
  }]);

  await upsert(sb, 'branches', [{
    id: ids.branch,
    company_id: ids.company,
    name: 'Bangkok Main',
    phone: '02-111-8899',
    address: 'Ladprao, Bangkok',
    service_area: { city: 'Bangkok', radius_km: 35 }
  }]);

  await upsert(sb, 'app_users', [
    { id: ids.adminUser, company_id: ids.company, branch_id: ids.branch, full_name: 'Admin A', phone: '080-000-0001', email: 'admin.demo@eldercare.example', role: 'admin', status: 'active' },
    { id: ids.dispatcherUser, company_id: ids.company, branch_id: ids.branch, full_name: 'Dispatcher A', phone: '080-000-0002', email: 'dispatch.demo@eldercare.example', role: 'dispatcher', status: 'active' },
    { id: ids.careAssistantA, company_id: ids.company, branch_id: ids.branch, full_name: 'คุณแพรว', phone: '080-000-0003', email: 'care1.demo@eldercare.example', role: 'care_assistant', status: 'active' },
    { id: ids.careAssistantB, company_id: ids.company, branch_id: ids.branch, full_name: 'คุณน้ำ', phone: '080-000-0004', email: 'care2.demo@eldercare.example', role: 'care_assistant', status: 'active' },
    { id: ids.driverUserA, company_id: ids.company, branch_id: ids.branch, full_name: 'คุณอนันต์', phone: '081-222-3411', email: 'driver1.demo@eldercare.example', role: 'driver', status: 'active' },
    { id: ids.driverUserB, company_id: ids.company, branch_id: ids.branch, full_name: 'คุณมนตรี', phone: '086-810-4321', email: 'driver2.demo@eldercare.example', role: 'driver', status: 'active' },
    { id: ids.driverUserC, company_id: ids.company, branch_id: ids.branch, full_name: 'คุณศิวกร', phone: '089-104-8871', email: 'driver3.demo@eldercare.example', role: 'driver', status: 'active' }
  ]);

  await upsert(sb, 'customers', [
    { id: ids.customerA, company_id: ids.company, full_name: 'คุณอร', phone: '081-224-6112', line_id: 'orn-care', relationship_to_elder: 'daughter', address: 'ลาดพร้าว 71' },
    { id: ids.customerB, company_id: ids.company, full_name: 'คุณต่าย', phone: '086-194-8801', line_id: 'tai-family', relationship_to_elder: 'niece', address: 'สุขุมวิท 39' },
    { id: ids.customerC, company_id: ids.company, full_name: 'คุณพลอย', phone: '089-553-2020', line_id: 'ploy-home', relationship_to_elder: 'daughter', address: 'บางนา' },
    { id: ids.customerD, company_id: ids.company, full_name: 'คุณบอม', phone: '082-449-1188', line_id: 'bom-siriraj', relationship_to_elder: 'son', address: 'พระราม 2' }
  ]);

  await upsert(sb, 'elders', [
    { id: ids.elderA, company_id: ids.company, customer_id: ids.customerA, full_name: 'คุณสมพร', nickname: 'สมพร', birth_date: '1945-02-12', mobility_level: 'wheelchair', medical_notes: 'เบาหวานและแพ้ยา penicillin เวียนหัวง่าย', allergies: 'penicillin', medication_notes: 'พกยาความดัน', communication_notes: 'พูดช้าและชัด', emergency_contact_name: 'คุณอร', emergency_contact_phone: '081-224-6112', pdpa_sensitive_consent: true },
    { id: ids.elderB, company_id: ids.company, customer_id: ids.customerB, full_name: 'คุณมาลี', nickname: 'มาลี', birth_date: '1950-06-08', mobility_level: 'walker', medical_notes: 'ปวดเข่า เดินช้า ต้องพักระหว่างทาง', medication_notes: 'ยาแก้ปวดประจำ', communication_notes: 'หูตึงเล็กน้อย', emergency_contact_name: 'คุณต่าย', emergency_contact_phone: '086-194-8801', pdpa_sensitive_consent: true },
    { id: ids.elderC, company_id: ids.company, customer_id: ids.customerC, full_name: 'คุณวิชัย', nickname: 'วิชัย', birth_date: '1948-09-21', mobility_level: 'cane', medical_notes: 'ความดันสูง นัดฟอกไตประจำ', medication_notes: 'ยาโรคไต', communication_notes: 'ต้องย้ำเวลานัด', emergency_contact_name: 'คุณพลอย', emergency_contact_phone: '089-553-2020', pdpa_sensitive_consent: true },
    { id: ids.elderD, company_id: ids.company, customer_id: ids.customerD, full_name: 'คุณลัดดา', nickname: 'ลัดดา', birth_date: '1942-11-03', mobility_level: 'wheelchair', medical_notes: 'นัดตรวจตา ต้องมีผู้ช่วยดูแลตลอดงาน', communication_notes: 'กังวลตอนขึ้นรถ', emergency_contact_name: 'คุณบอม', emergency_contact_phone: '082-449-1188', pdpa_sensitive_consent: true }
  ]);

  await upsert(sb, 'pdpa_consents', [
    { id: demoUuid(800000, 1), customer_id: ids.customerA, elder_id: ids.elderA, consent_type: 'general_service', consented: true, consent_text_version: 'demo-v1' },
    { id: demoUuid(800000, 2), customer_id: ids.customerA, elder_id: ids.elderA, consent_type: 'sensitive_health', consented: true, consent_text_version: 'demo-v1' },
    { id: demoUuid(800000, 3), customer_id: ids.customerB, elder_id: ids.elderB, consent_type: 'sensitive_health', consented: true, consent_text_version: 'demo-v1' },
    { id: demoUuid(800000, 4), customer_id: ids.customerB, elder_id: ids.elderB, consent_type: 'location_tracking', consented: true, consent_text_version: 'demo-v1' },
    { id: demoUuid(800000, 5), customer_id: ids.customerC, elder_id: ids.elderC, consent_type: 'sensitive_health', consented: true, consent_text_version: 'demo-v1' },
    { id: demoUuid(800000, 6), customer_id: ids.customerC, elder_id: ids.elderC, consent_type: 'marketing', consented: false, consent_text_version: 'demo-v1' },
    { id: demoUuid(800000, 7), customer_id: ids.customerD, elder_id: ids.elderD, consent_type: 'sensitive_health', consented: true, consent_text_version: 'demo-v1' }
  ]);

  await upsert(sb, 'vehicles', [
    { id: ids.vehicleA, company_id: ids.company, branch_id: ids.branch, plate_number: '1กก-1234', province: 'กรุงเทพมหานคร', vehicle_type: 'wheelchair_van', public_transport_license_status: 'approved', insurance_expiry: '2027-12-31', condition_score: 92, status: 'available' },
    { id: ids.vehicleB, company_id: ids.company, branch_id: ids.branch, plate_number: '2ขข-5678', province: 'กรุงเทพมหานคร', vehicle_type: 'suv', public_transport_license_status: 'approved', insurance_expiry: '2027-09-30', condition_score: 88, status: 'available' },
    { id: ids.vehicleC, company_id: ids.company, branch_id: ids.branch, plate_number: '3คค-9012', province: 'กรุงเทพมหานคร', vehicle_type: 'van', public_transport_license_status: 'pending', insurance_expiry: '2026-10-15', condition_score: 76, status: 'maintenance' }
  ]);

  await upsert(sb, 'drivers', [
    { id: ids.driverA, company_id: ids.company, branch_id: ids.branch, user_id: ids.driverUserA, full_name: 'คุณอนันต์', phone: '081-222-3411', line_id: 'anan-driver', driver_level: 'silver', status: 'active', rating_avg: 4.8, total_jobs: 82 },
    { id: ids.driverB, company_id: ids.company, branch_id: ids.branch, user_id: ids.driverUserB, full_name: 'คุณมนตรี', phone: '086-810-4321', line_id: 'montree-drive', driver_level: 'bronze', status: 'active', rating_avg: 4.5, total_jobs: 34 },
    { id: ids.driverC, company_id: ids.company, branch_id: ids.branch, user_id: ids.driverUserC, full_name: 'คุณศิวกร', phone: '089-104-8871', line_id: 'siwakorn-new', driver_level: 'bronze', status: 'screening', rating_avg: 0, total_jobs: 0 },
    { id: ids.driverD, company_id: ids.company, branch_id: ids.branch, full_name: 'คุณนเรศ', phone: '082-332-1099', line_id: 'nares-training', driver_level: 'bronze', status: 'training', rating_avg: 0, total_jobs: 0 }
  ]);

  await upsert(sb, 'driver_screenings', [
    { id: demoUuid(810000, 1), driver_id: ids.driverA, document_score: 20, interview_score: 23, behavior_score: 23, driving_test_score: 28, result: 'approved', notes: 'ผ่านงาน high risk ได้', approved_by: ids.adminUser, approved_at: new Date().toISOString() },
    { id: demoUuid(810000, 2), driver_id: ids.driverB, document_score: 19, interview_score: 22, behavior_score: 21, driving_test_score: 26, result: 'approved', notes: 'เหมาะกับ low-medium risk', approved_by: ids.adminUser, approved_at: new Date().toISOString() },
    { id: demoUuid(810000, 3), driver_id: ids.driverC, document_score: 15, interview_score: 18, behavior_score: 17, driving_test_score: 18, result: 'retest', notes: 'ต้องสอบซ่อมการพยุงขึ้นรถ' }
  ]);

  const { data: modules, error: moduleError } = await sb.from('training_modules').select('id,required').eq('required', true).order('sort_order');
  if (moduleError) throw moduleError;
  const trainingRows = [];
  [ids.driverA, ids.driverB].forEach((driverId, driverIndex) => {
    modules.forEach((module, moduleIndex) => {
      trainingRows.push({
        id: demoUuid(820000 + driverIndex, moduleIndex + 1),
        driver_id: driverId,
        module_id: module.id,
        status: 'completed',
        score: driverIndex === 0 ? 92 : 86,
        completed_at: new Date().toISOString()
      });
    });
  });
  if (modules[0]) {
    trainingRows.push({
      id: demoUuid(820009, 1),
      driver_id: ids.driverD,
      module_id: modules[0].id,
      status: 'completed',
      score: 84,
      completed_at: new Date().toISOString()
    });
  }
  await upsert(sb, 'driver_training_records', trainingRows);

  await upsert(sb, 'bookings', [
    { id: ids.bookingA, company_id: ids.company, branch_id: ids.branch, customer_id: ids.customerA, elder_id: ids.elderA, booking_no: 'BK-DEMO-1001', service_type: 'hospital_companion', pickup_address: 'บ้านลาดพร้าว 71', dropoff_address: 'รพ.กรุงเทพ', pickup_at: bangkokTodayAt(8, 30), appointment_at: bangkokTodayAt(9, 30), appointment_place: 'รพ.กรุงเทพ แผนกอายุรกรรม', status: 'assigned', risk_level: 'high', need_care_assistant: true, need_wheelchair_support: true, consent_checked: true, special_notes: 'ต้องช่วยพยุงขึ้นรถเข็นและรอพบแพทย์', quoted_price: 3200, final_price: 3200, payment_status: 'deposit_paid', dispatcher_approved_by: ids.dispatcherUser, dispatcher_approved_at: new Date().toISOString(), confirmed_at: new Date().toISOString() },
    { id: ids.bookingB, company_id: ids.company, branch_id: ids.branch, customer_id: ids.customerB, elder_id: ids.elderB, booking_no: 'BK-DEMO-1002', service_type: 'assisted_ride', pickup_address: 'คอนโดสุขุมวิท 39', dropoff_address: 'คลินิกกายภาพ', pickup_at: bangkokTodayAt(10, 0), status: 'confirmed', risk_level: 'medium', need_care_assistant: false, need_wheelchair_support: false, consent_checked: true, special_notes: 'มี walker ส่วนตัว ต้องโทรแจ้งก่อนถึง 15 นาที', quoted_price: 1800, final_price: 1800, payment_status: 'unpaid', confirmed_at: new Date().toISOString() },
    { id: ids.bookingC, company_id: ids.company, branch_id: ids.branch, customer_id: ids.customerC, elder_id: ids.elderC, booking_no: 'BK-DEMO-1003', service_type: 'monthly_transport', pickup_address: 'บ้านบางนา', dropoff_address: 'ศูนย์ฟอกไต', pickup_at: bangkokTodayAt(13, 30), estimated_return_at: bangkokTodayAt(17, 30), status: 'assigned', risk_level: 'medium', need_care_assistant: false, need_wheelchair_support: false, consent_checked: true, special_notes: 'มีความดันสูง ตรวจเวลาถึงศูนย์ให้ตรงรอบฟอกไต', quoted_price: 4200, final_price: 4200, payment_status: 'deposit_paid', confirmed_at: new Date().toISOString() },
    { id: ids.bookingD, company_id: ids.company, branch_id: ids.branch, customer_id: ids.customerD, elder_id: ids.elderD, booking_no: 'BK-DEMO-1004', service_type: 'hospital_companion', pickup_address: 'บ้านพระราม 2', dropoff_address: 'รพ.ศิริราช', pickup_at: bangkokTodayAt(15, 0), appointment_at: bangkokTodayAt(16, 0), appointment_place: 'รพ.ศิริราช แผนกตา', status: 'pending_dispatch_approval', risk_level: 'high', need_care_assistant: true, need_wheelchair_support: true, consent_checked: true, special_notes: 'นัดตรวจตา ญาติจะรอที่แผนกผู้ป่วยนอก', quoted_price: 3600, final_price: 3600, payment_status: 'unpaid' }
  ]);

  await upsert(sb, 'booking_quotes', [
    { id: demoUuid(830000, 1), booking_id: ids.bookingA, quote_no: 'QT-DEMO-1001', subtotal: 2990, discount: 0, tax: 210, total: 3200, quote_status: 'approved', approved_by: ids.dispatcherUser, approved_at: new Date().toISOString(), pricing_snapshot: { demo: true, service_type: 'hospital_companion' } },
    { id: demoUuid(830000, 2), booking_id: ids.bookingB, quote_no: 'QT-DEMO-1002', subtotal: 1682.24, discount: 0, tax: 117.76, total: 1800, quote_status: 'approved', approved_by: ids.dispatcherUser, approved_at: new Date().toISOString(), pricing_snapshot: { demo: true, service_type: 'assisted_ride' } },
    { id: demoUuid(830000, 3), booking_id: ids.bookingC, quote_no: 'QT-DEMO-1003', subtotal: 3925.23, discount: 0, tax: 274.77, total: 4200, quote_status: 'approved', approved_by: ids.dispatcherUser, approved_at: new Date().toISOString(), pricing_snapshot: { demo: true, service_type: 'monthly_transport' } },
    { id: demoUuid(830000, 4), booking_id: ids.bookingD, quote_no: 'QT-DEMO-1004', subtotal: 3364.49, discount: 0, tax: 235.51, total: 3600, quote_status: 'draft', pricing_snapshot: { demo: true, service_type: 'hospital_companion' } }
  ]);

  await upsert(sb, 'assignments', [
    { id: ids.assignmentA, booking_id: ids.bookingA, driver_id: ids.driverA, care_assistant_id: ids.careAssistantA, vehicle_id: ids.vehicleA, assigned_by: ids.dispatcherUser, status: 'accepted', assignment_score: 92, assignment_reason: 'high risk, silver driver, required training completed, wheelchair_van vehicle', accepted_at: new Date().toISOString(), notification_payload: { demo: true } },
    { id: ids.assignmentC, booking_id: ids.bookingC, driver_id: ids.driverB, vehicle_id: ids.vehicleB, assigned_by: ids.dispatcherUser, status: 'assigned', assignment_score: 78, assignment_reason: 'medium risk, bronze driver, suv vehicle', notification_payload: { demo: true } }
  ]);

  await upsert(sb, 'trip_events', [
    { id: demoUuid(840000, 1), booking_id: ids.bookingA, assignment_id: ids.assignmentA, event_type: 'driver_accepted', notes: 'คนขับรับงานแล้ว', created_by: ids.driverUserA, event_payload: { demo: true } },
    { id: demoUuid(840000, 2), booking_id: ids.bookingC, assignment_id: ids.assignmentC, event_type: 'driver_accepted', notes: 'มอบหมายงานฟอกไตประจำ', created_by: ids.dispatcherUser, event_payload: { demo: true } }
  ]);

  await upsert(sb, 'incidents', [{
    id: ids.incidentA,
    booking_id: ids.bookingC,
    driver_id: ids.driverB,
    elder_id: ids.elderC,
    incident_type: 'late',
    severity: 'medium',
    description: 'มาถึงจุดรับช้ากว่ากำหนด 12 นาที ทีม dispatch โทรแจ้งญาติแล้ว',
    action_taken: 'โทรแจ้งญาติและปรับ route buffer',
    status: 'open',
    reported_at: new Date().toISOString(),
    reported_by: ids.dispatcherUser,
    created_by: ids.dispatcherUser
  }]);

  console.log('Demo data seeded');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
