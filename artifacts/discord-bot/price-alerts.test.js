const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parsePrice, createPriceAlertService } = require('./price-alerts');

function fixture() {
  let clock = new Date('2026-11-10T12:00:00Z');
  const rows = [];
  let seq = 0;
  const sent = [];
  const logs = [];
  const state = { prices: { 4151: { high: 700000, low: 650000 } }, dmError: null, apiError: null };
  const match = (row, q) => Object.entries(q).every(([k, v]) => {
    if (k === '$or') return v.some(c => match(row, c));
    if (v && typeof v === 'object' && '$lte' in v) return row[k] && new Date(row[k]) <= v.$lte;
    return v === null ? row[k] == null : row[k] === v;
  });
  const Alert = {
    async countDocuments(q) { return rows.filter(r => match(r, q)).length; },
    async create(data) {
      if (rows.some(r => ['userId', 'itemId', 'direction', 'priceType', 'targetPrice'].every(k => r[k] === data[k]))) throw Object.assign(new Error('dup'), { code: 11000 });
      const row = { _id: String(++seq).padStart(24, '0'), triggered: false, nextAttemptAt: null, lastPrice: null, ...data };
      rows.push(row); return row;
    },
    find(q) { const r = rows.filter(x => match(x, q)); return { sort: () => ({ lean: async () => r }), lean: async () => r.map(x => ({ ...x })) }; },
    async deleteOne(q) { const i = rows.findIndex(r => match(r, q)); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
    async updateOne(q, u) { const r = rows.find(x => match(x, q)); if (!r) return { modifiedCount: 0 }; Object.assign(r, u.$set); return { modifiedCount: 1 }; },
  };
  const client = { users: { fetch: async id => ({ send: async p => { if (state.dmError) throw Object.assign(new Error('x'), { code: state.dmError }); sent.push({ id, ...p }); } }) } };
  const fetchJson = async path => {
    if (state.apiError) throw new Error(state.apiError);
    if (path === '/mapping') return [{ id: 4151, name: 'Abyssal whip' }, { id: 11802, name: 'Armadyl godsword' }, { id: 4152, name: 'Whip lash' }];
    return { data: state.prices };
  };
  const service = createPriceAlertService({ Alert, client, fetchJson, now: () => clock, logger: { log: () => {}, warn: m => logs.push(m), error: m => logs.push(m) } });
  return { service, rows, sent, logs, state, advance: ms => { clock = new Date(clock.getTime() + ms); } };
}

test('parses plain, comma, decimal and k/m/b prices and rejects invalid ones', () => {
  assert.equal(parsePrice('1500000'), 1500000);
  assert.equal(parsePrice('1.5m'), 1500000);
  assert.equal(parsePrice('2,5m'), 2500000);
  assert.equal(parsePrice('250K'), 250000);
  assert.equal(parsePrice('2.1b'), 2100000000);
  assert.equal(parsePrice('2500000000'), 2500000000);
  for (const bad of ['', '0', '-5', 'abc', '1e6', '1.2.3', '200b']) assert.equal(parsePrice(bad), null);
});

test('item search prefers names starting with the query and caps suggestions', async () => {
  const f = fixture();
  assert.deepEqual((await f.service.searchItems('whip')).map(i => i.name), ['Whip lash', 'Abyssal whip']);
});

test('creates, lists, removes alerts; rejects bad input, duplicates and other users removing', async () => {
  const f = fixture();
  const alert = await f.service.add({ userId: 'u1', itemId: '4151', direction: 'below', targetPrice: '650k' });
  assert.equal(alert.targetPrice, 650000);
  await assert.rejects(f.service.add({ userId: 'u1', itemId: '4151', direction: 'below', targetPrice: '650k' }), /already have/);
  await assert.rejects(f.service.add({ userId: 'u1', itemId: '1', direction: 'below', targetPrice: '5' }), /Choose an item/);
  await assert.rejects(f.service.add({ userId: 'u1', itemId: '4151', direction: 'below', targetPrice: 'x' }), /valid price/);
  assert.equal(await f.service.remove('u2', alert._id), false);
  assert.equal((await f.service.list('u1')).length, 1);
  assert.equal(await f.service.remove('u1', alert._id), true);
  assert.equal(await f.service.remove('u1', 'bad'), false);
});

test('DMs once when reached, not again while it stays reached, then re-arms after the price recovers', async () => {
  const f = fixture();
  await f.service.add({ userId: 'u1', itemId: '4151', direction: 'below', targetPrice: '650k' });
  await f.service.run();
  assert.equal(f.sent.length, 0);
  f.state.prices[4151] = { high: 640000, low: 600000 };
  await f.service.run(); await f.service.run();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].content, /Abyssal whip.*640000 gp.*at or below.*650000/s);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [] });
  f.state.prices[4151] = { high: 700000, low: 600000 };
  await f.service.run();
  f.state.prices[4151] = { high: 645000, low: 600000 };
  await f.service.run();
  assert.equal(f.sent.length, 2);
});

test('above alerts and sell-price alerts use the right side of the wiki price', async () => {
  const f = fixture();
  await f.service.add({ userId: 'u1', itemId: '4151', direction: 'above', priceType: 'sell', targetPrice: '660k' });
  await f.service.run();
  assert.equal(f.sent.length, 0);
  f.state.prices[4151] = { high: 700000, low: 660000 };
  await f.service.run();
  assert.equal(f.sent.length, 1);
});

test('failed DMs retry after a delay without spamming; API errors are contained', async () => {
  const f = fixture();
  await f.service.add({ userId: 'u1', itemId: '4151', direction: 'above', targetPrice: '600k' });
  f.state.dmError = 50007;
  await f.service.run(); await f.service.run();
  assert.equal(f.logs.length, 1);
  f.state.dmError = null;
  f.advance(31 * 60 * 1000);
  await f.service.run();
  assert.equal(f.sent.length, 1);
  f.state.apiError = 'down';
  f.rows[0].triggered = false; f.rows[0].nextAttemptAt = null;
  await f.service.run();
  assert.equal(f.sent.length, 1);
  assert.ok(f.logs.some(m => /Check failed/.test(m)));
});

test('missing wiki prices are ignored and command is registered with mod-only handling', async () => {
  const f = fixture();
  await f.service.add({ userId: 'u1', itemId: '11802', direction: 'below', targetPrice: '1m' });
  await f.service.run();
  assert.equal(f.sent.length, 0);
  const bot = fs.readFileSync(`${__dirname}/bot.js`, 'utf8');
  assert.match(bot, /setName\('pricealert'\)/);
  assert.match(bot, /cron.schedule\('\*\/5 \* \* \* \*', \(\) => priceAlerts.run\(\)\)/);
  assert.match(bot, /if \(!isAdmin\(interaction.member\) && !isMod\(interaction.member\)\) \{\s*return interaction.editReply/);
});
