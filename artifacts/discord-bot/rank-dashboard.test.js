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
    currentRanks: [],
    closeRankModal() {}, loadRanks() {}, showToast() {},
    api: async (...args) => { requests.push(args); return { ok: true, json: async () => ({ _id: 'season' }) }; },
  });
  vm.runInContext(html.slice(
    html.indexOf('  async function saveRankPriorities('),
    html.indexOf('  function openRankModal('),
  ), context);
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
  context.currentRanks = [{ _id: 'season', order: 1 }];
  vm.runInContext("openRankModal({_id:'season',name:'Season Winner',isTemporary:true})", context);
  nodes.get('rank-temporary').checked = false;
  await vm.runInContext('saveRank()', context);
  const patch = requests.find(request => request[0] === 'PATCH');
  assert.equal(patch[1], '/api/ranks/season');
  assert.equal(patch[2].isTemporary, false);
});

test('all dashboard sections can fill available width and rank tables can scroll', () => {
  assert.doesNotMatch(html, /main\s*\{[^}]*max-width:\s*900px/);
  assert.match(html, /\.section\s*\{[^}]*width:\s*100%/);
  assert.match(html, /overflow-x:auto[^>]+id="ranks-table-wrap"/);
});

test('ranks render highest first with priority level before the rank name', async () => {
  const { context, nodes } = fixture();
  context.api = async () => ({ json: async () => [
    { _id: 'low', name: 'Recruit', order: 0, minLootPoints: 0 },
    { _id: 'high', name: 'Veteran', order: 20, minLootPoints: 500 },
  ] });
  context.esc = context.escAttr = value => String(value);
  vm.runInContext(html.slice(html.indexOf('  async function loadRanks('), html.indexOf('  async function setRankTemporary(')), context);
  await vm.runInContext('loadRanks()', context);
  const output = nodes.get('ranks-table-body').innerHTML;
  assert.ok(output.indexOf('Veteran') < output.indexOf('Recruit'));
  assert.match(output, />1<\/td>\s*<td[^>]*>Veteran/);
  assert.match(output, />2<\/td>\s*<td[^>]*>Recruit/);
  assert.match(html, /<th>Priority level<\/th>\s*<th>Rank Name<\/th>/);
});

test('editing priority level sends highest-first rank IDs and validates positive whole numbers', async () => {
  const { context, nodes, requests } = fixture();
  context.currentRanks = [
    { _id: 'high', name: 'Veteran', order: 20 },
    { _id: 'low', name: 'Recruit', order: 0 },
  ];
  vm.runInContext("openRankModal(currentRanks[0])", context);
  assert.equal(nodes.get('rank-priority').value, 1);
  context.api = async (...args) => {
    requests.push(args);
    return { ok: true, json: async () => ({ _id: 'high' }) };
  };
  nodes.get('rank-priority').value = '0';
  await vm.runInContext('saveRank()', context);
  assert.equal(requests.length, 0);
  nodes.get('rank-priority').value = '2';
  await vm.runInContext('saveRank()', context);
  const reorder = requests.find(request => request[1] === '/api/ranks/priorities');
  assert.deepEqual(Array.from(reorder[2].rankIds), ['low', 'high']);
});
