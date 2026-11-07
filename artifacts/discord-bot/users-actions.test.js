const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

function fixture(response = {}) {
  const nodes = {
    'user-rank-check-results': { style: {}, innerHTML: '' },
    'rank-check-results': { style: {}, innerHTML: 'Unchanged ranks tab' },
    'btn-wom-sync': { textContent: 'Sync WOM', disabled: false },
    'btn-dt-sync': { textContent: 'Sync Members', disabled: false },
    'btn-check-ranks': { textContent: 'Check Now', disabled: false },
  };
  const calls = [], refreshes = [], toasts = [];
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] },
    api: async (method, url) => {
      calls.push([method, url]);
      return { ok: response.ok !== false, json: async () => response };
    },
    loadUsers: async page => refreshes.push(page),
    currentPage: 3,
    showToast: (...args) => toasts.push(args),
    esc: value => String(value),
  });
  for (const [start, end] of [
    ['  async function syncWomDashboard(', '  // ---- DROPTRACKER ----'],
    ['  async function syncDtDashboard(', '  // ===================== BINGO'],
    ['  async function checkRankUpsNow(', '  // ---- EVENTS ----'],
  ]) {
    vm.runInContext(html.slice(html.indexOf(start), html.indexOf(end)), context);
  }
  return { nodes, calls, refreshes, toasts, context };
}

test('Users tab contains all three shared actions and its own rank-results area', () => {
  const section = html.slice(html.indexOf('id="section-users"'), html.indexOf('</main>'));
  for (const handler of ['syncDtDashboard(this)', 'syncWomDashboard(this)', "checkRankUpsNow(this, 'user-rank-check-results')"]) {
    assert.ok(section.includes(handler));
  }
});

test('both Users sync buttons call the existing endpoints and refresh the current page', async () => {
  for (const [handler, endpoint] of [
    ['syncWomDashboard', '/api/wom/sync'], ['syncDtDashboard', '/api/droptracker/sync'],
  ]) {
    const { context, calls, refreshes } = fixture({ updated: 1, total: 2 });
    context.button = { textContent: 'Users sync button', disabled: false };
    await vm.runInContext(`${handler}(button)`, context);
    assert.deepEqual(calls, [['POST', endpoint]]);
    assert.deepEqual(refreshes, [3]);
    assert.equal(context.button.textContent, 'Users sync button');
    assert.equal(context.button.disabled, false);
  }
});

test('Users rank check displays promotions and unknown originals without altering the Ranks tab', async () => {
  const { context, nodes, calls } = fixture({
    pendingRankUps: [{ username: 'TestMember', currentRank: 'Leader', rankName: 'Knight' }],
    unknownRanks: [{ username: 'MissingHistory', rsName: 'Other RSN', temporaryRank: 'Season Winner' }],
  });
  context.button = { textContent: 'Check Ranks', disabled: false };
  await vm.runInContext("checkRankUpsNow(button, 'user-rank-check-results')", context);
  assert.deepEqual(calls, [['POST', '/api/ranks/check']]);
  assert.match(nodes['user-rank-check-results'].innerHTML, /TestMember.*Leader.*Knight/);
  assert.match(nodes['user-rank-check-results'].innerHTML, /Original rank unknown.*MissingHistory/);
  assert.equal(nodes['user-rank-check-results'].style.display, 'block');
  assert.equal(nodes['rank-check-results'].innerHTML, 'Unchanged ranks tab');
  assert.equal(context.button.textContent, 'Check Ranks');
  assert.equal(context.button.disabled, false);
});

test('failed syncs show errors, skip refreshing users, and restore their buttons', async () => {
  for (const handler of ['syncWomDashboard', 'syncDtDashboard']) {
    const { context, toasts, refreshes } = fixture({ ok: false, error: 'Service unavailable' });
    context.button = { textContent: 'Sync', disabled: false };
    await vm.runInContext(`${handler}(button)`, context);
    assert.ok(toasts.some(([message, isError]) => message === 'Service unavailable' && isError));
    assert.deepEqual(refreshes, []);
    assert.equal(context.button.textContent, 'Sync');
    assert.equal(context.button.disabled, false);
  }
});

test('existing Ranks and Droptracker buttons still work without arguments', async () => {
  const { context, refreshes, nodes } = fixture({ updated: 1, total: 2, pendingRankUps: [] });
  await vm.runInContext('syncWomDashboard();', context);
  await vm.runInContext('syncDtDashboard();', context);
  await vm.runInContext('checkRankUpsNow();', context);
  assert.deepEqual(refreshes, [3, 3]);
  assert.equal(nodes['btn-dt-sync'].textContent, 'Sync Members');
  assert.equal(nodes['btn-check-ranks'].textContent, 'Check Now');
  assert.match(nodes['rank-check-results'].innerHTML, /No outstanding rank-ups/);
});
