const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createUserStatsService, STAT_FIELDS } = require('./user-stats');

const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const bot = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
const member = () => ({ userId: '123', rsName: 'Example', rsNames: ['Example'],
  totalLevel: 1900, collectionLogCount: 500, combatAchievementPoints: 40 });
const profile = { username: 'Example', skills: { totalLevel: 2100 },
  collectionLog: { obtained: 700 }, combatAchievements: [
    'Easy', 'Medium', 'Hard', 'Elite', 'Master', 'Grandmaster',
  ].map(name => ({ name, completed: 10, total: 10 })) };

function fixture({ user = member(), womStatus = 200, profileStatus = 200,
  response = profile, beforeProfile, beforeWrite, retryAfter, womPlayer } = {}) {
  let clock = 0, clanReads = 0;
  const urls = [], writes = [], waits = [], locks = {};
  const service = createUserStatsService({
    User: {
      find: () => { clanReads++; throw new Error('A member refresh must not read the clan'); },
      findOne: ({ userId }) => ({ lean: async () =>
        user?.userId === userId ? structuredClone(user) : null }),
      updateOne: async (query, update) => {
        if (beforeWrite) await beforeWrite(user, query);
        writes.push({ query, update });
        const field = Object.keys(update.$set)[0];
        const matched = user && query.rsName === (user.rsName ?? null) &&
          JSON.stringify(query.rsNames) === JSON.stringify(user.rsNames ?? null) &&
          !user.statsManual?.[field];
        if (matched) Object.assign(user, update.$set);
        return { matchedCount: matched ? 1 : 0 };
      },
    },
    getSettings: async () => { throw new Error('No clan settings needed'); },
    getLocks: async () => locks, now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms; },
    fetchImpl: async url => {
      urls.push(url);
      const wom = url.includes('wiseoldman');
      if (!wom && beforeProfile) await beforeProfile({ user, locks });
      const status = wom ? womStatus : profileStatus;
      return { ok: status === 200, status, headers: { get: () => retryAfter ?? null },
        json: async () => wom ? (womPlayer || { username: 'Example',
          latestSnapshot: { data: { skills: { overall: { level: 2200 } },
            activities: { collections_logged: { score: 0 } } } } }) : response };
    },
  });
  async function finish() {
    for (let i = 0; i < 100 && service.memberStatus('123')?.status === 'running'; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const result = service.memberStatus('123');
    assert.notEqual(result?.status, 'running');
    return result;
  }
  return { service, user, urls, writes, waits, locks, finish, clanReads: () => clanReads };
}

test('member refresh reads only that member and its providers, preserves WOM preference including zero', async () => {
  const f = fixture();
  const started = await f.service.startMember('123');
  assert.equal(started.scope, 'member');
  assert.equal(started.userId, '123');
  const result = await f.finish();
  assert.equal(result.total, 1);
  assert.equal(result.updated, 1);
  assert.equal(f.clanReads(), 0);
  assert.deepEqual(f.urls, ['https://api.wiseoldman.net/v2/players/Example',
    'https://api.runeprofile.com/v1/accounts/Example']);
  assert.equal(f.user.totalLevel, 2200);
  assert.equal(f.user.collectionLogCount, 0);
  assert.equal(f.user.combatAchievementPoints, 210);
  assert.ok(f.writes.every(write => write.query.userId === '123'));
});

test('missing member and RSN fail explicitly and release the shared slot', async () => {
  for (const [user, code] of [[null, 404], [{ userId: '123' }, 400]]) {
    const f = fixture({ user });
    await assert.rejects(f.service.startMember('123'), e => e.statusCode === code);
    await assert.rejects(f.service.startMember('123'), e => e.statusCode === code);
    assert.equal(f.urls.length, 0);
  }
});

test('RSN fallback, normalization and provider encoding work for a single account', async () => {
  const f = fixture({ user: { userId: '123', rsNames: ['First', 'An Example'] },
    womPlayer: { username: 'an_example', latestSnapshot: { data: {} } },
    response: { username: 'AN EXAMPLE', skills: { totalLevel: 2000 } } });
  await f.service.startMember('123');
  await f.finish();
  assert.ok(f.urls.every(url => url.endsWith('An%20Example')));
  assert.equal(f.user.totalLevel, 2000);
});

test('member refresh shares single-flight and provider pacing with every stats job', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ beforeProfile: () => held });
  const pending = f.service.startMember('123');
  await assert.rejects(f.service.startMember('123'), e => e.statusCode === 409);
  await assert.rejects(f.service.startMember('456'), e => e.statusCode === 409);
  await pending;
  assert.equal(f.service.start().scope, 'member'); // no clan job launched
  release();
  await f.finish();
  await f.service.startMember('123');
  await f.finish();
  assert.deepEqual(f.waits, [2100]);
  assert.equal(f.clanReads(), 0);
  const last = f.service.memberStatus('123');
  f.service.start(); // failed clan job does not overwrite retained member result
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.service.memberStatus('123'), last);
});

