const mongoose = require('mongoose');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { PNG } = require('pngjs');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function imageDay(value) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 0 || day > 25) throw new Error('Choose an image slot from 0 (fully closed) to 25.');
  return day;
}

async function normalizePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > MAX_IMAGE_BYTES
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Upload a valid PNG image no larger than 10 MB.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16000000) {
    throw new Error('Calendar images must be at most 4096 × 4096 pixels and 16 megapixels.');
  }
  // Do not pass untrusted bytes into the native calendar renderer: malformed
  // PNGs can crash that decoder instead of throwing a catchable JS error.
  let png;
  try {
    const image = PNG.sync.read(bytes, { checkCRC: true });
    png = PNG.sync.write(image);
  } catch (_) { throw new Error('This image could not be decoded. Choose another image.'); }
  if (png.length > MAX_IMAGE_BYTES) throw new Error('The converted image exceeds 10 MB. Use a smaller image.');
  return png;
}

function readImageBody(req) {
  if (String(req.headers?.['content-type'] || '').split(';')[0] !== 'image/png') {
    req.resume?.();
    throw new Error('Calendar uploads must use image/png.');
  }
  if (Number(req.headers?.['content-length'] || 0) > MAX_IMAGE_BYTES) {
    req.resume?.();
    throw new Error('Calendar images must be 10 MB or smaller.');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const cleanup = () => {
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', error);
      req.removeListener('aborted', aborted);
    };
    const error = cause => { cleanup(); reject(cause); };
    const aborted = () => error(new Error('Image upload was interrupted.'));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = chunk => {
      length += chunk.length;
      if (length > MAX_IMAGE_BYTES) {
        error(new Error('Calendar images must be 10 MB or smaller.'));
        req.resume();
      } else chunks.push(chunk);
    };
    req.on('data', data).on('end', end).on('error', error).on('aborted', aborted);
  });
}

// The bot runs on Render with an existing MongoDB, not a Replit storage sidecar.
// GridFS stores durable binary files separately from calendar configuration and
// survives service redeploys without adding filesystem or cloud credentials.
function createAdventImageStore(connection = mongoose.connection) {
  function bucket() {
    if (!connection.db) throw new Error('Calendar image storage is not connected.');
    return new mongoose.mongo.GridFSBucket(connection.db, { bucketName: 'adventCalendarImages' });
  }
  return {
    async put(bytes, day) {
      const upload = bucket().openUploadStream(`calendar-${day}.png`, { metadata: { day, contentType: 'image/png' } });
      await pipeline(Readable.from([bytes]), upload);
      return String(upload.id);
    },
    async get(id) {
      const parts = [];
      let length = 0;
      const stream = bucket().openDownloadStream(new mongoose.Types.ObjectId(id));
      for await (const part of stream) {
        length += part.length;
        if (length > MAX_IMAGE_BYTES) throw new Error('Stored calendar image exceeds the permitted size.');
        parts.push(part);
      }
      return Buffer.concat(parts);
    },
    async remove(id) { await bucket().delete(new mongoose.Types.ObjectId(id)); },
  };
}

module.exports = { MAX_IMAGE_BYTES, imageDay, normalizePng, readImageBody, createAdventImageStore };
