const assert = require('node:assert/strict');
const test = require('node:test');

const {
  configuredCorsOrigins,
  createRateLimiter,
  createSecurityHeaders,
  isOriginAllowed,
  safeLogUrl
} = require('../src/middleware/security');

function mockResponse() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('parses CORS allowlist and blocks unlisted production origins', () => {
  const env = {
    NODE_ENV: 'production',
    ELDERCARE_CORS_ORIGINS: 'https://erp.example.com, http://localhost:8080'
  };

  assert.deepEqual(configuredCorsOrigins(env), ['https://erp.example.com', 'http://localhost:8080']);
  assert.equal(isOriginAllowed(undefined, env), true);
  assert.equal(isOriginAllowed('https://erp.example.com', env), true);
  assert.equal(isOriginAllowed('https://evil.example.com', env), false);
});

test('allows local development origins when no CORS allowlist is configured', () => {
  assert.equal(isOriginAllowed('http://localhost:8080', { NODE_ENV: 'development' }), true);
  assert.equal(isOriginAllowed('http://localhost:8080', { NODE_ENV: 'production' }), false);
});

test('security headers include basic browser protections', () => {
  const res = mockResponse();
  let called = false;

  createSecurityHeaders({ NODE_ENV: 'production' })({}, res, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.equal(res.headers['Strict-Transport-Security'], 'max-age=15552000; includeSubDomains');
});

test('safe log url removes query strings in production logs', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  assert.equal(safeLogUrl({ originalUrl: '/portal/t/status/abc?token=secret&pin=1234' }), '/portal/t/status/abc');

  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

test('rate limiter returns 429 after the configured threshold', () => {
  const limiter = createRateLimiter({
    windowMs: 1000,
    max: 1,
    keyPrefix: `test-${Date.now()}`,
    message: 'limited'
  });
  const req = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };
  const first = mockResponse();
  const second = mockResponse();
  let nextCalls = 0;

  limiter(req, first, () => { nextCalls += 1; });
  limiter(req, second, () => { nextCalls += 1; });

  assert.equal(nextCalls, 1);
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.code, 'RATE_LIMITED');
});
