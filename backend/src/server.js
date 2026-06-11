
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
const { createCareApiRouter } = require('./modules/router'); // อุ่นใจ Care Platform (customer/caregiver portals)
const { attachActor, requireRoles } = require('./middleware/auth');
const {
  createCorsOptions,
  createRateLimiter,
  createSecurityHeaders,
  safeLogUrl
} = require('./middleware/security');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

morgan.token('safe-url', safeLogUrl);

const apiRateLimit = createRateLimiter({
  max: Number(process.env.ELDERCARE_API_RATE_LIMIT_MAX || 600),
  keyPrefix: 'api',
  message: 'Too many API requests'
});
const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ELDERCARE_AUTH_RATE_LIMIT_MAX || 30),
  keyPrefix: 'auth',
  message: 'Too many authentication requests'
});
const portalRateLimit = createRateLimiter({
  max: Number(process.env.ELDERCARE_PORTAL_RATE_LIMIT_MAX || 240),
  keyPrefix: 'portal',
  message: 'Too many portal requests'
});
const aiInboundRateLimit = createRateLimiter({
  max: Number(process.env.ELDERCARE_AI_INBOUND_RATE_LIMIT_MAX || 180),
  keyPrefix: 'ai-inbound',
  message: 'Too many AI inbound requests'
});

app.use(createSecurityHeaders());
app.use(cors(createCorsOptions()));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));

app.get('/health', (_, res) => res.json({ ok: true, service: 'eldercare-erp', version: '2.0.0' }));
app.use(express.static(path.join(__dirname, '../../frontend')));

app.use('/api/auth', authRateLimit, auth);
app.use('/api/portal', portalRateLimit, portal);
app.use('/api/ai/inbound', aiInboundRateLimit, aiWebhooks);
app.use('/api/v1', createCareApiRouter()); // must stay above attachActor — care portals use their own JWT auth
app.use('/api', apiRateLimit, attachActor);
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
  '/erp',
  '/register',
  '/staff-login',
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
