const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { WEEK_MS, normalizeEventLink, reminderMessage, createEventReminderService } = require('./event-reminders');
const { normalizeEventInput } = require('./events-domain');

function fixture() {
  let clock = new Date('2026-11-09T12:00:00Z');
  const calendar = [];
  const managed = [];
  const records = new Map();
  const sent = [];
  const errors = [];
  const mods = [
    { id: 'mod', mod: true, user: { bot: false } },
    { id: 'admin', admin: true, user: { bot: false } },
    { id: 'member', user: { bot: false } },
    { id: 'bot', mod: true, user: { bot: true } },
  ];
  mods.forEach(member => {
    member.send = async payload => {
      if (member.error) throw Object.assign(new Error('Discord failure'), { code: member.error });
      sent.push({ userId: member.id, ...payload });
    };
  });
  const model = (rows, field) => ({
    findById(id) { return { lean: async () => rows.find(row => row._id === id) || null }; },
    find(query) {
      assert.deepEqual(Object.keys(query[field]), ['$gt', '$lte']);
      return { lean: async () => rows.filter(row =>
        row[field] > query[field].$gt && row[field] <= query[field].$lte &&
        (!query.status || query.status.$in.includes(row.status))) };
    },
  });
  const Delivery = {
    async findOneAndUpdate(query, update) {
      let row = records.get(query.key);
      if (row && (query.status?.$nin.includes(row.status) || row.nextAttemptAt > query.nextAttemptAt.$lte)) {
        throw Object.assign(new Error('duplicate'), { code: 11000 });
      }
      row = { key: query.key, status: 'pending', attempts: 0, ...row, ...update.$set };
      row.attempts++;
      records.set(query.key, row);
      return row;
    },
    async updateOne({ key }, update) {
      if (!records.has(key)) records.set(key, { key });
      Object.assign(records.get(key), update.$set);
    },
  };
  const dependencies = {
    CalendarEvent: model(calendar, 'start'), OsrsEvent: model(managed, 'startsAt'),
    Delivery, now: () => clock, isMod: m => m.mod, isAdmin: m => m.admin,
    client: { isReady: () => true, guilds: { cache: new Map([['guild', {
      roles: { fetch: async () => {} },
      members: { fetch: async () => new Map(mods.map(m => [m.id, m])) },
    }]]) } },
    logger: { warn: message => errors.push(message), error: (...message) => errors.push(message.join(' ')) },
  };
  const event = { _id: 'c1', title: 'Boss weekend', start: new Date(clock.getTime() + WEEK_MS), link: 'https://example.com/tracker' };
  calendar.push(event);
  return { ...dependencies, calendar, managed, mods, records, sent, errors, event,
    service: () => createEventReminderService(dependencies),
    advance: ms => { clock = new Date(clock.getTime() + ms); },
  };
}

test('event links allow http(s), clear correctly, reject unsafe URLs and survive normalization', () => {
  assert.equal(normalizeEventLink(' https://example.com/tracker '), 'https://example.com/tracker');
  assert.equal(normalizeEventLink(''), '');
  for (const value of ['javascript:alert(1)', 'ftp://example.com', 'not a link', 'https://user:pass@example.com', 'x'.repeat(1001)]) {
    assert.throws(() => normalizeEventLink(value));
  }
  assert.deepEqual(normalizeEventInput({ link: 'https://example.com' }, { partial: true }), { link: 'https://example.com/' });
  assert.deepEqual(normalizeEventInput({ name: 'Renamed' }, { partial: true }), { name: 'Renamed' });
});

test('at seven days DMs all mods/admins once, excludes other members/bots, survives restart', async () => {
  const f = fixture();
  await f.service().run();
  assert.deepEqual(f.sent.map(s => s.userId), ['mod', 'admin']);
  assert.match(f.sent[0].content, /Boss weekend/);
  assert.match(f.sent[0].content, /make a post in the event channel/);
  assert.match(f.sent[0].content, /https:\/\/example.com\/tracker/);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [] });
  await f.service().run();
  assert.equal(f.sent.length, 2);
  assert.ok([...f.records.values()].every(r => r.status === 'sent'));
});

test('future/past/draft/completed events skipped; short-notice scheduled events included', async () => {
  const f = fixture();
  f.event.start = new Date('2026-12-01T12:00:00Z');
  f.calendar.push({ ...f.event, _id: 'past', start: new Date('2026-11-09T12:00:00Z') });
  for (const status of ['draft', 'upcoming', 'active', 'completed', 'archived']) {
    f.managed.push({ _id: status, name: status, startsAt: new Date('2026-11-10T12:00:00Z'), status });
  }
  await f.service().run();
  assert.equal(f.sent.length, 4);
  assert.ok(f.sent.every(s => /upcoming|active/.test(s.content)));
  assert.ok(f.sent.every(s => !s.content.includes('tracker link')));
});

test('blocked DMs are recorded without stopping delivery or retried spam', async () => {
  const f = fixture();
  f.mods[0].error = 50007;
  await f.service().run();
  assert.equal(f.sent.length, 1);
  assert.equal([...f.records.values()].find(r => r.key.endsWith(':mod')).status, 'blocked');
  f.advance(16 * 60 * 1000);
  await f.service().run();
  assert.equal(f.sent.length, 1);
  assert.equal(f.errors.length, 1);
});

test('temporary DM errors retry after the lease; successful recipients never repeat', async () => {
  const f = fixture();
  f.mods[0].error = 503;
  await f.service().run();
  await f.service().run();
  assert.equal(f.errors.length, 1);
  f.advance(16 * 60 * 1000);
  f.mods[0].error = null;
  await f.service().run();
  assert.deepEqual(f.sent.map(s => s.userId), ['admin', 'mod']);
});

