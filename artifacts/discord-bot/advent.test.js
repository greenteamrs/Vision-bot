const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DEFAULT_CHALLENGES, TEST_CHANNEL_ID, clock, actionUpdate, settingsInput, challengeText, assertAccepting } = require('./advent-domain');
const { createAdventService } = require('./advent-service');
const { renderCalendar } = require('./advent-calendar');
const { Readable } = require('node:stream');
const { createCanvas } = require('@napi-rs/canvas');
const { normalizePng, MAX_IMAGE_BYTES, readImageBody } = require('./advent-images');

const START = Date.parse('2026-12-01T00:00:00Z');
const defaults = () => ({
  _id: 'test', runId: 'run-test', year: 2026, challenges: [...DEFAULT_CHALLENGES],
  state: 'idle', startDay: 0, startedAt: null, revision: 0, dayDurationSeconds: 86400, pausedElapsedMs: 0,
});

function fakeModel({ defaults: makeDefaults = () => ({}), unique }) {
  const rows = [];
  let seq = 0;
  function matches(row, query) {
    return Object.entries(query).every(([key, value]) => {
      if (key === '$or') return value.some(item => matches(row, item));
      if (value && typeof value === 'object' && '$lte' in value) return row[key] && new Date(row[key]) <= value.$lte;
      return row[key] === value;
    });
  }
  const queryResult = operation => {
    const result = Promise.resolve().then(operation);
    return { then: result.then.bind(result), lean: () => result };
  };
  const Model = {
    rows,
    async init() {},
    findById(id) { return queryResult(() => rows.find(row => row._id === id) || null); },
    find(query) {
      return { sort: () => ({ lean: async () => rows.filter(row => matches(row, query)).map(row => ({ ...row })) }) };
    },
    findOneAndUpdate(query, update, options = {}) {
      return queryResult(() => {
        let row = rows.find(item => matches(item, query));
        if (!row && options.upsert) {
          const input = Object.fromEntries(Object.entries(query).filter(([key, value]) => !key.startsWith('$') && typeof value !== 'object'));
          if (rows.some(item => unique.every(key => item[key] === input[key]))) {
            throw Object.assign(new Error('duplicate key'), { code: 11000 });
          }
          row = { _id: String(++seq).padStart(24, '0'), createdAt: new Date(START), ...makeDefaults(), ...input, ...update.$setOnInsert };
          rows.push(row);
        }
        if (!row) return null;
        Object.assign(row, update.$set);
        for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
        return { ...row };
      });
    },
    async updateOne(query, update) {
      const row = rows.find(item => matches(item, query));
      if (row) Object.assign(row, update.$set);
    },
  };
  return Model;
}

