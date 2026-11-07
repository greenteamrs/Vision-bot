const ONLYMODS_CHANNEL_ID = '864145511166771211';

function hasVisionariesRole(member) {
  return Boolean(member && !member.user?.bot && member.roles.cache.some(
    role => role.name.trim().toLowerCase() === 'visionaries',
  ));
}

function hasKnownRsn(user) {
  return Boolean(user && [user.rsName, ...(user.rsNames || [])].some(
    name => typeof name === 'string' && name.trim().length > 0,
  ));
}

// Serialize checks per guild so simultaneous manual/background checks cannot
// send duplicate missing-RSN alerts. Persist successful alerts across restarts.
function createRankMemberScope({ User, MissingRsnAlert }) {
  const inFlight = new Map();

  async function load(guild) {
    const roles = await guild.roles.fetch();
    if (!roles.some(role => role.name.trim().toLowerCase() === 'visionaries')) {
      throw new Error('Visionaries role not found. Rank checks were not run.');
    }
    const members = [...(await guild.members.fetch()).values()].filter(hasVisionariesRole);
    const users = await User.find({ userId: { $in: members.map(member => member.id) } });
    const byId = new Map(users.map(user => [user.userId, user]));
    const missing = members.filter(member => !hasKnownRsn(byId.get(member.id)));
    const missingIds = missing.map(member => member.id);

    await MissingRsnAlert.deleteMany({ guildId: guild.id, userId: { $nin: missingIds } });
    const alerted = await MissingRsnAlert.find({ guildId: guild.id });
    const alertedIds = new Set(alerted.map(alert => alert.userId));
    const unreported = missing.filter(member => !alertedIds.has(member.id));
    if (unreported.length) {
      const channel = await guild.channels.fetch(ONLYMODS_CHANNEL_ID);
      if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
        throw new Error(`Cannot send missing-RSN alerts: OnlyMods channel ${ONLYMODS_CHANNEL_ID} is unavailable or not text-based.`);
      }
      for (const member of unreported) {
        await channel.send({
          content: `⚠️ <@${member.id}> has the **Visionaries** role but no known RuneScape name in our database. Please link their RSN using \`/rsset\`. They are excluded from rank-up checks until an RSN is linked.`,
          allowedMentions: { parse: [] },
        });
        await MissingRsnAlert.updateOne(
          { guildId: guild.id, userId: member.id },
          { $set: { sentAt: new Date() } },
          { upsert: true },
        );
      }
    }
    return users.filter(hasKnownRsn);
  }

  return function getRankCheckUsers(guild) {
    if (!guild) return Promise.reject(new Error('Discord server unavailable. Rank checks were not run.'));
    if (!inFlight.has(guild.id)) {
      const pending = load(guild).finally(() => inFlight.delete(guild.id));
      inFlight.set(guild.id, pending);
    }
    return inFlight.get(guild.id);
  };
}

module.exports = { hasVisionariesRole, hasKnownRsn, createRankMemberScope };