test('permanent transient failures stop after three attempts; rescheduling has a fresh reminder', async () => {
  const f = fixture();
  f.mods[0].error = 503;
  for (let i = 0; i < 4; i++) { await f.service().run(); f.advance(16 * 60 * 1000); }
  assert.equal(f.errors.length, 3);
  assert.equal([...f.records.values()].find(r => r.key.endsWith(':mod')).status, 'failed');
  f.mods[0].error = null;
  f.event.start = new Date(f.event.start.getTime() - 60 * 60 * 1000);
  await f.service().run();
  assert.equal(f.sent.length, 3);
});

test('message stays within Discord limits and UI/API wire links with existing locks', () => {
  assert.ok(reminderMessage({ name: 'n'.repeat(5000), start: new Date(), link: 'https://example.com/' + 'x'.repeat(970) }).length < 2000);
  const html = fs.readFileSync(`${__dirname}/dashboard.html`, 'utf8');
  const bot = fs.readFileSync(`${__dirname}/bot.js`, 'utf8');
  const service = fs.readFileSync(`${__dirname}/event-service.js`, 'utf8');
  assert.match(html, /'event-link':'link'/);
  assert.match(html, /id="ev-link".*data-lock-key="event\./);
  assert.match(html, /link: document.getElementById\('ev-link'\).value.trim\(\)/);
  assert.match(bot, /calendar.create.link/);
  assert.match(bot, /update.link = normalizeEventLink\(data.link\)/);
  assert.match(service, /\['name', 'description', 'link'/);
  assert.match(bot, /cron.schedule\('\* \* \* \* \*', \(\) => eventReminders.run\(\)\)/);
});

test('manual resend delivers again with latest link and preserves automatic delivery records', async () => {
  const f = fixture();
  f.event._id = 'a'.repeat(24);
  const service = f.service();
  await service.run();
  const autoKeys = [...f.records.keys()];
  f.event.link = 'https://example.com/updated';
  const result = await service.resend('calendar', f.event._id);
  assert.deepEqual(result, { sent: 2, blocked: 0, failed: 0, total: 2 });
  assert.equal(f.sent.length, 4);
  assert.match(f.sent[2].content, /updated/);
  for (const key of autoKeys) assert.equal(f.records.get(key).status, 'sent');
  await service.run();
  assert.equal(f.sent.length, 4);
  await assert.rejects(f.service().resend('calendar', f.event._id), { status: 429 });
  f.advance(61000);
  await f.service().resend('calendar', f.event._id);
  assert.equal(f.sent.length, 6);
});

test('manual resend reports blocked and failed DMs accurately without stopping other recipients', async () => {
  const f = fixture();
  f.event._id = 'a'.repeat(24);
  f.mods[0].error = 50007;
  assert.deepEqual(await f.service().resend('calendar', f.event._id), { sent: 1, blocked: 1, failed: 0, total: 2 });
  f.advance(61000);
  f.mods[0].error = 503;
  assert.deepEqual(await f.service().resend('calendar', f.event._id), { sent: 1, blocked: 0, failed: 1, total: 2 });
});

test('manual resend rejects offline, missing, invalid, started, and draft events', async () => {
  const f = fixture();
  f.event._id = 'a'.repeat(24);
  f.client.isReady = () => false;
  await assert.rejects(f.service().resend('calendar', f.event._id), { status: 503 });
  f.client.isReady = () => true;
  await assert.rejects(f.service().resend('calendar', 'invalid'), { status: 400 });
  await assert.rejects(f.service().resend('calendar', 'b'.repeat(24)), { status: 404 });
  f.managed.push({ _id: f.event._id, name: 'Draft', startsAt: f.event.start, status: 'draft' });
  await assert.rejects(f.service().resend('event', f.event._id), { status: 400 });
  f.managed[0].status = 'upcoming';
  assert.equal((await f.service().resend('event', f.event._id)).sent, 2);
  f.event.start = new Date('2026-11-08T12:00:00Z');
  await assert.rejects(f.service().resend('calendar', f.event._id), { status: 400 });
  assert.equal(f.sent.length, 2);
});

test('dashboard resend controls use authenticated, lock-protected routes and report delivery results', () => {
  const bot = fs.readFileSync(`${__dirname}/bot.js`, 'utf8');
  const html = fs.readFileSync(`${__dirname}/dashboard.html`, 'utf8');
  const route = bot.slice(bot.indexOf('const resendNotificationMatch'), bot.indexOf('if (await eventService.handleApi'));
  assert.ok(bot.indexOf('const authUser = checkAuth(req)') < bot.indexOf('const resendNotificationMatch'));
  assert.match(route, /dashboardEditBlocked\(authUser, res/);
  assert.match(route, /eventReminders.resend\(kind, id\)/);
  assert.match(html, /data-lock-action-key="calendar\.\$\{escAttr\(e._id\)\}\.resend"/);
  assert.match(html, /data-lock-action-key="event\.\$\{escAttr\(event._id\)\}\.resend"/);
  const handler = html.slice(html.indexOf('async function resendEventNotification'), html.indexOf('function setCalendarView'));
  assert.match(handler, /confirm\(/);
  assert.match(handler, /api\('POST'/);
  assert.match(handler, /data.blocked/);
  assert.match(handler, /finally/);
  assert.match(handler, /hydrateDashboardLockControls/);
});