function fixture() {
  let time = START;
  const sent = [];
  const replies = [];
  const f = { blocked: false, sendError: false };
  const AdventTest = fakeModel({ defaults, unique: ['_id'] });
  const AdventSubmission = fakeModel({ unique: ['runId', 'day', 'userId'] });
  const AdventAnnouncement = fakeModel({ unique: ['runId', 'day'] });
  const imageFiles = new Map();
  let fileSeq = 0;
  const imageStore = {
    async put(bytes) { const id = `image-${++fileSeq}`; imageFiles.set(id, bytes); return id; },
    async get(id) { if (!imageFiles.has(id)) throw new Error('Image not found'); return imageFiles.get(id); },
    async remove(id) { imageFiles.delete(id); },
  };
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async id => {
      assert.equal(id, TEST_CHANNEL_ID);
      return {
        guildId: 'guild', isTextBased: () => true,
        messages: { fetch: async () => ({ find: predicate => sent.find(predicate) }) },
        send: async payload => {
          if (f.sendError) throw new Error('Missing channel permissions');
          const message = { ...payload, id: `sent-${sent.length + 1}`, author: { id: 'bot' } };
          sent.push(message);
          return message;
        },
      };
    } },
  };
  const service = createAdventService({
    client, AdventTest, AdventSubmission, AdventAnnouncement, imageStore, now: () => time,
    readBody: async req => req.body,
    sendJson: (res, code, data) => Object.assign(res, { code, data }),
    dashboardEditBlocked: async (_auth, res) => {
      if (f.blocked) Object.assign(res, { code: 403, data: { error: 'Field is locked' } });
      return f.blocked;
    },
  });
  async function api(method, suffix = '', body = {}, role = 'admin') {
    const response = {
      writeHead(code, headers) { Object.assign(this, { code, headers }); },
      end(bytes) { this.bytes = bytes; },
    };
    const req = Buffer.isBuffer(body)
      ? Object.assign(Readable.from([body]), { method, headers: { 'content-type': 'image/png' } })
      : { method, body };
    const url = new URL(`/api/advent/test${suffix}`, 'http://test');
    await service.handleApi(req, response, url.pathname, url.searchParams, { role, sub: 'staff' });
    return response;
  }
  async function message({ channelId = TEST_CHANNEL_ID, image = true, userId = 'member1', note = '', contentType = 'image/png' } = {}) {
    await service.handleCommand({
      channelId, guildId: 'guild',
      user: { id: userId, username: userId },
      options: {
        getAttachment: name => name === 'screenshot' && image ? { id: 'pic1', name: 'proof.png', contentType, url: 'https://cdn.discordapp.com/attachments/pic.png' } : null,
        getString: name => name === 'note' ? note : null,
      },
      deferReply: async () => {},
      editReply: async payload => {
        replies.push(payload.content);
        return { id: 'saved-proof-message', attachments: { first: () => ({ id: 'saved-proof', url: 'https://cdn.discordapp.com/attachments/saved-proof.png' }) } };
      },
      reply: async payload => { assert.equal(payload.ephemeral, true); replies.push(payload.content); },
    });
  }
  Object.assign(f, {
    service, api, message, sent, replies, AdventTest, AdventSubmission, AdventAnnouncement, imageFiles,
    advance: milliseconds => { time += milliseconds; },
  });
  return f;
}

test('all 25 supplied challenges are seeded in their exact order', () => {
  assert.equal(DEFAULT_CHALLENGES.length, 25);
  assert.equal(DEFAULT_CHALLENGES[0], 'tempoross unique (4 rarest)');
  assert.equal(DEFAULT_CHALLENGES[24], 'vale offerings fletching knife');
});

test('UTC day window is inclusive at opening and exclusive at midnight', () => {
  const config = { ...defaults(), state: 'running', startDay: 1, startedAt: new Date(START) };
  assert.equal(clock(config, START).day, 1);
  assert.equal(clock(config, START + 86400000 - 1).day, 1);
  assert.equal(clock(config, START + 86400000).day, 2);
  assert.equal(clock(config, START + 24 * 86400000).day, 25);
  assert.equal(clock(config, START + 25 * 86400000).state, 'completed');
  assert.equal(clock(config, START + 100 * 86400000).day, 26);
});

test('accelerated tests and pause/resume preserve time remaining in the day', () => {
  const config = { ...defaults(), dayDurationSeconds: 60, state: 'running', startDay: 1, startedAt: new Date(START) };
  assert.equal(clock(config, START + 60000).day, 2);
  Object.assign(config, actionUpdate(config, 'pause', START + 20000));
  assert.equal(clock(config, START + 120000).day, 1);
  Object.assign(config, actionUpdate(config, 'resume', START + 120000));
  assert.equal(clock(config, START + 159999).day, 1);
  assert.equal(clock(config, START + 160000).day, 2);
});

test('invalid state transitions, dates, clocks and challenge values are rejected', () => {
  assert.throws(() => actionUpdate(defaults(), 'advance'), /Start/);
  assert.throws(() => actionUpdate(defaults(), 'resume'), /paused/);
  assert.throws(() => settingsInput({ year: 2025 }, defaults()), /Year/);
  assert.throws(() => settingsInput({ dayDurationSeconds: 59 }, defaults()), /60/);
  assert.throws(() => settingsInput({ dayDurationSeconds: 86401 }, defaults()), /60/);
  assert.throws(() => challengeText('  '), /1–1000/);
  assert.throws(() => challengeText('a'.repeat(1001)), /1–1000/);
  assert.throws(() => assertAccepting(defaults(), { channelId: 'live' }), /test channel/);
  assert.throws(() => assertAccepting(defaults(), { channelId: TEST_CHANNEL_ID }), /not accepting/);
});

