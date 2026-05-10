
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const auth = require('./routes/auth');
const customers = require('./routes/customers');
const elders = require('./routes/elders');
const consents = require('./routes/consents');
const drivers = require('./routes/drivers');
const bookings = require('./routes/bookings');
const assignments = require('./routes/assignments');
const trips = require('./routes/trips');
const incidents = require('./routes/incidents');
const dashboard = require('./routes/dashboard');
const finance = require('./routes/finance');
const notifications = require('./routes/notifications');
const quality = require('./routes/quality');
const portal = require('./routes/portal');
const privacy = require('./routes/privacy');
const reports = require('./routes/reports');
const sop = require('./routes/sop');
const users = require('./routes/users');
const readiness = require('./routes/readiness');
const ai = require('./routes/ai');
const aiWebhooks = require('./routes/aiWebhooks');
const aiStream = require('./routes/aiStream');
const { attachActor, requireRoles } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(morgan('dev'));

app.get('/health', (_, res) => res.json({ ok: true, service: 'eldercare-erp', version: '2.0.0' }));
app.use(express.static(path.join(__dirname, '../../frontend')));

app.use('/api/auth', auth);
app.use('/api/portal', portal);
app.use('/api/ai/inbound', aiWebhooks);
app.use('/api', attachActor);
app.use('/api/customers', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator']), customers);
app.use('/api/elders', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator', 'care_assistant', 'hospital_companion', 'home_companion']), elders);
app.use('/api/consents', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator']), consents);
app.use('/api/drivers', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'trainer']), drivers);
app.use('/api/bookings', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator', 'driver', 'care_assistant', 'hospital_companion', 'home_companion', 'finance']), bookings);
app.use('/api/assignments', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator', 'driver', 'care_assistant', 'hospital_companion', 'home_companion']), assignments);
app.use('/api/trips', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator', 'driver', 'care_assistant', 'hospital_companion', 'home_companion']), trips);
app.use('/api/incidents', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator', 'driver', 'care_assistant', 'hospital_companion', 'home_companion']), incidents);
app.use('/api/dashboard', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator', 'finance']), dashboard);
app.use('/api/notifications', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator', 'driver', 'care_assistant', 'hospital_companion', 'home_companion', 'finance']), notifications);
app.use('/api/quality', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'trainer']), quality);
app.use('/api/privacy', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator']), privacy);
app.use('/api/reports', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator', 'finance']), reports);
app.use('/api/sop', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator']), sop);
app.use('/api/users', requireRoles(['owner', 'super_admin', 'admin']), users);
app.use('/api/readiness', requireRoles(['owner', 'super_admin', 'admin']), readiness);
app.use('/api/ai/stream', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator', 'driver', 'care_assistant', 'hospital_companion', 'home_companion']), aiStream);
app.use('/api/ai', requireRoles(['owner', 'super_admin', 'admin', 'branch_admin', 'dispatcher', 'coordinator']), ai);
app.use('/api', requireRoles(['owner', 'super_admin', 'admin', 'finance']), finance);

app.get([
  '/portal/status/:booking_no',
  '/portal/rating/:booking_no',
  '/portal/book/:token',
  '/portal/consent/:token',
  '/portal/t/status/:token',
  '/portal/t/rating/:token',
  '/portal/t/consent/:token'
], (_, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.statusCode || (err.name === 'ZodError' ? 422 : 500);
  res.status(status).json({
    ok: false,
    error: err.message || 'Internal Server Error',
    code: err.code || err.name || 'INTERNAL_ERROR',
    details: err.details || err.issues || undefined
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ElderCare ERP API listening on ${port}`));
