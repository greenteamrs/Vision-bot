const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPriorityUpdates } = require('./rank-priority');
const { findPendingRankUps } = require('./rank-audit');

const ranks = [
  { _id: 'low', name: 'Recruit', order: 0, minDays: 0, minLevel: 0, minLootPoints: 0 },
  { _id: 'mid', name: 'Raider', order: 5, minDays: 10, minLevel: 2, minLootPoints: 100 },
  { _id: 'high', name: 'Veteran', order: 20, minDays: 30, minLevel: 5, minLootPoints: 500 },
];

test('priority 1 remains the highest internal rank without reversing eligibility', () => {
  const changes = buildPriorityUpdates(ranks, ['high', 'mid', 'low']);
  const updated = ranks.map(rank => ({ ...rank, order: changes.find(change => change.id === rank._id)?.order ?? rank.order }));
  const result = findPendingRankUps({
    ranks: updated.sort((a, b) => a.order - b.order),
    users: [{ userId: '1', womRank: 'Raider', level: 6, lootPoints: 1000, days: 50 }],
    daysInClan: user => user.days,
  });
  assert.equal(result[0].rankName, 'Veteran');
  assert.deepEqual(changes.map(change => change.order), [3, 2, 1]);
});

test('reordering priorities works for sparse or tied existing values', () => {
  const changes = buildPriorityUpdates(ranks.map(rank => ({ ...rank, order: 0 })), ['mid', 'high', 'low']);
  assert.deepEqual(changes, [{ id: 'mid', order: 3 }, { id: 'high', order: 2 }, { id: 'low', order: 1 }]);
});

test('rejects outdated, incomplete, duplicate or unknown rank lists', () => {
  for (const ids of [undefined, ['high'], ['high', 'high', 'low'], ['high', 'mid', 'missing']]) {
    assert.throws(() => buildPriorityUpdates(ranks, ids), /rank list changed/);
  }
});

test('unchanged priorities need no writes', () => {
  assert.deepEqual(buildPriorityUpdates([{ _id: '1', order: 1 }], ['1']), []);
});

test('priority endpoint checks every changed rank lock before writing', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
  const route = source.slice(source.indexOf('    // POST /api/ranks/priorities'), source.indexOf('    // GET /api/ranks'));
  let writes = 0;
  let denied = true;
  const checkedKeys = [];
  const context = vm.createContext({
    pathname: '/api/ranks/priorities', req: { method: 'POST' }, res: {}, authUser: {},
    readBody: async () => ({ rankIds: ['high', 'mid', 'low'] }),
    Rank: { find: () => ({ lean: async () => ranks }), bulkWrite: async () => { writes++; } },
    buildPriorityUpdates,
    dashboardEditBlocked: async (_user, _res, keys) => { checkedKeys.push(...keys); return denied; },
    sendJson() {},
  });
  vm.runInContext(`async function runRoute() { ${route} }`, context);
  await vm.runInContext('runRoute()', context);
  assert.equal(writes, 0);
  assert.deepEqual(checkedKeys, ['rank.high.order', 'rank.mid.order', 'rank.low.order']);
  denied = false;
  await vm.runInContext('runRoute()', context);
  assert.equal(writes, 1);
});
