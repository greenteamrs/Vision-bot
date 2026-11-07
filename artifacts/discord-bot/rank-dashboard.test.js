const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

function fixture() {
  const nodes = new Map();
  const requests = [];
  const context = vm.createContext({
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {
        value: '', checked: false, dataset: {}, classList: { add() {}, remove() {} },
      });
      return nodes.get(id);
    } },
    hydrateDashboardLockControls() {},
    closeRankModal() {}, loadRanks() {}, showToast() {},
    api: async (...args) => { requests.push(args); return { ok: true }; },
  });
  vm.runInContext(html.slice(
    html.indexOf('  function openRankModal('),
    html.indexOf('  function closeRankModal('),
  ), context);
  vm.runInContext(html.slice(
    html.indexOf('  async function saveRank('),
    html.indexOf('  async function deleteRank('),
  ), context);
  return { context, nodes, requests };
}

test('temporary-rank modal initializes, resets, and wires the correct field lock', () => {
  const { context, nodes } = fixture();
  vm.runInContext("openRankModal({_id:'season',name:'Season Winner',isTemporary:true})", context);
  assert.equal(nodes.get('rank-temporary').checked, true);
  assert.equal(nodes.get('rank-temporary').dataset.lockKey, 'rank.season.isTemporary');
  vm.runInContext('openRankModal()', context);
  assert.equal(nodes.get('rank-temporary').checked, false);
  assert.equal(nodes.get('rank-temporary').dataset.lockKey, 'rank.create.isTemporary');
});

test('creating and editing ranks sends the temporary boolean including false', async () => {
  const { context, nodes, requests } = fixture();
  vm.runInContext('openRankModal()', context);
  nodes.get('rank-name').value = 'Season Winner';
  nodes.get('rank-temporary').checked = true;
  await vm.runInContext('saveRank()', context);
  assert.equal(requests[0][0], 'POST');
  assert.equal(requests[0][2].isTemporary, true);
  vm.runInContext("openRankModal({_id:'season',name:'Season Winner',isTemporary:true})", context);
  nodes.get('rank-temporary').checked = false;
  await vm.runInContext('saveRank()', context);
  assert.equal(requests[1][0], 'PATCH');
  assert.equal(requests[1][1], '/api/ranks/season');
  assert.equal(requests[1][2].isTemporary, false);
});

test('all dashboard sections can fill available width and rank tables can scroll', () => {
  assert.doesNotMatch(html, /main\s*\{[^}]*max-width:\s*900px/);
  assert.match(html, /\.section\s*\{[^}]*width:\s*100%/);
  assert.match(html, /overflow-x:auto[^>]+id="ranks-table-wrap"/);
});
