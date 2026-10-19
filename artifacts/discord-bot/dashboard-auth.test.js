const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  SESSION_TTL_SECONDS,
  authenticateDashboardLogin,
  constantTimeTextEqual,
  createDashboardToken,
  verifyDashboardToken,
} = require('./dashboard-auth');

test('admin login returns a signed session without returning the password', () => {
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const password = 'test-password';
  const login = authenticateDashboardLogin({
    username: ' Admin ',
    password,
    dashboardPassword: password,
    sessionSecret,
    now: 1_800_000_000_000,
  });

  assert.equal(login.status, 200);
  assert.equal(login.mustSetPassword, false);
  assert.equal(login.user.username, 'admin');
  assert.equal(login.token.includes(password), false);
  assert.deepEqual(verifyDashboardToken(login.token, sessionSecret, 1_800_000_000_000), {
    sub: 'admin',
    role: 'admin',
    iat: 1_800_000_000,
    exp: 1_800_000_000 + SESSION_TTL_SECONDS,
  });
});

test('rejects invalid usernames and passwords with the same login error', () => {
  const options = {
    dashboardPassword: 'test-password',
    sessionSecret: crypto.randomBytes(32).toString('hex'),
  };
  const invalidUsername = authenticateDashboardLogin({
    ...options,
    username: 'moderator',
    password: 'test-password',
  });
  const invalidPassword = authenticateDashboardLogin({
    ...options,
    username: 'admin',
    password: 'wrong-password',
  });

  assert.equal(invalidUsername.status, 401);
  assert.equal(invalidPassword.status, 401);
  assert.equal(invalidUsername.error, invalidPassword.error);
});

test('uses the dashboard password for signing when the session secret is unavailable', () => {
  const now = 1_800_000_000_000;
  const password = 'test-password';
  const result = authenticateDashboardLogin({
    username: 'admin',
    password,
    dashboardPassword: password,
    sessionSecret: '',
    now,
  });
  assert.equal(result.status, 200);
  assert.ok(verifyDashboardToken(result.token, password, now));
});

test('rejects login when the dashboard password is missing', () => {
  const result = authenticateDashboardLogin({
    username: 'admin',
    password: 'anything',
    dashboardPassword: '',
    sessionSecret: '',
  });
  assert.equal(result.status, 503);
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
