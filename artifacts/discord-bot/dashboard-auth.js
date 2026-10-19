const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SETUP_SESSION_TTL_SECONDS = 15 * 60;
const SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;

function constantTimeTextEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function createDashboardToken({
  username = 'admin',
  role = 'admin',
  accountId,
  sessionVersion,
  purpose = 'session',
  sessionSecret,
  ttlSeconds = SESSION_TTL_SECONDS,
  now = Date.now(),
}) {
  if (!sessionSecret) throw new Error('Dashboard session signing is not configured.');
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    sub: username,
    role,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  if (accountId) claims.accountId = String(accountId);
  if (Number.isInteger(sessionVersion)) claims.sessionVersion = sessionVersion;
  if (purpose !== 'session') claims.purpose = purpose;
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function generateSetupCode() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashSetupCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function verifySetupCode(code, storedHash) {
  if (typeof code !== 'string' || typeof storedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(storedHash)) {
    return false;
  }
  const supplied = Buffer.from(hashSetupCode(code), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function hashModeratorPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function verifyModeratorPassword(password, storedHash) {
  if (typeof storedHash !== 'string') return false;
  const [scheme, salt, digestHex] = storedHash.split('$');
  if (scheme !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(salt || '') ||
      !/^[a-f0-9]{128}$/i.test(digestHex || '')) {
    return false;
  }
  const expected = Buffer.from(digestHex, 'hex');
  const supplied = await scrypt(String(password), salt, expected.length);
  return crypto.timingSafeEqual(supplied, expected);
}

function authenticateDashboardLogin({
  username,
  password,
  dashboardPassword,
  sessionSecret,
  now = Date.now(),
}) {
  const signingSecret = sessionSecret || dashboardPassword;
  if (!dashboardPassword || !signingSecret) {
    return { status: 503, error: 'Dashboard login is not configured.' };
  }
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (normalizedUsername !== 'admin' || !constantTimeTextEqual(password || '', dashboardPassword)) {
    return { status: 401, error: 'Invalid username or password.' };
  }
  return {
    status: 200,
    token: createDashboardToken({ username: 'admin', role: 'admin', sessionSecret: signingSecret, now }),
    user: { username: 'admin', role: 'admin' },
    mustSetPassword: false,
  };
}

function verifyDashboardToken(token, sessionSecret, now = Date.now()) {
  if (!sessionSecret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [encodedPayload, signature] = parts;
  const expected = crypto.createHmac('sha256', sessionSecret).update(encodedPayload).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch (_) {
    return null;
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const currentTime = Math.floor(now / 1000);
    const validAdmin = payload.role === 'admin' && payload.sub === 'admin';
    const validModerator = payload.role === 'mod' &&
      typeof payload.sub === 'string' && payload.sub.length > 0 &&
      typeof payload.accountId === 'string' && payload.accountId.length > 0 &&
      Number.isInteger(payload.sessionVersion);
    const purpose = payload.purpose || 'session';
    if ((!validAdmin && !validModerator) ||
        !['session', 'password-setup'].includes(purpose) ||
        (purpose === 'password-setup' && !validModerator) ||
        !Number.isInteger(payload.exp) || payload.exp <= currentTime ||
        !Number.isInteger(payload.iat) || payload.iat > currentTime) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

module.exports = {
  SESSION_TTL_SECONDS,
  SETUP_SESSION_TTL_SECONDS,
  SETUP_CODE_TTL_MS,
  authenticateDashboardLogin,
  constantTimeTextEqual,
  createDashboardToken,
  generateSetupCode,
  hashModeratorPassword,
  hashSetupCode,
  verifyModeratorPassword,
  verifySetupCode,
  verifyDashboardToken,
};
