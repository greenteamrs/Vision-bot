const test = require('node:test');
const assert = require('node:assert/strict');
const { findPendingRankUps, formatPendingRankUps } = require('./rank-audit');

const ranks = [
  { _id: 'r1', name: 'Recruit', order: 1, minDays: 0, minLootPoints: 0, minLevel: 0 },
  { _id: 'r2', name: 'Raider', order: 2, minDays: 10, minLootPoints: 100, minLevel: 2 },
  {
    _id: 'r3', name: 'Veteran', order: 3, minDays: 30, minLootPoints: 500, minLevel: 5,
    notifyOnEligibility: false, specialRequirement: 'Verify the required achievement.',
  },
];

test('rank audit finds qualifying members even if their notification was already sent', () => {
  const users = [{
    userId: '10001',
    username: 'StillWaiting',
    womRank: 'Recruit',
    notifiedRankId: 'r3',
    days: 40,
    lootPoints: 700,
    level: 6,
  }];

  const pending = findPendingRankUps({ ranks, users, daysInClan: user => user.days });

  assert.equal(pending.length, 1);
  assert.equal(pending[0].rankName, 'Veteran');
  assert.equal(pending[0].currentRank, 'Recruit');
  assert.equal(pending[0].specialRequirement, 'Verify the required achievement.');
});

test('rank audit excludes members already at or above their eligible rank', () => {
  const users = [
    { userId: '10002', username: 'Promoted', womRank: 'Veteran', days: 40, lootPoints: 700, level: 6 },
    { userId: '10003', username: 'NotReady', womRank: 'Recruit', days: 5, lootPoints: 10, level: 1 },
  ];

  assert.deepEqual(findPendingRankUps({ ranks, users, daysInClan: user => user.days }), []);
});

test('rank audit treats an equal configured rank order as already reached', () => {
  const tiedRanks = [...ranks.slice(0, 2), { ...ranks[2], order: 2 }];
  const pending = findPendingRankUps({
    ranks: tiedRanks,
    users: [{ userId: '10005', womRank: 'Raider', days: 40, lootPoints: 700, level: 6 }],
    daysInClan: user => user.days,
  });

  assert.deepEqual(pending, []);
});

test('rank audit reports eligible users with no matching WOM rank as outstanding', () => {
  const pending = findPendingRankUps({
    ranks,
    users: [{ userId: '10004', username: 'Unranked', womRank: '', days: 12, lootPoints: 120, level: 2 }],
    daysInClan: user => user.days,
  });

  assert.equal(pending.length, 1);
  assert.equal(pending[0].rankName, 'Raider');
  assert.equal(pending[0].currentRank, 'No WOM rank recorded');
});

test('rank check summary reports outstanding users without notification wording', () => {
  const text = formatPendingRankUps([{
    username: 'StillWaiting',
    currentRank: 'Recruit',
    rankName: 'Veteran',
  }]);

  assert.match(text, /1 outstanding rank-up/);
  assert.match(text, /Recruit → Veteran/);
  assert.doesNotMatch(text, /notification/i);
});
