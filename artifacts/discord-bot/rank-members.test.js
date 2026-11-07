const test = require('node:test');
const assert = require('node:assert/strict');
const { createRankMemberScope, hasKnownRsn } = require('./rank-members');

function member(id, role = 'Visionaries', bot = false) {
  return { id, user: { bot }, roles: { cache: [{ name: role }] } };
}

function fixture() {
  const state = {
    members: [member('linked'), member('missing'), member('outsider', 'Guest'), member('bot', 'Visionaries', true)],
    users: [{ userId: 'linked', rsNames: ['Known RSN'] }, { userId: 'outsider', rsName: 'Guest RSN' }],
    alerts: new Map(),
    messages: [],
    channelAvailable: true,
    sendFails: false,
  };
  const guild = {
    id: 'guild',
    roles: { fetch: async () => [{ name: 'Visionaries' }] },
    members: { fetch: async () => new Map(state.members.map(item => [item.id, item])) },
    channels: { fetch: async id => {
      assert.equal(id, '864145511166771211');
      return state.channelAvailable ? {
      name: 'renamed-mod-channel', isTextBased: () => true,
      send: async message => {
        if (state.sendFails) throw new Error('Missing channel permission');
        state.messages.push(message);
      },
      } : null;
    } },
  };
  const dependencies = {
    User: { find: async query => state.users.filter(user => query.userId.$in.includes(user.userId)) },
    MissingRsnAlert: {
      deleteMany: async query => {
        for (const id of state.alerts.keys()) {
          if (!query.userId.$nin.includes(id)) state.alerts.delete(id);
        }
      },
      find: async () => [...state.alerts.values()],
      updateOne: async query => state.alerts.set(query.userId, { userId: query.userId }),
    },
  };
  return { state, guild, dependencies, check: createRankMemberScope(dependencies) };
}

test('rank scope checks only current Visionaries with a known RSN without sending messages', async () => {
  const { check, guild, state } = fixture();
  const users = await check(guild);
  assert.deepEqual(users.map(user => user.userId), ['linked']);
  assert.equal(state.messages.length, 0);
});

test('missing RSNs include blank values but accept either stored RSN field', () => {
  assert.equal(hasKnownRsn({ rsName: ' ', rsNames: ['', ' '] }), false);
  assert.equal(hasKnownRsn({ rsName: 'Primary' }), true);
  assert.equal(hasKnownRsn({ rsNames: ['Alternate'] }), true);
  assert.equal(hasKnownRsn(undefined), false);
});

test('concurrent checks and service restarts never send missing-RSN messages', async () => {
  const { check, guild, state, dependencies } = fixture();
  await Promise.all([check(guild), check(guild)]);
  await createRankMemberScope(dependencies)(guild);
  assert.equal(state.messages.length, 0);
});

test('linking an RSN enables checking and unlinking excludes the member again', async () => {
  const { check, guild, state } = fixture();
  await check(guild);
  state.users.push({ userId: 'missing', rsName: 'Now Linked' });
  assert.equal((await check(guild)).length, 2);
  assert.equal(state.alerts.has('missing'), false);
  state.users[2].rsName = '';
  await check(guild);
  assert.equal((await check(guild)).length, 1);
  assert.equal(state.messages.length, 0);
});

test('removing the Visionaries role excludes the member', async () => {
  const { check, guild, state } = fixture();
  await check(guild);
  state.members = [member('linked', 'Guest'), member('missing', 'Guest')];
  assert.deepEqual(await check(guild), []);
  assert.equal(state.alerts.size, 0);
});

test('rank checks do not depend on OnlyMods channel access', async () => {
  const { check, guild, state } = fixture();
  state.sendFails = true;
  state.channelAvailable = false;
  assert.equal((await check(guild)).length, 1);
  assert.equal(state.messages.length, 0);
});

test('missing server, role or unavailable members fail explicitly', async () => {
  const { check, guild, state } = fixture();
  await assert.rejects(check(null), /server unavailable/);
  guild.roles.fetch = async () => [];
  await assert.rejects(check(guild), /Visionaries role not found/);
  guild.roles.fetch = async () => [{ name: 'Visionaries' }];
  guild.members.fetch = async () => { throw new Error('Member lookup failed'); };
  await assert.rejects(check(guild), /Member lookup failed/);
});
