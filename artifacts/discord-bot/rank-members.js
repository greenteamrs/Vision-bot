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

// Share concurrent Discord lookups; rank checks never send missing-RSN messages.
function createRankMemberScope({ User }) {
  const inFlight = new Map();

  async function load(guild) {
    const roles = await guild.roles.fetch();
    if (!roles.some(role => role.name.trim().toLowerCase() === 'visionaries')) {
      throw new Error('Visionaries role not found. Rank checks were not run.');
    }
    const members = [...(await guild.members.fetch()).values()].filter(hasVisionariesRole);
    const users = await User.find({ userId: { $in: members.map(member => member.id) } });
    const byId = new Map(members.map(member => [member.id, member]));
    return users.filter(hasKnownRsn).map(user => {
      const member = byId.get(user.userId);
      return {
        ...(typeof user.toObject === 'function' ? user.toObject() : user),
        discordName: member.user?.username || member.displayName || user.username,
        discordRankNames: member.roles.cache.map(role => role.name),
      };
    });
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