test('calendar renders a valid PNG with closed, partial and full calendars', () => {
  for (const opened of [0, 1, 25]) {
    const png = renderCalendar(defaults(), { opened, day: opened });
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 1120);
  }
});

test('first read seeds idle test config and does not send any Discord messages', async () => {
  const f = fixture();
  await f.service.init();
  const response = await f.api('GET');
  assert.equal(response.code, 200);
  assert.equal(response.data.config.channelId, TEST_CHANNEL_ID);
  assert.equal(response.data.run.state, 'idle');
  assert.equal(response.data.config.challenges.length, 25);
  assert.equal(f.sent.length, 0);
});

test('challenge edits persist, settings validate and locked moderator edits do not apply', async () => {
  const f = fixture();
  assert.equal((await f.api('PATCH', '/challenges/3', { text: 'Edited boss challenge' })).code, 200);
  assert.equal((await f.api('GET')).data.config.challenges[2], 'Edited boss challenge');
  assert.equal((await f.api('PATCH', '', { year: 2027, dayDurationSeconds: 60 })).code, 200);
  assert.equal((await f.api('PATCH', '/challenges/26', { text: 'bad' })).code, 400);
  f.blocked = true;
  assert.equal((await f.api('PATCH', '/challenges/3', { text: 'not allowed' }, 'mod')).code, 403);
  assert.equal((await f.api('GET')).data.config.challenges[2], 'Edited boss challenge');
});

test('Discord approval uses the same advent records and rejects duplicate or archived submissions', async () => {
  const f = fixture();
  await f.api('POST', '/actions', { action:'start' });
  await f.message();
  let state = (await f.api('GET')).data;
  const id = state.submissions[0]._id;
  await f.service.approveSubmission(id,'Discord staff');
  state = (await f.api('GET')).data;
  assert.equal(state.submissions[0].status,'approved');
  assert.equal(state.submissions[0].reviewedBy,'Discord staff');
  await assert.rejects(f.service.approveSubmission(id,'Other staff'),/already reviewed/);
  await f.api('POST', '/actions', { action:'reset', confirmation:'RESET TEST' });
  await assert.rejects(f.service.approveSubmission(id,'Discord staff'),/old advent test/);
});

test('full announcement edits persist, replace all wording and survive reset', async () => {
  const f = fixture();
  const text = '**My own heading {day}**\nRules I wrote: {challenge}\nDeadline {closes}, duration {duration}.';
  const saved = await f.api('PATCH', '/messages/1', { text });
  assert.equal(saved.code, 200);
  assert.equal((await f.api('GET')).data.config.announcementMessages[0], text);
  await f.api('POST', '/actions', { action: 'start' });
  assert.match(f.sent[0].embeds[0].description, /My own heading 1/);
  assert.match(f.sent[0].embeds[0].description, /tempoross/);
  assert.match(f.sent[0].embeds[0].description, /<t:\d+:F>/);
  assert.doesNotMatch(f.sent[0].embeds[0].description, /Staff will review|Use.*adventsubmit/);
  assert.equal(f.sent[0].content, undefined);
  assert.equal(f.sent[0].embeds[0].title, undefined);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [] });
  const sentCount = f.sent.length;
  await f.api('PATCH', '/messages/1', { text: 'New text for future posts' });
  await f.service.run();
  assert.equal(f.sent.length, sentCount, 'Edits must not repost already sent messages');
  await f.api('POST', '/actions', { action: 'reset', confirmation: 'RESET TEST' });
  assert.equal((await f.api('GET')).data.config.announcementMessages[0], 'New text for future posts');
});

