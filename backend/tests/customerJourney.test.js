const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable, Writable } = require('node:stream');
const express = require('express');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.limitCount = null;
    this.singleRow = false;
    this.write = null;
  }

  select() { return this; }
  order() { return this; }
  gte(column, value) { this.filters.push((row) => row[column] >= value); return this; }
  lte(column, value) { this.filters.push((row) => row[column] <= value); return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  neq(column, value) { this.filters.push((row) => row[column] !== value); return this; }
  in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
  limit(count) { this.limitCount = count; return this; }
  single() { this.singleRow = true; return this; }

  insert(payload) {
    this.write = { type: 'insert', payload };
    this.db.writes.push({ table: this.table, type: 'insert', payload });
    return this;
  }

  update(payload) {
    this.write = { type: 'update', payload };
    this.db.writes.push({ table: this.table, type: 'update', payload, filters: this.filters });
    return this;
  }

  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (error) {
      reject(error);
    }
  }

  execute() {
    if (this.write?.type === 'insert') {
      const rows = Array.isArray(this.write.payload) ? this.write.payload : [this.write.payload];
      const inserted = rows.map((row, index) => ({
        id: row.id || `${this.table}-${this.db.writes.length}-${index + 1}`,
        ...row
      }));
      this.db.rows[this.table] = [...(this.db.rows[this.table] || []), ...inserted];
      return { data: Array.isArray(this.write.payload) && !this.singleRow ? inserted : inserted[0], error: null };
    }

    if (this.write?.type === 'update') {
      const rows = this.filteredRows();
      const updated = rows.map((row) => Object.assign(row, this.write.payload));
      return { data: this.singleRow ? (updated[0] || null) : updated, error: null };
    }

    const rows = this.filteredRows();
    const data = this.singleRow ? (rows[0] || null) : rows;
    return { data, error: data ? null : { message: `${this.table} row not found` } };
  }

  filteredRows() {
    let rows = [...(this.db.rows[this.table] || [])];
    for (const filter of this.filters) rows = rows.filter(filter);
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }
}

function fakeSupabase(rows) {
  return {
    rows,
    writes: [],
    from(table) {
      return new FakeQuery(this, table);
    }
  };
}

function loadRoute(routePath, sb) {
  const supabasePath = require.resolve('../src/db/supabase');
  const routeModulePath = require.resolve(routePath);
  delete require.cache[routeModulePath];
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: { getSupabase: () => sb }
  };
  return require(routePath);
}

async function requestRoute(routePath, sb, method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/', loadRoute(routePath, sb));
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message, code: err.code || err.name });
  });

  const rawBody = body ? JSON.stringify(body) : '';
  const req = new Readable({
    read() {
      this.push(rawBody || null);
      if (rawBody) this.push(null);
    }
  });
  req.method = method;
  req.url = path;
  req.headers = body
    ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rawBody) }
    : {};
  req.socket = new PassThrough();
  req.socket.remoteAddress = '127.0.0.1';
  req.connection = req.socket;

  const chunks = [];
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.getHeader = (name) => res.headers[name.toLowerCase()];
  res.removeHeader = (name) => { delete res.headers[name.toLowerCase()]; };
  res.writeHead = (statusCode, headers = {}) => {
    res.statusCode = statusCode;
    Object.entries(headers).forEach(([name, value]) => res.setHeader(name, value));
    return res;
  };
  const originalEnd = res.end.bind(res);
  res.end = (chunk, encoding, callback) => {
    if (chunk) chunks.push(Buffer.from(chunk));
    originalEnd(null, encoding, callback);
    const text = Buffer.concat(chunks).toString('utf8');
    resolveResponse({
      status: res.statusCode,
      body: text ? JSON.parse(text) : null
    });
    return res;
  };

  app.handle(req, res);
  return responsePromise;
}

function baseBooking(overrides = {}) {
  return {
    id: 'booking-1',
    company_id: 'company-1',
    branch_id: 'branch-1',
    booking_no: 'BK-CJ-1',
    customer_id: 'customer-1',
    elder_id: 'elder-1',
    service_type: 'hospital_companion',
    pickup_address: 'Home',
    dropoff_address: 'Hospital',
    pickup_at: '2026-06-01T09:00:00.000Z',
    estimated_return_at: '2026-06-01T13:00:00.000Z',
    appointment_at: '2026-06-01T10:00:00.000Z',
    appointment_place: 'Cardiology',
    status: 'in_progress',
    risk_level: 'high',
    quoted_price: 2500,
    final_price: 2500,
    payment_status: 'unpaid',
    preferred_communication_channel: 'line',
    family_contact_name: 'Khun Som',
    family_contact_phone: '0811111111',
    customers: { id: 'customer-1', full_name: 'Khun Som', phone: '0811111111', line_id: 'line-som' },
    elders: { id: 'elder-1', full_name: 'Khun Mae', mobility_level: 'wheelchair' },
    ...overrides
  };
}

