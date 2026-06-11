const test = require('node:test');
const assert = require('node:assert/strict');

const { createElderService, CONSENT_VERSION } = require('../src/modules/customer/service');

function createFakeElderRepository() {
  const elders = [];
  const auditLogs = [];
  let nextId = 1;
  const id = () => `e0000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`;
  return {
    elders,
    auditLogs,
    async listEldersByOwner(ownerUserId) {
      return elders.filter((elder) => elder.owner_user_id === ownerUserId && !elder.deleted_at);
    },
    async findElderById(elderId, ownerUserId) {
      return (
        elders.find(
          (elder) => elder.id === elderId && elder.owner_user_id === ownerUserId && !elder.deleted_at
        ) || null
      );
    },
    async insertElder(row) {
      const elder = {
        ...row,
        id: id(),
        deleted_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      elders.push(elder);
      return elder;
    },
    async updateElder(elderId, ownerUserId, patch) {
      const elder = await this.findElderById(elderId, ownerUserId);
      if (!elder) return null;
      Object.assign(elder, patch, { updated_at: new Date().toISOString() });
      return elder;
    },
    async softDeleteElder(elderId, ownerUserId) {
      const elder = await this.findElderById(elderId, ownerUserId);
      if (!elder) return null;
      elder.deleted_at = new Date().toISOString();
      return { id: elder.id };
    },
    async writeAuditLog(entry) {
      auditLogs.push(entry);
    }
  };
}

const OWNER = 'customer-user-1';

function validInput(extra = {}) {
  return {
    full_name: 'สมศรี ใจดี',
    nickname: 'ยายศรี',
    mobility: 'wheelchair',
    chronic_conditions: ['เบาหวาน', 'ความดัน'],
    medications: [{ name: 'Metformin', dose: '500mg', schedule: 'เช้า-เย็น' }],
    home_location: { lat: 13.7563, lng: 100.5018 },
    consent_accepted: true,
    ...extra
  };
}

test('creating an elder requires PDPA consent', async () => {
  const repository = createFakeElderRepository();
  const service = createElderService({ repository });
  await assert.rejects(
    service.createElder(OWNER, validInput({ consent_accepted: false })),
    (err) => err.code === 'CONSENT_REQUIRED'
  );
});

test('create stores consent version, geography point and lat/lng', async () => {
  const repository = createFakeElderRepository();
  const service = createElderService({ repository });
  const elder = await service.createElder(OWNER, validInput());
  assert.equal(elder.consent_version, CONSENT_VERSION);
  assert.deepEqual(elder.home_location, { lat: 13.7563, lng: 100.5018 });
  assert.equal(repository.elders[0].home_location, 'SRID=4326;POINT(100.5018 13.7563)');
  assert.equal(repository.elders[0].consent_accepted_at !== undefined, true);
});

test('invalid coordinates are rejected', async () => {
  const service = createElderService({ repository: createFakeElderRepository() });
  await assert.rejects(
    service.createElder(OWNER, validInput({ home_location: { lat: 999, lng: 0 } })),
    (err) => err.code === 'LOCATION_INVALID'
  );
});

test('list returns summary fields only — no health data', async () => {
  const repository = createFakeElderRepository();
  const service = createElderService({ repository });
  await service.createElder(OWNER, validInput());
  const list = await service.listElders(OWNER);
  assert.equal(list.length, 1);
  assert.equal(Object.hasOwn(list[0], 'medications'), false);
  assert.equal(Object.hasOwn(list[0], 'chronic_conditions'), false);
});

test('reading a full profile writes a PDPA audit log', async () => {
  const repository = createFakeElderRepository();
  const service = createElderService({ repository });
  const elder = await service.createElder(OWNER, validInput());
  await service.getElder(OWNER, elder.id);
  const readLog = repository.auditLogs.find((log) => log.action === 'elder_profile.read');
  assert.ok(readLog);
  assert.equal(readLog.entityId, elder.id);
});

test('update logs field names only, never values', async () => {
  const repository = createFakeElderRepository();
  const service = createElderService({ repository });
  const elder = await service.createElder(OWNER, validInput());
  await service.updateElder(OWNER, elder.id, { special_notes: 'หูตึงข้างซ้าย' });
  const updateLog = repository.auditLogs.find((log) => log.action === 'elder_profile.update');
  assert.deepEqual(updateLog.payload, { fields: ['special_notes'] });
  assert.equal(JSON.stringify(updateLog).includes('หูตึง'), false);
});

test('owner isolation: another customer cannot read or update the profile', async () => {
  const repository = createFakeElderRepository();
  const service = createElderService({ repository });
  const elder = await service.createElder(OWNER, validInput());
  await assert.rejects(service.getElder('someone-else', elder.id), (err) => err.code === 'ELDER_NOT_FOUND');
  await assert.rejects(
    service.updateElder('someone-else', elder.id, { nickname: 'x' }),
    (err) => err.code === 'ELDER_NOT_FOUND'
  );
});

test('delete is a soft delete and hides the profile', async () => {
  const repository = createFakeElderRepository();
  const service = createElderService({ repository });
  const elder = await service.createElder(OWNER, validInput());
  assert.deepEqual(await service.deleteElder(OWNER, elder.id), { ok: true });
  assert.ok(repository.elders[0].deleted_at, 'row remains with deleted_at set');
  await assert.rejects(service.getElder(OWNER, elder.id), (err) => err.code === 'ELDER_NOT_FOUND');
});
