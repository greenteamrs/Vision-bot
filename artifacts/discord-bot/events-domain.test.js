const test = require('node:test');
const assert = require('node:assert/strict');
const { leaderboardFor, normalizeGoal, normalizeEventInput } = require('./events-domain');

test('normalizes optional Bingo coordinates from dashboard goal criteria', () => {
  const goal = normalizeGoal({
    name: 'Complete a raid',
    criteria: { row: '2', column: '4', minValue: null },
  });

  assert.equal(goal.row, 2);
  assert.equal(goal.col, 4);
  assert.equal(goal.criteria.row, 2);
  assert.equal(goal.criteria.column, 4);
  assert.equal(goal.criteria.minValue, 0);
});

test('requires narrow, reliable criteria for Droptracker verification', () => {
  assert.throws(
    () => normalizeGoal({ name: 'Get a drop', kind: 'drop', verification: 'droptracker' }),
    /requires a drop goal with an NPC or item name/,
  );

  assert.equal(normalizeGoal({
    name: 'Get a drop',
    kind: 'drop',
    verification: 'droptracker',
    criteria: { itemName: 'Dragon warhammer' },
  }).verification, 'droptracker');
});

test('validates event dates and creates events without preconfigured goals', () => {
  assert.deepEqual(normalizeEventInput({
    name: 'Weekend race',
    format: 'race',
    startsAt: '2026-10-10T09:00:00.000Z',
    endsAt: '2026-10-11T09:00:00.000Z',
  }).goals, []);

  assert.throws(() => normalizeEventInput({
    name: 'Bad dates',
    startsAt: '2026-10-11T09:00:00.000Z',
    endsAt: '2026-10-10T09:00:00.000Z',
  }), /must be after its start/);
});

test('includes enrolled members and teams before they score, without awarding empty bonuses', () => {
  const leaderboard = leaderboardFor({
    participationMode: 'solo',
    format: 'custom',
    scoringMode: 'task-points',
    scoringConfig: { firstPlaceBonus: 50 },
    goals: [],
    teams: [],
    participants: [
      { userId: '101', username: 'Alice' },
      { userId: '102', username: 'Bob' },
    ],
  }, []);

  assert.deepEqual(leaderboard.map(({ name, points }) => [name, points]), [
    ['Alice', 0],
    ['Bob', 0],
  ]);
});

test('ranks approved scores, excludes pending evidence, and includes teams with no score', () => {
  const leaderboard = leaderboardFor({
    participationMode: 'team',
    format: 'custom',
    scoringMode: 'task-points',
    scoringConfig: { firstPlaceBonus: 5 },
    goals: [{ _id: 'g1' }],
    teams: [
      { _id: 't1', name: 'Blue', color: '#0000ff' },
      { _id: 't2', name: 'Green', color: '#00ff00' },
    ],
    participants: [],
  }, [
    { targetId: 't1', targetType: 'team', goalId: 'g1', username: 'Blue', status: 'approved', pointsAwarded: 12 },
    { targetId: 't2', targetType: 'team', goalId: 'g1', username: 'Green', status: 'pending', pointsAwarded: 100 },
  ]);

  assert.deepEqual(leaderboard.map(({ name, points }) => [name, points]), [
    ['Blue', 17],
    ['Green', 0],
  ]);
});

test('uses the best value for each goal in highest-value competitions', () => {
  const leaderboard = leaderboardFor({
    participationMode: 'solo',
    format: 'drop',
    scoringMode: 'highest-value',
    scoringConfig: {},
    goals: [{ _id: 'g1', targetValue: 1 }, { _id: 'g2', targetValue: 1 }],
    teams: [],
    participants: [{ userId: '201', username: 'Ranger' }],
  }, [
    { targetId: '201', targetType: 'solo', goalId: 'g1', status: 'approved', value: 120 },
    { targetId: '201', targetType: 'solo', goalId: 'g1', status: 'approved', value: 180 },
    { targetId: '201', targetType: 'solo', goalId: 'g2', status: 'approved', value: 50 },
    { targetId: '201', targetType: 'solo', goalId: 'g2', status: 'pending', value: 900 },
  ]);

  assert.equal(leaderboard[0].points, 230);
  assert.equal(leaderboard[0].completedGoals, 2);
});
