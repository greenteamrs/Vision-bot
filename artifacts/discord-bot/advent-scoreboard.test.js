const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/dashboard.html`, 'utf8');
const start = source.indexOf('  function buildAdventScoreboard(');
const end = source.indexOf('  function renderAdventScoreboard(', start);
const build = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
const score = (submissions, run) => JSON.parse(JSON.stringify(build(submissions, run)));
const entry = (userId, day, status, username = userId) => ({ userId, username, day, status });

test('advent scoreboard counts distinct approved days and ranks ties equally', () => {
  const { rows } = score([
    entry('a', 1, 'approved'), entry('a', 1, 'approved'), entry('a', 2, 'pending'),
    entry('b', 1, 'rejected'), entry('b', 2, 'approved'), entry('c', 1, 'pending'),
    entry('d', 1, 'approved'), entry('d', 2, 'approved'),
  ], { state: 'running', day: 3 });
  assert.deepEqual(rows.map(row => [row.userId, row.points, row.place, row.missed]),
    [['d', 2, 1, 0], ['a', 1, 2, 1], ['b', 1, 2, 1], ['c', 0, 4, 2]]);
});
test('advent scoreboard excludes today and future days from missed totals', () => {
  for (const state of ['running', 'paused']) {
    assert.equal(score([entry('a', 1, 'approved')], { state, day: 2 }).rows[0].missed, 0);
  }
  assert.equal(score([entry('a', 1, 'pending')], { state: 'running', day: 1 }).rows[0].missed, 0);
  assert.equal(score([entry('a', 1, 'approved')], { state: 'completed', day: 26 }).rows[0].missed, 24);
});
test('advent scoreboard handles reset, invalid entries, and duplicate display names', () => {
  assert.deepEqual(score([], { state: 'idle', day: 0 }).rows, []);
  const { rows } = score([
    entry('a', 1, 'rejected', 'Same'), entry('a', 1, 'pending', 'Same'),
    entry('a', 1, 'approved', 'Same'), entry('b', 1, 'pending', 'Same'),
    entry('', 1, 'approved'), entry('a', 26, 'approved'), entry('a', 0, 'approved'),
    entry('a', 2, 'unknown'),
  ], { state: 'running', day: 1 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].points, 1);
  assert.equal(rows[1].points, 0);
  assert.equal(rows[0].days[1], 'approved');
});