test('announcement edits validate dates, permissions, placeholder expansion and closing text', async () => {
  const f = fixture();
  assert.equal((await f.api('GET')).data.config.announcementMessages.length, 26);
  assert.equal((await f.api('PATCH', '/messages/0', { text:'bad' })).code, 400);
  assert.equal((await f.api('PATCH', '/messages/27', { text:'bad' })).code, 400);
  assert.equal((await f.api('PATCH', '/messages/1', { text:' ' })).code, 400);
  assert.equal((await f.api('PATCH', '/messages/1', { text:'a'.repeat(4001) })).code, 400);
  assert.equal((await f.api('PATCH', '/messages/1', { text:'{challenge}'.repeat(200) })).code, 400);
  assert.equal((await f.api('PATCH', '/messages/1', { text:'bad' }, 'member')).code, 403);
  f.blocked = true;
  assert.equal((await f.api('PATCH', '/messages/1', { text:'locked' }, 'mod')).code, 403);
  f.blocked = false;
  assert.equal((await f.api('PATCH', '/messages/26', { text:'**Our closing celebration!**' })).code, 200);
  await f.api('POST', '/actions', { action:'start' });
  f.advance(25 * 86400000);
  await f.service.run();
  assert.equal(f.sent.at(-1).embeds[0].description, '**Our closing celebration!**');
});

test('start sends one image announcement without mentioning anyone, retries do not duplicate', async () => {
  const f = fixture();
  await f.api('POST', '/actions', { action: 'start' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].files.length, 1);
  assert.match(f.sent[0].embeds[0].description, /tempoross/);
  assert.match(f.sent[0].embeds[0].description, /\/adventsubmit/);
  assert.doesNotMatch(f.sent[0].embeds[0].description, /tormented|vale offerings/);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [] });
  await f.service.run();
  await f.api('POST', '/actions', { action: 'announce' });
  assert.equal(f.sent.length, 1);
  assert.equal((await f.api('PATCH', '', { year: 2028 })).code, 400);
});

test('rollover sends the next challenge and completion closes day 25 submissions', async () => {
  const f = fixture();
  await f.api('POST', '/actions', { action: 'start' });
  f.advance(86400000);
  await f.service.run();
  assert.match(f.sent[1].embeds[0].description, /tormented/);
  f.advance(24 * 86400000);
  await f.service.run();
  assert.match(f.sent[2].embeds[0].description, /complete/);
  assert.equal((await f.api('GET')).data.run.opened, 25);
  await f.message();
  assert.match(f.replies.at(-1), /not accepting/);
});

test('screenshot submission supports review, daily duplicates and rejected resubmissions', async () => {
  const f = fixture();
  await f.message();
  assert.match(f.replies.at(-1), /not accepting/);
  await f.api('POST', '/actions', { action: 'start' });
  await f.message({ image: false });
  assert.match(f.replies.at(-1), /Attach a screenshot/);
  await f.message({ contentType: 'application/pdf' });
  assert.match(f.replies.at(-1), /Attach a screenshot/);
  await f.message({ note: 'My daily proof' });
  assert.match(f.replies.at(-1), /submitted/);
  assert.equal(f.AdventSubmission.rows[0].note, 'My daily proof');
  assert.equal(f.AdventSubmission.rows[0].messageId, 'saved-proof-message');
  assert.equal(f.AdventSubmission.rows[0].attachmentId, 'saved-proof');
  await f.message();
  assert.match(f.replies.at(-1), /already have/);
  const id = f.AdventSubmission.rows[0]._id;
  await f.api('POST', `/submissions/${id}/review`, { status: 'rejected', note: 'Wrong drop' });
  await f.message();
  assert.equal(f.AdventSubmission.rows[0].status, 'pending');
  assert.equal(f.AdventSubmission.rows[0].reviewNote, '');
  await f.api('POST', `/submissions/${id}/review`, { status: 'approved' });
  await f.message();
  assert.match(f.replies.at(-1), /already have/);
  assert.equal((await f.api('POST', `/submissions/${id}/review`, { status: 'rejected' })).code, 400);
});

test('next day accepts a separate submission and paused tests reject pictures', async () => {
  const f = fixture();
  await f.api('POST', '/actions', { action: 'start' });
  await f.message();
  await f.api('POST', '/actions', { action: 'pause' });
  await f.message({ userId: 'member2' });
  assert.match(f.replies.at(-1), /not accepting/);
  await f.api('POST', '/actions', { action: 'advance' });
  await f.message();
  assert.deepEqual(f.AdventSubmission.rows.map(row => row.day), [1, 2]);
});