test('portal status exposes customer journey, trust, next action, and care summary payload fields', async () => {
  const sb = fakeSupabase({
    bookings: [baseBooking()],
    assignments: [{
      id: 'assignment-1',
      booking_id: 'booking-1',
      status: 'accepted',
      drivers: { full_name: 'Driver One', phone: '0822222222', driver_level: 'silver' },
      care_assistant: { full_name: 'Care One', phone: '0833333333' },
      vehicles: { plate_number: '1กก 1234', vehicle_type: 'van' }
    }],
    trip_events: [
      { booking_id: 'booking-1', event_type: 'arrived_pickup', event_at: '2026-06-01T08:55:00.000Z', notes: 'Arrived early', event_payload: {} },
      { booking_id: 'booking-1', event_type: 'family_update', event_at: '2026-06-01T10:15:00.000Z', notes: 'Checked in at clinic', event_payload: { update_id: 'update-1' } }
    ],
    invoices: [{ booking_id: 'booking-1', invoice_no: 'INV-1', total: 2500, status: 'issued', issued_at: '2026-06-01T07:00:00.000Z' }],
    payments: [],
    refunds: [],
    ratings: [],
    audit_logs: []
  });

  const response = await requestRoute('../src/routes/portal', sb, 'GET', '/status/BK-CJ-1');

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.ok, true);
  assert.ok(response.body.portal.journey, 'portal.journey should summarize the visible customer journey state');
  assert.ok(response.body.portal.trust, 'portal.trust should expose field-team and safety reassurance details');
  assert.ok(response.body.portal.next_action, 'portal.next_action should tell the family what happens next');
  assert.ok(response.body.portal.care_summary, 'portal.care_summary should expose approved/family-safe care context');
});

test('trip events queue customer-family notification payloads with event context', async () => {
  const sb = fakeSupabase({
    bookings: [baseBooking({ status: 'confirmed' })],
    trip_events: [],
    trip_checklists: [{ id: 'checklist-1', booking_id: 'booking-1', checklist_type: 'pre_trip', completed: true }],
    notifications: []
  });

  const response = await requestRoute('../src/routes/trips', sb, 'POST', '/booking-1/events', {
    event_type: 'arrived_pickup',
    assignment_id: 'assignment-1',
    notes: 'Arrived at pickup',
    event_payload: {}
  });

  assert.equal(response.status, 201);
  const notification = sb.writes.find((write) => write.table === 'notifications' && write.type === 'insert');
  assert.equal(notification.payload.notification_type, 'trip_arrived_pickup');
  assert.equal(notification.payload.booking_id, 'booking-1');
  assert.equal(notification.payload.payload.audience, 'customer_family');
  assert.equal(notification.payload.payload.booking_no, 'BK-CJ-1');
  assert.equal(notification.payload.payload.service_type, 'hospital_companion');
  assert.equal(notification.payload.payload.event_type, 'arrived_pickup');
  assert.equal(notification.payload.payload.event_id, response.body.event.id);
  assert.equal(notification.payload.payload.status_after_event, 'arrived');
});

test('family updates queue customer notification payloads with message and channel', async () => {
  const sb = fakeSupabase({
    bookings: [baseBooking({ status: 'in_progress' })],
    family_updates: [],
    trip_events: [],
    notifications: []
  });

  const response = await requestRoute('../src/routes/bookings', sb, 'POST', '/booking-1/family-updates', {
    update_type: 'family_update',
    channel: 'line',
    message: 'Elder checked in and is waiting for medication',
    sent_by: 'coordinator-1'
  });

  assert.equal(response.status, 201);
  const notification = sb.writes.find((write) => write.table === 'notifications' && write.type === 'insert');
  assert.equal(notification.payload.notification_type, 'family_update');
  assert.equal(notification.payload.booking_id, 'booking-1');
  assert.equal(notification.payload.payload.audience, 'customer_family');
  assert.equal(notification.payload.payload.update_id, response.body.family_update.id);
  assert.equal(notification.payload.payload.channel, 'line');
  assert.equal(notification.payload.payload.message, 'Elder checked in and is waiting for medication');
});

test('low portal rating creates service recovery review and notifies operations', async () => {
  const sb = fakeSupabase({
    bookings: [baseBooking({ status: 'completed' })],
    assignments: [{ id: 'assignment-1', booking_id: 'booking-1', driver_id: 'driver-1' }],
    ratings: [],
    drivers: [{ id: 'driver-1', status: 'active', rating_avg: 4.8 }],
    driver_quality_reviews: [],
    notifications: [],
    audit_logs: []
  });

  const response = await requestRoute('../src/routes/portal', sb, 'POST', '/status/BK-CJ-1/rating', {
    rating: 2,
    comment: 'Late arrival and no family update'
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.rating.rating, 2);

  const review = sb.writes.find((write) => write.table === 'driver_quality_reviews' && write.type === 'insert');
  assert.equal(review.payload.driver_id, 'driver-1');
  assert.equal(review.payload.review_result, 'low_rating_review');

  const driverStatus = sb.writes.find((write) => write.table === 'drivers' && write.type === 'update' && write.payload.status === 'reviewing');
  assert.ok(driverStatus, 'driver should be put into reviewing status for service recovery');

  const notification = sb.writes.find((write) => write.table === 'notifications' && write.type === 'insert');
  assert.equal(notification.payload.notification_type, 'quality_review_created');
  assert.equal(notification.payload.booking_id, 'booking-1');
  assert.equal(notification.payload.payload.booking_no, 'BK-CJ-1');
  assert.equal(notification.payload.payload.rating, 2);
  assert.equal(notification.payload.payload.review_result, 'low_rating_review');
  assert.equal(notification.payload.payload.source, 'customer_portal');
});
