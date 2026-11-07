const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPriorityUpdates, withPriorityLevels } = require('./rank-priority');
const { findPendingRankUps } = require('./rank-audit');

const ranks = [
  { _id: 'low', name: 'Recruit', order: 0, minDays: 0, minLevel: 0, minLootPoints: 0 },
  { _id: 'mid', name: 'Raider', order: 5, minDays: 10, minLevel: 2, minLootPoints: 100 },
  { _id: 'high', name: 'Veteran', order: 20, minDays: 30, minLevel: 5, minLootPoints: 500 },
];

test('priority 1 remains the highest internal rank without reversing eligibility', () => {
  const changes = buildPriorityUpdates(ranks, [
    { id: 'high', priorityLevel: 1 }, { id: 'mid', priorityLevel: 2 }, { id: 'low', priorityLevel: 3 },
  ]);
  const updated = ranks.map(rank => ({ ...rank, order: changes.find(change => change.id === rank._id)?.order ?? rank.order }));
  const result = findPendingRankUps({
    ranks: updated.sort((a, b) => a.order - b.order),
    users: [{ userId: '1', droptrackerSetup: true, womRank: 'Raider', level: 6, lootPoints: 1000, days: 50 }],
    daysInClan: user => user.days,
  });
  assert.equal(result[0].rankName, 'Veteran');
  assert.deepEqual(changes.map(change => change.order), [-1, -2, -3]);
});

test('reordering priorities works for sparse or tied existing values', () => {
  const changes = buildPriorityUpdates(ranks.map(rank => ({ ...rank, order: 0 })), [
    { id: 'mid', priorityLevel: 1 }, { id: 'high', priorityLevel: 1 }, { id: 'low', priorityLevel: 3 },
  ]);
  assert.deepEqual(changes, [{ id: 'mid', order: -1 }, { id: 'high', order: -1 }, { id: 'low', order: -3 }]);
});

test('rejects outdated, incomplete, duplicate or unknown rank lists', () => {
  for (const ids of [undefined, ['high'], ['high', 'high', 'low'], ['high', 'mid', 'missing']]) {
    const priorities = ids?.map(id => ({ id, priorityLevel: 1 }));
    assert.throws(() => buildPriorityUpdates(ranks, priorities), /rank list changed/);
  }
});

test('unchanged priorities need no writes', () => {
  assert.deepEqual(buildPriorityUpdates([{ _id: '1', order: -1 }], [{ id: '1', priorityLevel: 1 }]), []);
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
    readBody: async () => ({ priorities: [
      { id: 'high', priorityLevel: 1 }, { id: 'mid', priorityLevel: 2 }, { id: 'low', priorityLevel: 3 },
    ] }),
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

test('shared priorities survive saving, reloading, and moving an unrelated rank', () => {
  const priorities = [
    { id: 'high', priorityLevel: 2 }, { id: 'mid', priorityLevel: 2 }, { id: 'low', priorityLevel: 5 },
  ];
  const changes = buildPriorityUpdates(ranks, priorities);
  const saved = ranks.map(rank => ({ ...rank, order: changes.find(item => item.id === rank._id).order }));
  const reloaded = withPriorityLevels(saved);
  assert.deepEqual(reloaded.map(rank => rank.priorityLevel), [5, 2, 2]);
  assert.deepEqual(buildPriorityUpdates(saved, priorities), []);
  const moved = buildPriorityUpdates(saved, priorities.map(item => item.id === 'low' ? { ...item, priorityLevel: 4 } : item));
  assert.deepEqual(moved, [{ id: 'low', order: -4 }]);
});

test('legacy equal tiers retain equal display priorities before any writes', () => {
  const display = withPriorityLevels(ranks.map(rank => ({ ...rank, order: rank._id === 'low' ? 0 : 20 })));
  assert.deepEqual(display.map(rank => rank.priorityLevel), [2, 1, 1]);
});

test('invalid priorities are rejected while shared positive whole numbers are accepted', () => {
  for (const priorityLevel of [0, -1, 1.5, NaN, Infinity, '2']) {
    assert.throws(() => buildPriorityUpdates([{ _id: '1', order: 0 }], [{ id: '1', priorityLevel }]), /positive whole number/);
  }
});

test('members at an equivalent tier are not flagged but lower tiers still qualify', () => {
  const equalRanks = ranks.map(rank => ({ ...rank, order: rank._id === 'low' ? -3 : -2 }));
  const pending = findPendingRankUps({
    ranks: equalRanks.sort((a, b) => a.order - b.order),
    users: [
      { userId: 'equal', droptrackerSetup: true, womRank: 'Raider', level: 6, lootPoints: 1000, days: 50 },
      { userId: 'lower', droptrackerSetup: true, womRank: 'Recruit', level: 6, lootPoints: 1000, days: 50 },
    ], daysInClan: user => user.days,
  });
  assert.deepEqual(pending.map(user => user.userId), ['lower']);
});

test('automatic rank checks do not send alerts for equivalent priorities', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { resolvePermanentRank } = require('./rank-history');
  const source = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
  const checker = source.slice(source.indexOf('async function checkRankUps('), source.indexOf('async function getRankAudit('));
  const equalRanks = ranks.map(rank => ({ ...rank, order: rank._id === 'low' ? -3 : -2 }));
  let channelRequests = 0;
  const context = vm.createContext({
    getRankCheckUsers: async () => [{
      userId: 'same-tier', droptrackerSetup: true, womRank: 'Raider', level: 6, lootPoints: 1000,
    }],
    getSettings: async () => ({}),
    XP_CHANNEL_ID: 'test',
    Rank: { find: () => ({ sort: async () => equalRanks }) },
    User: { updateOne: async () => {} },
    daysInClan: () => 50,
    resolvePermanentRank,
    ...require('./rank-requirements'),
    client: { channels: { fetch: async () => { channelRequests++; throw new Error('No alert expected'); } } },
    console,
  });
  vm.runInContext(checker, context);
  assert.equal(await vm.runInContext('checkRankUps({})', context), 0);
  assert.equal(channelRequests, 0);
});