test('test channel isolation applies to messages and all outbound announcements', async () => {
  const f = fixture();
  await f.api('POST', '/actions', { action: 'start' });
  await f.message({ channelId: 'live-channel' });
  assert.match(f.replies.at(-1), /test-only/);
  assert.equal(f.AdventSubmission.rows.length, 0);
  assert.equal((await f.api('POST', '/actions', { action: 'go-live' })).code, 400);
  assert.equal((await f.api('POST', '/actions', { action: 'advance' }, 'member')).code, 403);
});

test('reset archives instead of deleting and keeps edited challenges', async () => {
  const f = fixture();
  await f.api('PATCH', '/challenges/1', { text: 'My custom challenge' });
  await f.api('POST', '/actions', { action: 'start' });
  await f.message();
  const firstRun = (await f.api('GET')).data.run.id;
  assert.equal((await f.api('POST', '/actions', { action: 'reset' })).code, 400);
  const response = await f.api('POST', '/actions', { action: 'reset', confirmation: 'RESET TEST' });
  assert.notEqual(response.data.run.id, firstRun);
  assert.equal(response.data.run.state, 'idle');
  assert.equal(response.data.config.challenges[0], 'My custom challenge');
  assert.equal(response.data.submissions.length, 0);
  assert.equal(f.AdventSubmission.rows.length, 1);
});

test('restart recovery deduplicates a delivered announcement with an expired claim', async () => {
  const f = fixture();
  await f.api('POST', '/actions', { action: 'start' });
  Object.assign(f.AdventAnnouncement.rows[0], { status: 'sending', leaseUntil: new Date(START - 1000), messageId: '' });
  await f.service.run();
  assert.equal(f.sent.length, 1);
  assert.equal(f.AdventAnnouncement.rows[0].status, 'sent');
  assert.equal(f.AdventAnnouncement.rows[0].messageId, 'sent-1');
});

test('failed announcements stay visible and retry successfully without losing the test day', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  f.sendError = true;
  const start = await f.api('POST', '/actions', { action: 'start' });
  assert.equal(start.data.run.day, 1);
  assert.equal(start.data.announcements[0].status, 'failed');
  assert.match(start.data.announcements[0].error, /permissions/);
  f.sendError = false;
  await f.service.run();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.api('GET')).data.announcements[0].status, 'sent');
});

test('simultaneous starts and submission attempts cannot produce duplicates', async () => {
  const f = fixture();
  const starts = await Promise.all([f.api('POST', '/actions', { action: 'start' }), f.api('POST', '/actions', { action: 'start' })]);
  assert.deepEqual(starts.map(item => item.code), [200, 400]);
  await Promise.all([f.message(), f.message()]);
  assert.equal(f.AdventSubmission.rows.length, 1);
  assert.equal(f.sent.length, 1);
});

test('dashboard contract and protected bot integration remain wired', () => {
  const html = fs.readFileSync(`${__dirname}/dashboard.html`, 'utf8');
  const bot = fs.readFileSync(`${__dirname}/bot.js`, 'utf8');
  for (const fragment of ['section-advent', '/api/advent/test', 'saveAdventChallenge', 'reviewAdventSubmission', 'RESET TEST']) {
    assert.ok(html.includes(fragment), fragment);
  }
  assert.ok(bot.indexOf('const authUser = checkAuth(req)') < bot.indexOf('await adventService.handleApi'));
  assert.match(bot, /adventService\.handleCommand\(interaction\)/);
  assert.match(bot, /setName\('adventsubmit'\)/);
  assert.match(bot, /setName\('screenshot'\).*setRequired\(true\)/);
  assert.doesNotMatch(bot, /adventService\.handleMessage/);
  assert.match(bot, /adventService\.init\(\)/);
});