test('a running clan job prevents a member refresh from starting', async () => {
  let release;
  const service = createUserStatsService({
    User: { find: () => ({ lean: () => new Promise(resolve => { release = resolve; }) }) },
    getSettings: async () => ({}), getLocks: async () => ({}),
  });
  service.start();
  await assert.rejects(service.startMember('123'), e => e.statusCode === 409);
  release([]);
  await new Promise(resolve => setImmediate(resolve));
});

test('manual fields and locks, including locks changed during a request, stay protected', async () => {
  const f = fixture({ user: { ...member(), statsManual: { totalLevel: true } },
    beforeProfile: ({ locks }) => { locks['user.123.combatAchievementPoints'] = true; } });
  f.locks['user.123.collectionLogCount'] = true;
  await f.service.startMember('123');
  const result = await f.finish();
  assert.equal(f.user.totalLevel, 1900);
  assert.equal(f.user.collectionLogCount, 500);
  assert.equal(f.user.combatAchievementPoints, 40);
  assert.equal(result.updated, 1); // unlocked CA tier only
  assert.deepEqual(f.writes.map(w => Object.keys(w.update.$set)[0]), ['combatAchievementTier']);
});

test('member refresh skips RuneProfile if remaining fields are manual or locked', async () => {
  const f = fixture({ user: { ...member(), statsManual: {
    combatAchievementTier: true, combatAchievementPoints: true,
  } } });
  await f.service.startMember('123');
  await f.finish();
  assert.equal(f.urls.length, 1);
});

test('concurrent identity changes and manual edits cannot be overwritten', async () => {
  for (const change of [
    user => { user.rsName = 'Other'; },
    user => { user.rsNames = ['Other']; },
    user => { user.statsManual = Object.fromEntries(STAT_FIELDS.map(field => [field, true])); },
  ]) {
    const f = fixture({ beforeWrite: change });
    await f.service.startMember('123');
    assert.equal((await f.finish()).updated, 0);
    assert.equal(f.user.totalLevel, 1900);
    assert.equal(f.user.collectionLogCount, 500);
    assert.equal(f.user.statsSyncedAt, undefined);
  }
});

test('provider failures and invalid or wrong-account responses keep old data and report warnings', async () => {
  for (const profileStatus of [404, 429, 500]) {
    const f = fixture({ womStatus: 500, profileStatus });
    await f.service.startMember('123');
    const result = await f.finish();
    assert.equal(f.writes.length, 0);
    assert.match(result.warnings[0], /WOM:.*500/);
    assert.equal(profileStatus === 404 ? result.missingProfile : result.failed, 1);
    assert.equal(f.user.collectionLogCount, 500);
  }
  for (const response of [{ username: 'Other', skills: { totalLevel: 2277 } }, { username: 'Example' }]) {
    const f = fixture({ womStatus: 404, response });
    await f.service.startMember('123');
    assert.equal((await f.finish()).failed, 1);
    assert.equal(f.writes.length, 0);
  }
  const wrongWom = fixture({ womPlayer: { username: 'Other', latestSnapshot: {} } });
  await wrongWom.service.startMember('123');
  assert.match((await wrongWom.finish()).warnings[0], /different account/);
  assert.equal(wrongWom.user.totalLevel, 2100); // correct RuneProfile fallback
});

test('partial provider failures retain successful WOM results and honor Retry-After on the next job', async () => {
  const f = fixture({ profileStatus: 429, retryAfter: '10' });
  await f.service.startMember('123');
  assert.equal((await f.finish()).failed, 1);
  assert.equal(f.user.totalLevel, 2200);
  assert.equal(f.user.combatAchievementPoints, 40);
  await f.service.startMember('123');
  await f.finish();
  assert.deepEqual(f.waits, [12100]);
});

test('network and database errors finish explicitly, retain partial updates and release the slot', async () => {
  const network = fixture({ beforeProfile: () => { throw new Error('Request timed out'); } });
  await network.service.startMember('123');
  assert.equal((await network.finish()).failed, 1);
  assert.match(network.service.memberStatus('123').warnings[0], /timed out/);
  assert.equal(network.user.totalLevel, 2200);
  const db = fixture({ beforeWrite: () => { throw new Error('Database unavailable'); } });
  await db.service.startMember('123');
  const status = await db.finish();
  assert.equal(status.status, 'failed');
  assert.match(status.error, /Database unavailable/);
  await db.service.startMember('123');
  assert.equal((await db.finish()).status, 'failed');
});

test('lock hydration preserves missing-RSN and in-flight refresh disabling for both staff roles', () => {
  const source = html.slice(html.indexOf('  function hydrateDashboardLockControls('),
    html.indexOf('  async function loadDashboardLocks('));
  for (const role of ['admin', 'mod']) {
    for (const [actionDisabled, locked, expected] of [
      ['true', false, true], ['false', false, false], ['false', true, role !== 'admin'],
    ]) {
      const control = { dataset: { lockActionKey: 'user.123.refreshStats', actionDisabled } };
      const context = vm.createContext({
        currentDashboardUser: { role }, CSS: { escape: value => value },
        root: { querySelectorAll: selector => selector === '[data-lock-action-key]' ? [control] : [] },
        lockIsActive: () => locked, makeDashboardLockButton: () => ({}), setLockButtonState() {},
      });
      vm.runInContext(`${source}; hydrateDashboardLockControls(root)`, context);
      assert.equal(control.disabled, expected);
    }
  }
});

