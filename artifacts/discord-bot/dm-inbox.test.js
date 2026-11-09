const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createDmInbox } = require('./dm-inbox');

function fixture() {
  const rows = [];
  const Message = {
    async countDocuments(query) { assert.deepEqual(query, {}); return rows.length; },
    async updateOne({ messageId }, { $setOnInsert }, options) {
      assert.equal(options.upsert, true);
      if (!rows.some(row => row.messageId === messageId)) {
        rows.push({ ...$setOnInsert, _id: (rows.length + 1).toString(16).padStart(24, '0') });
      }
    },
    find(query) {
      return {
        sort(sort) {
          assert.deepEqual(sort, { _id: -1 });
          return { limit(limit) {
            assert.equal(limit, 51);
            return { lean: async () => rows.filter(r => !query._id || r._id < query._id.$lt)
              .sort((a, b) => b._id.localeCompare(a._id)).slice(0, limit) };
          } };
        },
      };
    },
  };
  const message = {
    id: 'discord-message-1', channelId: 'dm-channel', guildId: null,
    author: { id: 'user-1', username: 'someone', globalName: 'Someone', bot: false },
    content: 'Thanks for the reminder!', createdTimestamp: Date.now(),
    attachments: new Map([['file', { name: 'proof.png', url: 'https://cdn.discordapp.com/attachments/proof.png', size: 1234 }]]),
  };
  return { rows, message, inbox: createDmInbox({ Message }) };
}

test('captures incoming human DMs with author, timestamp, text and attachment metadata once', async () => {
  const f = fixture();
  assert.equal(await f.inbox.capture(f.message), true);
  await f.inbox.capture(f.message);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].authorId, 'user-1');
  assert.equal(f.rows[0].displayName, 'Someone');
  assert.equal(f.rows[0].content, 'Thanks for the reminder!');
  assert.equal(f.rows[0].channelId, 'dm-channel');
  assert.equal(f.rows[0].sentAt.getTime(), f.message.createdTimestamp);
  assert.deepEqual(f.rows[0].attachments[0], {
    name: 'proof.png', url: 'https://cdn.discordapp.com/attachments/proof.png', size: 1234,
  });
});

test('ignores guild messages, bots, webhooks and missing authors', async () => {
  const f = fixture();
  for (const message of [
    { ...f.message, guildId: 'guild' },
    { ...f.message, author: { ...f.message.author, bot: true } },
    { ...f.message, webhookId: 'webhook' },
    { ...f.message, author: null },
  ]) assert.equal(await f.inbox.capture(message), false);
  assert.equal(f.rows.length, 0);
});

test('attachment-only DMs and users without a global display name are captured', async () => {
  const f = fixture();
  f.message.content = '';
  f.message.author.globalName = null;
  await f.inbox.capture(f.message);
  assert.equal(f.rows[0].displayName, 'someone');
  assert.equal(f.rows[0].content, '');
  assert.equal(f.rows[0].attachments.length, 1);
});

test('inbox lists newest received first with stable 50-message pagination and validated cursors', async () => {
  const f = fixture();
  assert.deepEqual(await f.inbox.list(), { messages: [], nextCursor: null });
  for (let i = 0; i < 53; i++) await f.inbox.capture({ ...f.message, id: `message-${i}` });
  const first = await f.inbox.list();
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages[0].messageId, 'message-52');
  const second = await f.inbox.list(first.nextCursor);
  assert.equal(second.messages.length, 3);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.messages, ...second.messages].map(m => m.messageId)).size, 53);
  await assert.rejects(f.inbox.list('{"$ne":null}'), { status: 400 });
});

test('storage errors propagate rather than reporting a message saved successfully', async () => {
  const f = fixture();
  const inbox = createDmInbox({ Message: { updateOne: async () => { throw new Error('DB offline'); } } });
  await assert.rejects(inbox.capture(f.message), /DB offline/);
});

test('badge count includes the entire inbox, not only its first page', async () => {
  const f = fixture();
  assert.deepEqual(await f.inbox.count(), { count: 0 });
  for (let i = 0; i < 62; i++) await f.inbox.capture({ ...f.message, id: `message-${i}` });
  assert.deepEqual(await f.inbox.count(), { count: 62 });
  assert.equal((await f.inbox.list()).messages.length, 50);
});

