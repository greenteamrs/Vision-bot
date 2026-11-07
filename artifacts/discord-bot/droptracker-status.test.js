const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
const syncCode = source.slice(
  source.indexOf('async function syncDroptrackerMembers()'),
  source.indexOf('async function getDroptrackerTopPlayers('),
);

function fixture(result) {
  const writes = [];
  const lookups = [];
  const context = vm.createContext({
    dtFetch: async () => result,
    escapeRegex: value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    User: {
      findOne: async query => {
        lookups.push(query);
        if (query.userId === '123') return { _id: 'db1', userId: '123', rsName: 'Known' };
        if (query.$or?.[0].rsName.$regex.test('By Name')) return { _id: 'db2', userId: '456' };
        return null;
      },
      updateOne: async () => {},
      updateMany: async (query, update) => writes.push(JSON.parse(JSON.stringify({ query, update }))),
    },
  });
  vm.runInContext(syncCode, context);
  return { run: () => vm.runInContext('syncDroptrackerMembers()', context), writes, lookups };
}

test('DropTracker confirms members matched by Discord user ID or stored RSN', async () => {
  const { run, writes, lookups } = fixture({ data: [
    { player_name: 'Known', discord_id: '123' },
    { player_name: 'By Name' },
  ] });
  await run();
  assert.equal(lookups[0].userId, '123');
  assert.deepEqual(writes[0], {
    query: { userId: { $in: ['123', '456'] } }, update: { $set: { droptrackerSetup: true } },
  });
  assert.deepEqual(writes[1], {
    query: { userId: { $nin: ['123', '456'] } }, update: { $set: { droptrackerSetup: false } },
  });
});

test('failed or malformed DropTracker sync preserves existing confirmation status', async () => {
  for (const response of [{ error: 'Unavailable' }, { data: {} }, { data: null }]) {
    const { run, writes } = fixture(response);
    assert.ok((await run()).error);
    assert.equal(writes.length, 0);
  }
});

test('successful empty export clears outdated confirmations', async () => {
  const { run, writes } = fixture({ data: { members: [] } });
  await run();
  assert.deepEqual(writes[1].query, { userId: { $nin: [] } });
  assert.equal(writes[1].update.$set.droptrackerSetup, false);
});

test('Users table displays WOM rank, confirmation icons and missing-RSN text', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  const nodes = {
    'user-search': { value: '' },
    'users-table-body': { innerHTML: '' },
  };
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] },
    api: async () => ({ ok: true, json: async () => ({
      users: [
        { userId: '1', womRank: 'Veteran', droptrackerSetup: true },
        { userId: '2', droptrackerSetup: false },
      ], pages: 1,
    }) }),
    updateSortArrows() {}, renderPagination() {},
    esc: value => String(value), escAttr: value => String(value),
    userSort: 'level', userSortDir: 'desc',
  });
  vm.runInContext(html.slice(html.indexOf('  async function loadUsers('), html.indexOf('  function renderPagination(')), context);
  await vm.runInContext('loadUsers(1)', context);
  assert.match(nodes['users-table-body'].innerHTML, /Veteran/);
  assert.match(nodes['users-table-body'].innerHTML, /Unknown/);
  assert.match(nodes['users-table-body'].innerHTML, /✓/);
  assert.match(nodes['users-table-body'].innerHTML, /✕/);
  assert.match(nodes['users-table-body'].innerHTML, /Missing RSN/);
});
