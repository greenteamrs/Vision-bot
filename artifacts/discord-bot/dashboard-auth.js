const crypto = require('crypto');

const SESSION_TTL_SECONDS = 12 * 60 * 60;

function constantTimeTextEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function createDashboardToken({ username = 'admin', sessionSecret, now = Date.now() }) {
  if (!sessionSecret) throw new Error('Dashboard session signing is not configured.');
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    role: 'admin',
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
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
    if (payload.sub !== 'admin' || payload.role !== 'admin' ||
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
  constantTimeTextEqual,
  createDashboardToken,
  verifyDashboardToken,
};