test('custom images cover closed stage and every day, persist across resets and feed announcements', async () => {
  const f = fixture();
  const png = createCanvas(32, 24).toBuffer('image/png');
  const normalized = await normalizePng(png);
  for (let day = 0; day <= 25; day++) {
    assert.equal((await f.api('POST', `/images/${day}`, png)).code, 200);
  }
  assert.equal((await f.api('GET')).data.config.calendarImages.length, 26);
  assert.equal(f.imageFiles.size, 26);
  assert.deepEqual((await f.api('GET', '/calendar.png?day=0')).bytes, normalized);
  assert.deepEqual((await f.api('GET', '/calendar.png?day=25')).bytes, normalized);
  await f.api('POST', '/actions', { action: 'start' });
  assert.deepEqual(f.sent[0].files[0].attachment, normalized);
  await f.api('POST', '/actions', { action: 'reset', confirmation: 'RESET TEST' });
  assert.equal((await f.api('GET')).data.config.calendarImages.length, 26);
});

test('replacing or removing custom pictures cleans up storage and restores generated fallback', async () => {
  const f = fixture();
  const png = createCanvas(32, 24).toBuffer('image/png');
  await f.api('POST', '/images/1', png);
  const originalId = [...f.imageFiles.keys()][0];
  await f.api('POST', '/images/1', png);
  assert.equal(f.imageFiles.has(originalId), false);
  assert.equal(f.imageFiles.size, 1);
  await f.api('DELETE', '/images/1');
  assert.equal(f.imageFiles.size, 0);
  const result = await f.api('GET', '/calendar.png?day=1');
  assert.equal(result.bytes.readUInt32BE(16), 1200);
  assert.equal((await f.api('GET')).data.config.calendarImages.length, 0);
});

test('image endpoints reject invalid slots, malformed data and locked or non-staff uploads', async () => {
  const f = fixture();
  const png = createCanvas(32, 24).toBuffer('image/png');
  assert.equal((await f.api('POST', '/images/26', png)).code, 400);
  assert.equal((await f.api('GET', '/calendar.png?day=26')).code, 400);
  assert.equal((await f.api('POST', '/images/0', Buffer.from('not png'))).code, 400);
  assert.equal((await f.api('POST', '/images/0', png, 'member')).code, 403);
  f.blocked = true;
  assert.equal((await f.api('POST', '/images/0', png, 'mod')).code, 403);
  assert.equal(f.imageFiles.size, 0);
});

test('upload limits check both declared and actual bytes, dimensions and decoded PNG validity', async () => {
  const png = createCanvas(32, 24).toBuffer('image/png');
  assert.equal((await normalizePng(png)).readUInt32BE(16), 32);
  assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  await assert.rejects(normalizePng(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /10 MB/);
  const huge = Buffer.from(png);
  huge.writeUInt32BE(100000, 16);
  await assert.rejects(normalizePng(huge), /4096/);
  const corrupt = Buffer.from(png);
  corrupt.fill(0, 33);
  await assert.rejects(normalizePng(corrupt), /decoded/);
  assert.throws(() => readImageBody({ headers: { 'content-type': 'image/svg+xml' } }), /image\/png/);
  assert.throws(() => readImageBody({ headers: { 'content-type': 'image/png', 'content-length': MAX_IMAGE_BYTES + 1 } }), /10 MB/);
  const stream = Object.assign(Readable.from([Buffer.alloc(MAX_IMAGE_BYTES), Buffer.alloc(1)]), { headers: { 'content-type': 'image/png' } });
  await assert.rejects(readImageBody(stream), /10 MB/);
});

test('image uploads accept PNGs between the former 5 MB and new 10 MB limits', async () => {
  const { PNG } = require('pngjs');
  const { randomFillSync } = require('node:crypto');
  const image = new PNG({ width: 1300, height: 1300 });
  randomFillSync(image.data);
  const bytes = PNG.sync.write(image);
  assert.ok(bytes.length > 5 * 1024 * 1024);
  assert.ok(bytes.length < MAX_IMAGE_BYTES);
  const f = fixture();
  const result = await f.api('POST', '/images/1', bytes);
  assert.equal(result.code, 200);
  assert.equal(f.imageFiles.size, 1);
});
