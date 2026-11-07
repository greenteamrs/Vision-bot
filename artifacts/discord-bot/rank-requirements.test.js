const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const requirements = require('./rank-requirements');
const { findPendingRankUps } = require('./rank-audit');
const { resolvePermanentRank } = require('./rank-history');
const { profileStats, manualStatUpdates, combatProgress } = require('./user-stats');

const makeRank = (name, order) => ({
  _id: name, name, order, minDays: 10, minLootPoints: 100, minLevel: 5,
});
const leader = makeRank('Leader', -10);
const knight = makeRank('Knight', -9);
const maxed = makeRank('Maxed', -8);
const tzkal = makeRank('TzKal', -8);
const collector = makeRank('Collector', -8);
const imp = makeRank('Imp', -11);
const seasonal = { ...makeRank('Season Winner', -1), isTemporary: true };
const allRanks = [imp, leader, knight, maxed, tzkal, collector, seasonal];
const member = {
  userId: 'member', womRank: 'Leader', days: 50, lootPoints: 500, level: 10,
  droptrackerSetup: true, totalLevel: 2376, combatAchievementPoints: 1965, collectionLogCount: 900,
};
const audit = (user, ranks = allRanks) => findPendingRankUps({
  ranks, users: [user], daysInClan: u => u.days,
});

test('Imp members never receive a promotion, including seasonal originals and Discord roles', () => {
  for (const user of [
    { ...member, womRank: ' Imp ' },
    { ...member, womRank: 'Season Winner', permanentRank: 'Imp' },
    { ...member, womRank: 'Season Winner', permanentRank: 'Imp', discordRankNames: ['Knight'] },
    { ...member, womRank: '', permanentRank: 'Imp' },
    { ...member, discordRankNames: ['Visionaries', 'Imp'] },
  ]) assert.deepEqual(audit(user), []);
  assert.equal(audit({ ...member, permanentRank: 'Imp' }).length, 1); // stale history is not authoritative
  assert.equal(requirements.meetsRankRequirements(imp, member, 50, allRanks), false);
});

test('named OSRS requirements are inclusive minimums, with missing stats blocked', () => {
  for (const [target, field, minimum] of [
    [maxed, 'totalLevel', 2376],
    [tzkal, 'combatAchievementPoints', 1965],
    [collector, 'collectionLogCount', 900],
  ]) {
    const ranks = [leader, target];
    for (const value of [undefined, null, 0, minimum - 1]) {
      assert.deepEqual(audit({ ...member, [field]: value }, ranks), [], `${target.name}: ${value}`);
    }
    for (const value of [minimum, minimum + 1]) {
      assert.equal(audit({ ...member, [field]: value }, ranks)[0].rankName, target.name);
    }
    assert.deepEqual(audit({ ...member, droptrackerSetup: false }, ranks), []);
  }
  assert.deepEqual(audit({ ...member, combatAchievementTier: 'Master', combatAchievementPoints: null }, [leader, tzkal]), []);
});

test('every rank strictly above Leader requires confirmed DropTracker; Leader and lower do not', () => {
  const low = makeRank('Gnome Child', -12);
  for (const target of [knight, maxed, tzkal, collector]) {
    for (const confirmed of [undefined, false, 'true']) {
      assert.equal(requirements.meetsRankRequirements(target, { ...member, droptrackerSetup: confirmed }, 50, allRanks), false);
    }
    assert.equal(requirements.meetsRankRequirements(target, member, 50, allRanks), true);
  }
  for (const target of [low, leader, { ...knight, order: leader.order }]) {
    assert.equal(requirements.meetsRankRequirements(target, { ...member, droptrackerSetup: false }, 50, [low, leader, target]), true);
  }
  assert.equal(audit({ ...member, womRank: 'Gnome Child', droptrackerSetup: false }, [low, leader, knight])[0].rankName, 'Leader');
  assert.equal(requirements.requiresDroptracker(knight, [knight]), true); // hierarchy absent: fail closed
});

