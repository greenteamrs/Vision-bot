const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  SESSION_TTL_SECONDS,
  constantTimeTextEqual,
  createDashboardToken,
  verifyDashboardToken,
} = require('./dashboard-auth');

test('issues signed administrator sessions without returning the password', () => {
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const token = createDashboardToken({ username: 'admin', sessionSecret, now: 1_800_000_000_000 });

  assert.equal(token.includes('password'), false);
  assert.deepEqual(verifyDashboardToken(token, sessionSecret, 1_800_000_000_000), {
    sub: 'admin',
    role: 'admin',
    iat: 1_800_000_000,
    exp: 1_800_000_000 + SESSION_TTL_SECONDS,
  });
});

test('rejects expired, tampered, and wrong-secret sessions', () => {
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const token = createDashboardToken({ sessionSecret, now: 1_800_000_000_000 });

  assert.equal(verifyDashboardToken(token, sessionSecret, 1_800_000_000_000 + SESSION_TTL_SECONDS * 1000), null);
  assert.equal(verifyDashboardToken(`${token}x`, sessionSecret, 1_800_000_000_000), null);
  assert.equal(verifyDashboardToken(token, crypto.randomBytes(32).toString('hex'), 1_800_000_000_000), null);
  assert.equal(verifyDashboardToken(token, '', 1_800_000_000_000), null);
});

test('compares configured passwords without a length-dependent comparison', () => {
  assert.equal(constantTimeTextEqual('test-password', 'test-password'), true);
  assert.equal(constantTimeTextEqual('wrong', 'test-password'), false);
});