test('sidebar badge hides zero, shows exact totals, polls and preserves the last count on failure', async () => {
  const html = fs.readFileSync(`${__dirname}/dashboard.html`, 'utf8');
  const source = html.slice(html.indexOf('let dmBadgeTimer = null;'), html.indexOf('let dmNextCursor = null;'));
  const nodes = Object.fromEntries(['nav-bot-dms', 'dm-count-badge'].map(id => [id, {
    hidden: true, textContent: '', title: '',
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
  }]));
  let response = { count: 0 };
  let status = 200;
  let interval;
  const context = vm.createContext({
    AUTH_TOKEN: 'test-session', currentDashboardUser: { role: 'mod' }, AbortController,
    document: { getElementById: id => nodes[id] },
    setTimeout: () => 1, clearTimeout: () => {}, clearInterval: () => { interval = null; },
    setInterval: (fn, ms) => { assert.equal(ms, 15000); interval = fn; return 1; },
    fetch: async (path, options) => {
      assert.equal(path, '/api/bot-dms/count');
      assert.equal(options.headers.Authorization, 'Bearer test-session');
      return { ok: status === 200, status, json: async () => response };
    },
  });
  vm.runInContext(source, context);
  await context.refreshDmBadge();
  assert.equal(nodes['dm-count-badge'].hidden, true);
  response = { count: 1200 };
  await context.refreshDmBadge();
  assert.equal(nodes['dm-count-badge'].textContent, '1200');
  assert.equal(nodes['dm-count-badge'].hidden, false);
  assert.equal(nodes['dm-count-badge']['aria-label'], '1200 saved direct messages');
  status = 503;
  await context.refreshDmBadge();
  assert.equal(nodes['dm-count-badge'].textContent, '1200');
  assert.match(nodes['nav-bot-dms'].title, /out of date/);
  context.startDmBadge();
  assert.equal(typeof interval, 'function');
  // Finish the outstanding initial refresh before exercising session expiry.
  await new Promise(resolve => setImmediate(resolve));
  status = 401;
  await context.refreshDmBadge();
  assert.equal(nodes['dm-count-badge'].hidden, true);
  assert.equal(interval, null);
  assert.match(nodes['nav-bot-dms'].title, /Sign in again/);
  const bot = fs.readFileSync(`${__dirname}/bot.js`, 'utf8');
  assert.ok(bot.indexOf("pathname === '/api/bot-dms/count'") > bot.indexOf('const authUser = checkAuth(req)'));
  assert.match(html, /id="dm-count-badge".*hidden aria-live="polite"/);
});

test('Discord DM intents/partials enabled, DMs exit before server commands, and inbox requires dashboard authentication', () => {
  const bot = fs.readFileSync(`${__dirname}/bot.js`, 'utf8');
  assert.match(bot, /GatewayIntentBits.DirectMessages/);
  assert.match(bot, /partials: \[Partials.Channel\]/);
  const capture = bot.slice(bot.indexOf('client.on(Events.MessageCreate'), bot.indexOf('// XP for chatting'));
  assert.match(capture, /if \(!message.guildId\)/);
  assert.match(capture, /await dmInbox.capture\(message\)/);
  assert.match(capture, /return; \/\/ Never run server commands/);
  assert.ok(bot.indexOf("if (pathname === '/api/bot-dms'") > bot.indexOf('const authUser = checkAuth(req)'));
  assert.match(bot, /await dmInbox.list\(params.get\('before'\)/);
});

test('dashboard renders DM text safely, includes safe attachment links, paginates and handles errors', async () => {
  const html = fs.readFileSync(`${__dirname}/dashboard.html`, 'utf8');
  const start = html.indexOf('let dmNextCursor = null;');
  const end = html.indexOf('// ---- CALENDAR ----', start);
  const nodes = Object.fromEntries(['dm-list', 'dm-status', 'dm-refresh', 'dm-older'].map(id => [id, {
    innerHTML: '', textContent: '', disabled: false, children: [], style: {},
    insertAdjacentHTML(_, text) { this.innerHTML += text; },
  }]));
  let response = { messages: [{
    displayName: '<script>bad()</script>', username: 'sender', authorId: 'user-1',
    content: '<img src=x onerror=bad()>', sentAt: new Date().toISOString(),
    attachments: [{ name: '<proof>', url: 'https://cdn.discordapp.com/a?x="test"' },
      { name: 'Unsafe', url: 'javascript:alert(1)' }],
  }], nextCursor: 'a'.repeat(24) };
  const requests = [];
  let ok = true;
  const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] },
    api: async (_, path) => { requests.push(path); return { ok, json: async () => response }; },
    esc: escape, escAttr: escape, Date, encodeURIComponent,
  });
  vm.runInContext(html.slice(start, end), context);
  await context.loadBotDms();
  assert.match(nodes['dm-list'].innerHTML, /&lt;script&gt;/);
  assert.match(nodes['dm-list'].innerHTML, /&lt;img/);
  assert.match(nodes['dm-list'].innerHTML, /&lt;proof&gt;/);
  assert.ok(!nodes['dm-list'].innerHTML.includes('javascript:'));
  assert.equal(nodes['dm-older'].style.display, 'inline-block');
  response = { messages: [], nextCursor: null };
  await context.loadBotDms(true);
  assert.match(requests[1], /\?before=aaaaaaaa/);
  assert.equal(nodes['dm-older'].style.display, 'none');
  ok = false;
  response = { error: 'Could not load bot DMs.' };
  await context.loadBotDms();
  assert.equal(nodes['dm-status'].textContent, 'Could not load bot DMs.');
  assert.equal(nodes['dm-refresh'].disabled, false);
  assert.match(html, /if \(name === 'bot-dms'\) loadBotDms\(\)/);
});
