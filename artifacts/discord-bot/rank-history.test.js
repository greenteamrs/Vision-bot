const test = require('node:test');
const assert = require('node:assert/strict');
const { womRankUpdates, resolvePermanentRank, unknownPermanentRanks } = require('./rank-history');
const { findPendingRankUps, formatPendingRankUps } = require('./rank-audit');

const ranks = [
  { name: 'Gnome Child', order: 0, minDays: 0, minLootPoints: 0, minLevel: 0 },
  { name: 'Leader', order: 1, minDays: 5, minLootPoints: 20, minLevel: 1 },
  { name: 'Knight', order: 2, minDays: 10, minLootPoints: 100, minLevel: 5 },
  { name: 'Season Winner', order: 10, minDays: 0, minLootPoints: 0, minLevel: 0, isTemporary: true },
  { name: 'Winter Champion', order: 11, minDays: 0, minLootPoints: 0, minLevel: 0, isTemporary: true },
  { name: 'Selected Admin', order: 12, minDays: 0, minLootPoints: 0, minLevel: 0, notifyOnEligibility: false },
];

test('WOM seasonal transition saves the prior permanent rank before replacing it', () => {
  for (const name of ['Gnome Child', 'Leader', 'Knight']) {
    assert.deepEqual(womRankUpdates({ womRank: name }, 'Season Winner', ranks), {
      womRank: 'Season Winner', permanentRank: name,
    });
  }
});

test('normal WOM sync backfills original rank and tracks permanent promotions', () => {
  assert.deepEqual(womRankUpdates({ womRank: 'Leader' }, 'Leader', ranks), { permanentRank: 'Leader' });
  assert.deepEqual(womRankUpdates({ womRank: 'Leader', permanentRank: 'Leader' }, 'Knight', ranks), {
    womRank: 'Knight', permanentRank: 'Knight',
  });
  assert.deepEqual(womRankUpdates({ womRank: 'Knight', permanentRank: 'Knight' }, '', ranks), {});
});

test('repeated seasonal syncs and seasonal-to-seasonal changes never erase the original', () => {
  const user = { womRank: 'Season Winner', permanentRank: 'Leader' };
  assert.deepEqual(womRankUpdates(user, 'Season Winner', ranks), {});
  assert.deepEqual(womRankUpdates(user, 'Winter Champion', ranks), { womRank: 'Winter Champion' });
  assert.deepEqual(womRankUpdates({ ...user, permanentRank: '' }, 'Winter Champion', ranks), { womRank: 'Winter Champion' });
});

test('when the season ends the normal WOM rank becomes authoritative again', () => {
  const user = { womRank: 'Season Winner', permanentRank: 'Leader' };
  const updated = { ...user, ...womRankUpdates(user, 'Knight', ranks) };
  assert.equal(updated.permanentRank, 'Knight');
  assert.equal(resolvePermanentRank(updated, ranks).rank.name, 'Knight');
});

test('rank checks use saved Gnome Child and Leader ranks despite higher seasonal tiers', () => {
  const pending = findPendingRankUps({
    ranks,
    users: ['Gnome Child', 'Leader'].map((permanentRank, i) => ({
      userId: String(i), womRank: 'Season Winner', permanentRank, days: 30, lootPoints: 300, level: 10,
    })),
    daysInClan: user => user.days,
  });
  assert.deepEqual(pending.map(item => [item.currentRank, item.rankName]), [
    ['Gnome Child', 'Knight'], ['Leader', 'Knight'],
  ]);
});

test('current permanent Discord role identifies seasonal members with no saved history', () => {
  const user = { womRank: 'Season Winner', discordRankNames: ['Visionaries', 'Knight', 'Winter Champion'] };
  assert.equal(resolvePermanentRank(user, ranks).rank.name, 'Knight');
  assert.equal(resolvePermanentRank({ ...user, permanentRank: 'Leader' }, ranks).rank.name, 'Knight');
});

test('seasonal members without history or a permanent Discord role are flagged, not guessed', () => {
  const user = { userId: '1', username: 'UnknownOriginal', womRank: 'Season Winner', discordRankNames: ['Visionaries'], level: 10, lootPoints: 500 };
  assert.equal(resolvePermanentRank(user, ranks).unknown, true);
  assert.deepEqual(findPendingRankUps({ ranks, users: [user], daysInClan: () => 100 }), []);
  const unknownRanks = unknownPermanentRanks(ranks, [user]);
  assert.equal(unknownRanks.length, 1);
  assert.match(formatPendingRankUps([], { unknownRanks }), /Original rank unknown.*UnknownOriginal/);
});

test('command rows use the requested fields, confirmation icons and decimal LP without grouping', () => {
  const text = formatPendingRankUps([{
    rsName: 'Example RSN', username: 'DiscordName', lootPoints: 2414.5,
    level: 12, days: 30, droptrackerSetup: true, currentRank: 'Leader', rankName: 'Knight',
  }]);
  assert.match(text, /Example RSN \/ DiscordName \/ LP: 2414,5 \/ Days in clan: 30 \/ Community: 12 \/ Droptracker: ✅ \/ Leader → Knight/);
});

test('missing WOM rank uses the saved original rank instead of claiming no rank is recorded', () => {
  for (const womRank of [undefined, null, '', '   ']) {
    const user = {
      userId: 'saved', womRank, permanentRank: 'Leader',
      level: 10, lootPoints: 500,
    };
    const pending = findPendingRankUps({ ranks, users: [user], daysInClan: () => 50 });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].currentRank, 'Leader');
    assert.doesNotMatch(formatPendingRankUps(pending), /No WOM rank recorded/);
  }
});

test('missing WOM rank can use a permanent Discord rank and suppress false promotions', () => {
  const user = {
    userId: 'role', womRank: '', permanentRank: 'Leader',
    discordRankNames: ['Visionaries', 'Knight', 'Season Winner'],
    level: 10, lootPoints: 500,
  };
  assert.equal(resolvePermanentRank(user, ranks).rank.name, 'Knight');
  assert.deepEqual(findPendingRankUps({ ranks, users: [user], daysInClan: () => 50 }), []);
});

test('recorded permanent WOM rank stays authoritative over saved history and Discord roles', () => {
  const user = {
    womRank: 'Leader', permanentRank: 'Gnome Child', discordRankNames: ['Visionaries', 'Knight'],
  };
  assert.equal(resolvePermanentRank(user, ranks).rank.name, 'Leader');
});

test('missing ranks are not fabricated from Visionaries or a saved seasonal tier', () => {
  const user = { womRank: '', permanentRank: 'Season Winner', discordRankNames: ['Visionaries'] };
  assert.equal(resolvePermanentRank(user, ranks).rank, undefined);
  assert.equal(resolvePermanentRank(user, ranks).name, '');
});

test('saved rank names not yet mapped in dashboard still remain visible in audit output', () => {
  const user = { womRank: '', permanentRank: 'Unmapped original' };
  assert.equal(resolvePermanentRank(user, ranks).name, 'Unmapped original');
});