test('new requirements supplement existing thresholds, notification settings, seasonal and equal tiers', () => {
  for (const change of [{ days: 9 }, { lootPoints: 99 }, { level: 4 }]) {
    assert.deepEqual(audit({ ...member, ...change }, [leader, maxed]), []);
  }
  assert.deepEqual(audit(member, [leader, { ...maxed, notifyOnEligibility: false }]), []);
  assert.deepEqual(audit(member, [leader, { ...maxed, isTemporary: true }]), []);
  assert.deepEqual(audit({ ...member, womRank: 'Maxed' }, [leader, maxed, tzkal, collector]), []);
  assert.equal(audit({ ...member, womRank: 'Season Winner', permanentRank: 'Leader' })[0].currentRank, 'Leader');
});

test('dashboard rank descriptions expose the enforced named and setup requirements', () => {
  assert.deepEqual(requirements.automaticRequirements(maxed, allRanks),
    ['DropTracker setup confirmed', 'Total level ≥ 2376']);
  assert.deepEqual(requirements.automaticRequirements(tzkal, allRanks),
    ['DropTracker setup confirmed', 'Combat Achievement points ≥ 1965']);
  assert.deepEqual(requirements.automaticRequirements(collector, allRanks),
    ['DropTracker setup confirmed', 'Collection log count ≥ 900']);
  assert.deepEqual(requirements.automaticRequirements(leader, allRanks), []);
  assert.match(requirements.automaticRequirements(imp, allRanks)[0], /no automatic rank-ups/);
});

test('CA points are synced from completed tasks and have independent validated manual overrides', () => {
  const rows = ['Easy','Medium','Hard','Elite','Master','Grandmaster'].map((name, i) =>
    ({ name, total: [41, 64, 89, 166, 173, 122][i], completed: [41, 64, 89, 166, 173, 0][i] }));
  assert.equal(combatProgress(rows).points, 1965);
  const stats = profileStats({ username: 'Example', combatAchievements: rows }, 'Example');
  assert.equal(stats.combatAchievementPoints, 1965);
  assert.deepEqual(manualStatUpdates({}, { combatAchievementPoints: 1965 }), {
    combatAchievementPoints: 1965, 'statsManual.combatAchievementPoints': true,
  });
  assert.deepEqual(manualStatUpdates({ combatAchievementPoints: 1965 }, { combatAchievementPoints: null }), {
    combatAchievementPoints: null, 'statsManual.combatAchievementPoints': false,
  });
  for (const value of [-1, 1.2, '1965', Infinity]) {
    assert.throws(() => manualStatUpdates({}, { combatAchievementPoints: value }));
  }
});

test('automatic alerts and manual audits enforce the same full requirements at exact boundaries', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
  const checker = source.slice(source.indexOf('async function checkRankUps('), source.indexOf('async function getRankAudit('));
  for (const [target, changes, expected] of [
    [maxed, { totalLevel: 2375 }, 0], [maxed, { totalLevel: 2376 }, 1],
    [tzkal, { combatAchievementPoints: 1964 }, 0], [tzkal, { combatAchievementPoints: 1965 }, 1],
    [collector, { collectionLogCount: 899 }, 0], [collector, { collectionLogCount: 900 }, 1],
    [knight, { droptrackerSetup: false }, 0], [knight, { droptrackerSetup: true }, 1],
    [maxed, { womRank: 'Imp' }, 0],
    [tzkal, { womRank: 'Season Winner', permanentRank: 'Imp' }, 0],
  ]) {
    const user = { ...member, ...changes };
    const ranks = [imp, leader, target, seasonal];
    let sends = 0;
    const context = vm.createContext({
      ...requirements, resolvePermanentRank,
      getRankCheckUsers: async () => [user], getSettings: async () => ({}),
      Rank: { find: () => ({ sort: async () => ranks }) },
      User: { updateOne: async () => {} }, daysInClan: u => u.days, XP_CHANNEL_ID: 'test',
      client: { channels: { fetch: async () => ({ send: async () => { sends++; } }) } }, console,
    });
    vm.runInContext(checker, context);
    assert.equal(await context.checkRankUps(null), expected, `${target.name}: ${JSON.stringify(changes)}`);
    assert.equal(sends, expected);
    assert.equal(audit(user, ranks).length, expected);
  }
});
