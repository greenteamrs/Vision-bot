const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { CA_TIERS, combatTier, profileStats, manualStatUpdates, createUserStatsService } = require('./user-stats');

const ca = completed => CA_TIERS.slice(1).map((name, i) => ({
  name, total: 10, completed: completed?.[i] ?? 0,
}));
const profile = {
  username: 'Example', skills: { totalLevel: 2100 },
  collectionLog: { obtained: 0 }, combatAchievements: ca([10, 10, 10, 0, 0, 0]),
};

test('CA tiers use earned points across difficulties, and live cumulative thresholds', () => {
  assert.equal(combatTier(ca()), 'None');
  assert.equal(combatTier(ca([0, 0, 0, 0, 0, 5])), 'Medium'); // 30 points, no completed Easy tasks
  assert.equal(combatTier(ca([10, 10, 10, 10, 10, 10])), 'Grandmaster');
  const changed = ca([0, 0, 0, 0, 0, 5]);
  changed[0].total = 11;
  assert.equal(combatTier(changed), 'Easy'); // Medium now requires 31 points
  for (const invalid of [undefined, [], ca().slice(0, 5), ca().map(r => ({ ...r, completed: 11 }))]) {
    assert.equal(combatTier(invalid), null);
  }
});

test('RuneProfile parsing distinguishes known zero from missing and rejects the wrong account', () => {
  assert.deepEqual(profileStats(profile, 'example'), {
    totalLevel: 2100, collectionLogCount: 0, combatAchievementTier: 'Hard',
  });
  assert.throws(() => profileStats(profile, 'other'), /different account/);
  assert.throws(() => profileStats({ username: 'Example' }, 'Example'), /no valid stats/);
  assert.deepEqual(profileStats({ username: 'Example', skills: { totalLevel: 2000 } }, 'Example'), { totalLevel: 2000 });
});

test('manual stats validate strictly; unchanged fields remain automatic and clearing releases overrides', () => {
  assert.deepEqual(manualStatUpdates({ totalLevel: 2100 }, { totalLevel: 2100 }), {});
  assert.deepEqual(manualStatUpdates({}, { collectionLogCount: 0 }), {
    collectionLogCount: 0, 'statsManual.collectionLogCount': true,
  });
  assert.deepEqual(manualStatUpdates({ combatAchievementTier: 'Elite' }, { combatAchievementTier: null }), {
    combatAchievementTier: null, 'statsManual.combatAchievementTier': false,
  });
  for (const data of [{ totalLevel: 0 }, { totalLevel: '2000' }, { collectionLogCount: -1 },
    { collectionLogCount: 2.5 }, { combatAchievementTier: 'Invalid' }, { totalLevel: Infinity }]) {
    assert.throws(() => manualStatUpdates({}, data));
  }
});

function fixture({ users = [{ userId: '1', rsName: 'Example', rsNames: [] }],
  locks = {}, response = profile, providerStatus = 200, wom = 2200, failDb = false } = {}) {
  let clock = 0;
  const writes = [], urls = [], waits = [];
  const User = {
    find: () => ({ lean: async () => {
      if (failDb) throw new Error('Database unavailable');
      return users;
    } }),
    updateOne: async (query, update) => {
      const user = users.find(user => user.userId === query.userId);
      const field = Object.keys(update.$set)[0];
      writes.push({ query, update });
      const matched = !user?.statsManual?.[field];
      if (matched) Object.assign(user, update.$set);
      return { matchedCount: matched ? 1 : 0 };
    },
  };
  const service = createUserStatsService({
    User, getSettings: async () => ({ womGroupId: '123' }),
    getLocks: async () => locks, now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms; },
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal);
      if (url.includes('wiseoldman')) return { ok: true, json: async () =>
        [{ player: { username: 'Example' }, data: { data: { skills: { overall: { level: wom } } } } }] };
      return { ok: providerStatus === 200, status: providerStatus,
        headers: { get: () => null }, json: async () => response };
    },
  });
  async function finish() {
    for (let i = 0; i < 100 && service.status().status === 'running'; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.notEqual(service.status().status, 'running');
    return service.status();
  }
  return { service, finish, writes, urls, waits, users };
}