function routeSource() {
  const auth = bot.slice(bot.indexOf("  if (pathname.startsWith('/api/')) {"),
    bot.indexOf("    if (pathname === '/api/auth/set-password'"));
  const route = bot.slice(bot.indexOf('    // Per-member jobs share'),
    bot.indexOf('    // GET /api/users'));
  return `(async () => { ${auth}${route} } })()`;
}

test('refresh route enforces authentication, moderator sessions, setup restrictions and action locks', async () => {
  for (const scenario of ['anonymous', 'setup', 'revoked', 'admin', 'mod', 'locked', 'busy', 'missing', 'db']) {
    let output, starts = 0;
    const context = vm.createContext({
      pathname: '/api/users/123/stats/refresh', req: { method: 'POST' }, res: {},
      checkAuth: () => scenario === 'anonymous' ? null : ({
        role: scenario === 'admin' ? 'admin' : 'mod', sub: 'moderator',
        purpose: scenario === 'setup' ? 'password-setup' : 'session', sessionVersion: 1,
      }),
      DashboardAccount: { findById: () => ({ select: async () => scenario === 'revoked' ? null :
        { username: 'moderator', sessionVersion: 1 } }) },
      dashboardEditBlocked: async (auth, res, keys) => {
        assert.deepEqual(Array.from(keys), ['user.123.refreshStats']);
        if (scenario !== 'locked') return false;
        output = { status: 423 }; return true;
      },
      userStatsService: {
        startMember: async id => {
          assert.equal(id, '123'); starts++;
          if (['busy', 'missing', 'db'].includes(scenario)) {
            throw Object.assign(new Error('Internal detail'), {
              statusCode: { busy: 409, missing: 404 }[scenario],
            });
          }
          return { status: 'running', userId: id };
        },
        start: () => assert.fail('Must not launch a clan sync'),
      },
      sendJson: (res, status, body) => { output = { status, body }; },
    });
    await vm.runInContext(routeSource(), context);
    const expected = { anonymous: 401, setup: 403, revoked: 401, locked: 423,
      busy: 409, missing: 404, db: 500 }[scenario] || 202;
    assert.equal(output.status, expected, scenario);
    assert.equal(starts, [401, 403, 423].includes(expected) ? 0 : 1, scenario);
    if (scenario === 'db') assert.equal(output.body.error, 'Could not refresh member stats.');
  }
});

test('member progress route returns retained status or an explicit missing result without starting work', async () => {
  for (const result of [null, { status: 'complete', userId: '123', updated: 1 }]) {
    let output;
    const source = bot.slice(bot.indexOf('    // Per-member jobs share'),
      bot.indexOf('    // GET /api/users'));
    const context = vm.createContext({
      pathname: '/api/users/123/stats/refresh', req: { method: 'GET' }, res: {},
      userStatsService: { memberStatus: id => { assert.equal(id, '123'); return result; } },
      sendJson: (res, status, body) => { output = { status, body }; },
    });
    await vm.runInContext(`(async () => { ${source} })()`, context);
    assert.equal(output.status, result ? 200 : 404);
  }
});

test('member refresh UI calls only the member endpoint, reports results, reloads and restores controls', async () => {
  assert.match(html, /data-lock-action-key="user\.\$\{escAttr\(u\.userId\)\}\.refreshStats"/);
  for (const outcome of ['success', 'partial', 'denied', 'failed', 'network']) {
    const calls = [], toasts = [], reloads = [];
    const status = { textContent: '' }, button = { textContent: 'Refresh stats', disabled: false, dataset: {} };
    const context = vm.createContext({
      Set, encodeURIComponent, document: { getElementById: () => status }, button,
      setTimeout: resolve => resolve(), currentPage: 2,
      hydrateDashboardLockControls: () => {},
      loadUsers: async page => reloads.push(page),
      showToast: (...args) => toasts.push(args),
      api: async (method, url) => {
        calls.push([method, url]);
        if (outcome === 'network') throw new Error('Network unavailable');
        return { ok: outcome !== 'denied', json: async () => outcome === 'denied'
          ? { error: 'Locked by admin' } : method === 'POST' ? { status: 'running' }
            : { status: outcome === 'failed' ? 'failed' : 'complete',
              error: 'Database unavailable', updated: 1, missingProfile: 0,
              failed: outcome === 'partial' ? 1 : 0, warnings: [] } };
      },
    });
    const source = html.slice(html.indexOf('  const memberStatsRefreshing ='),
      html.indexOf('  let userStatsPolling ='));
    await vm.runInContext(`${source}; refreshMemberStats('123', button)`, context);
    assert.ok(calls.every(([, url]) => url === '/api/users/123/stats/refresh'));
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Refresh stats');
    assert.deepEqual(reloads, ['denied', 'network'].includes(outcome) ? [] : [2]);
    assert.equal(toasts.at(-1)[1], outcome !== 'success');
    if (outcome === 'partial') assert.match(status.textContent, /1 provider errors/);
  }
});
