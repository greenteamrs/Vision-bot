const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { findPendingRankUps, formatPendingRankUps } = require('./rank-audit');
const { createRankMemberScope } = require('./rank-members');

test('/checkranks reports every eligible Visionaries member across Discord-sized messages', async () => {
  const users = Array.from({ length: 75 }, (_, i) => ({
    userId: String(i), username: `EligiblePlayer${i}`, rsName: `Player ${i}`,
    womRank: 'Recruit', days: 40, level: 10, lootPoints: 1000, notifiedRankId: 'raider',
  }));
  users.push({ ...users[0], userId: 'outsider', username: 'NotVisionaries' });
  users.push({ ...users[0], userId: 'promoted', username: 'AlreadyPromoted', womRank: 'Raider' });
  const members = users.map(user => ({
    id: user.userId, user: { bot: false },
    roles: { cache: [{ name: user.userId === 'outsider' ? 'Guest' : 'Visionaries' }] },
  }));
  const guild = {
    id: 'guild',
    roles: { fetch: async () => [{ name: 'Visionaries' }] },
    members: { fetch: async () => new Map(members.map(member => [member.id, member])) },
  };
  const scope = createRankMemberScope({
    User: { find: async query => users.filter(user => query.userId.$in.includes(user.userId)) },
  });
  const ranks = [
    { name: 'Recruit', order: 1, minDays: 0, minLevel: 0, minLootPoints: 0 },
    { name: 'Raider', order: 2, minDays: 10, minLevel: 2, minLootPoints: 100, notifyOnEligibility: true },
    { name: 'SelectedOnly', order: 3, minDays: 0, minLevel: 0, minLootPoints: 0, notifyOnEligibility: false },
  ];
  const messages = [];
  const interaction = {
    guild,
    editReply: async text => messages.push(text),
    followUp: async text => messages.push(text),
  };
  const source = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
  const replyHelper = source.slice(
    source.indexOf('async function replyLongInteraction('),
    source.indexOf('function getRecipientUsers('),
  );
  const command = source.slice(
    source.indexOf("    if (commandName === 'checkranks')"),
    source.indexOf("    if (commandName === 'help')"),
  );
  const context = vm.createContext({
    interaction, member: {}, commandName: 'checkranks',
    isAdmin: () => true, isMod: () => false,
    formatPendingRankUps,
    getRankAudit: async selectedGuild => ({
      pendingRankUps: findPendingRankUps({
        ranks, users: await scope(selectedGuild), daysInClan: user => user.days,
      }),
      unknownRanks: [],
    }),
  });
  vm.runInContext(`${replyHelper}\nasync function runCommand() { ${command} }`, context);
  await vm.runInContext('runCommand()', context);
  assert.ok(messages.length > 1);
  assert.ok(messages.every(message => message.length <= 1900));
  const text = messages.join('\n');
  assert.match(text, /Found 75 outstanding rank-ups/);
  for (let i = 0; i < 75; i++) {
    assert.ok(text.includes(`Player ${i} / EligiblePlayer${i} / LP: 1000 / Community: 10 / Droptracker: ❌ / Recruit → Raider`));
  }
  assert.doesNotMatch(text, /SelectedOnly|NotVisionaries|AlreadyPromoted|Open the dashboard/);
});