test('background sync is single-flight, uses one WOM bulk request and paces RuneProfile', async () => {
  const f = fixture({ users: [
    { userId: '1', rsName: 'Example', rsNames: [] },
    { userId: '2', rsName: 'Example', rsNames: [] },
    { userId: '3' },
  ] });
  f.service.start();
  f.service.start();
  const status = await f.finish();
  assert.equal(status.updated, 2);
  assert.equal(status.missingRsn, 1);
  assert.equal(f.urls.filter(url => url.includes('wiseoldman')).length, 1);
  assert.deepEqual(f.waits, [2100]);
  assert.equal(f.users[0].totalLevel, 2200); // WOM preferred over RuneProfile
  assert.equal(f.users[0].collectionLogCount, 0);
});

test('sync preserves manual and locked values and uses conditional identity/override writes', async () => {
  const f = fixture({ users: [{ userId: '1', rsName: 'Example', rsNames: [],
    totalLevel: 2300, statsManual: { totalLevel: true } }],
    locks: { 'user.1.collectionLogCount': true } });
  f.service.start();
  await f.finish();
  assert.equal(f.users[0].totalLevel, 2300);
  assert.equal(f.writes.some(write => Object.hasOwn(write.update.$set, 'collectionLogCount')), false);
  assert.equal(f.users[0].combatAchievementTier, 'Hard');
  for (const { query } of f.writes) {
    assert.equal(query.rsName, 'Example');
    assert.deepEqual(query.rsNames, []);
    assert.equal(Object.values(query).some(value => value?.$ne === true), true);
  }
});

test('missing RuneProfile and provider failures preserve old stats while WOM can still update level', async () => {
  for (const providerStatus of [404, 500, 429]) {
    const f = fixture({ providerStatus, users: [{ userId: '1', rsName: 'Example', rsNames: [],
      combatAchievementTier: 'Elite', collectionLogCount: 600 }] });
    f.service.start();
    const status = await f.finish();
    assert.equal(f.users[0].totalLevel, 2200);
    assert.equal(f.users[0].combatAchievementTier, 'Elite');
    assert.equal(f.users[0].collectionLogCount, 600);
    assert.equal(providerStatus === 404 ? status.missingProfile : status.failed, 1);
  }
});

test('invalid data never becomes zero or a made-up CA tier; failed database jobs finish explicitly', async () => {
  const f = fixture({ response: { username: 'Example' }, wom: null });
  f.service.start();
  assert.equal((await f.finish()).failed, 1);
  assert.equal(f.writes.length, 0);
  const db = fixture({ failDb: true });
  db.service.start();
  assert.equal((await db.finish()).status, 'failed');
  assert.match(db.service.status().error, /Database unavailable/);
});

test('legacy users without an RSN array can sync without requiring a database migration', async () => {
  const f = fixture({ users: [{ userId: '1', rsName: 'Example' }] });
  f.service.start();
  await f.finish();
  assert.equal(f.writes[0].query.rsNames, null); // Mongo null matches absent fields
});

const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const bot = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');

test('Users UI exposes stats, manual inputs, sortable counts, and scrollable modal', () => {
  for (const id of ['modal-total-level', 'modal-ca-tier', 'modal-collection-log', 'btn-users-stats-sync']) {
    assert.ok(html.includes(`id="${id}"`));
  }
  for (const field of ['totalLevel', 'combatAchievementTier', 'collectionLogCount']) {
    assert.ok(html.includes(`'${field}'`));
  }
  assert.match(html, /u\[field\] \?\? 'Unknown'/);
  assert.match(html, /u\.statsManual\?\.\[field\]/);
  assert.match(html, /max-height: 90vh/);
  assert.match(bot, /manualStatUpdates\(existing, data\)/);
  assert.ok(bot.indexOf('dashboardEditBlocked(authUser, res, lockKeys)', bot.indexOf('const statPatch'))
    < bot.indexOf('Object.assign(update, statPatch)'));
});

test('edit form sends changes and clear-to-auto without freezing unchanged synced stats', async () => {
  const nodes = {};
  for (const id of ['userid','username','name','rsname','permanent-rank','level','xp','lp',
    'total-level','ca-tier','collection-log']) {
    nodes[`modal-${id}`] = { value: '', dataset: {} };
  }
  nodes['edit-modal'] = { classList: { add() {}, remove() {} } };
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] }, currentPage: 1,
    hydrateDashboardLockControls() {}, showToast() {}, loadUsers() {},
    api: async (...args) => { requests.push(args); return { ok: true }; },
  });
  vm.runInContext(html.slice(html.indexOf('  function openEditModal('), html.indexOf('  function showSection(')), context);
  const user = { userId: '1', level: 2, xp: 20, lootPoints: 2.5,
    totalLevel: 2000, combatAchievementTier: 'Elite', collectionLogCount: 600 };
  context.openEditModal(user);
  nodes['modal-name'].value = 'Renamed';
  await context.saveUser();
  assert.equal(Object.hasOwn(requests[0][2], 'totalLevel'), false);
  nodes['modal-total-level'].value = '2100';
  nodes['modal-ca-tier'].value = '';
  nodes['modal-collection-log'].value = '0';
  await context.saveUser();
  assert.equal(requests[1][2].totalLevel, 2100);
  assert.equal(requests[1][2].combatAchievementTier, null);
  assert.equal(requests[1][2].collectionLogCount, 0);
  assert.equal(nodes['modal-total-level'].dataset.lockKey, 'user.1.totalLevel');
  context.openEditModal({ userId: '2' });
  assert.equal(nodes['modal-total-level'].value, '');
});

test('stats sync button polls background progress, refreshes results, and restores on errors', async () => {
  for (const fail of [false, true]) {
    const node = { textContent: '' }, button = { disabled: false }, requests = [];
    let refreshes = 0;
    const context = vm.createContext({
      document: { getElementById: () => node },
      setTimeout: fn => { fn(); }, currentPage: 1, showToast() {},
      loadUsers: async () => { refreshes++; },
      api: async (method, url) => {
        requests.push([method, url]);
        return { ok: !fail, json: async () => fail ? { error: 'Unauthorized' }
          : method === 'POST' ? { status: 'running', processed: 0, total: 1 }
          : { status: 'complete', updated: 1, missingRsn: 0, missingProfile: 0, failed: 0 } };
      },
    });
    vm.runInContext(html.slice(html.indexOf('  let userStatsPolling'), html.indexOf('  async function syncWomDashboard(')), context);
    await context.syncUserStats(button);
    assert.equal(button.disabled, false);
    assert.equal(refreshes, fail ? 0 : 1);
    assert.match(node.textContent, fail ? /Unauthorized/ : /Sync complete: 1 updated/);
    assert.deepEqual(requests[0], ['POST', '/api/user-stats/sync']);
  }
});

test('user PATCH validates stats and enforces moderator field locks before saving manual flags', async () => {
  const start = bot.indexOf('    const userMatch = pathname.match(');
  const end = bot.indexOf('    // GET /api/status', start);
  for (const scenario of ['locked', 'allowed', 'invalid', 'clear']) {
    let written, output;
    const keys = [];
    const data = scenario === 'invalid' ? { collectionLogCount: 1.2 }
      : scenario === 'clear' ? { collectionLogCount: null } : { collectionLogCount: 650 };
    const context = vm.createContext({
      pathname: '/api/users/123', req: { method: 'PATCH' }, res: {}, authUser: { role: 'moderator' },
      readBody: async () => data, STAT_FIELDS: ['totalLevel', 'combatAchievementTier', 'collectionLogCount'],
      manualStatUpdates, valuesDiffer: (a, b) => a !== b,
      User: {
        findOne: async () => ({ userId: '123', collectionLogCount: 600 }),
        findOneAndUpdate: async (query, update) => { written = update.$set; return written; },
      },
      dashboardEditBlocked: async (auth, res, input) => {
        keys.push(...input); return scenario === 'locked';
      },
      sendJson: (res, status, body) => { output = { status, body }; },
    });
    await vm.runInContext(`(async () => { ${bot.slice(start, end)} })()`, context);
    if (scenario === 'locked') {
      assert.equal(written, undefined);
      assert.deepEqual(keys, ['user.123.collectionLogCount']);
    } else if (scenario === 'invalid') {
      assert.equal(output.status, 400);
      assert.equal(written, undefined);
    } else {
      assert.equal(output.status, 200);
      assert.equal(written.collectionLogCount, scenario === 'clear' ? null : 650);
      assert.equal(written['statsManual.collectionLogCount'], scenario !== 'clear');
      assert.deepEqual(keys, ['user.123.collectionLogCount']);
    }
  }
});
