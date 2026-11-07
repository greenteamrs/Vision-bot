function normalizeRankName(name) {
  return String(name || '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function lookupRank(ranks, name) {
  const normalized = normalizeRankName(name);
  return normalized ? ranks.find(rank => normalizeRankName(rank.name) === normalized) : undefined;
}

// Called before overwriting the last observed WOM rank. Seasonal-to-seasonal
// changes must never replace the saved permanent rank.
function womRankUpdates(user, incomingName, ranks) {
  const name = String(incomingName || '').trim();
  if (!name) return {};
  const updates = {};
  if (user.womRank !== name) updates.womRank = name;
  if (lookupRank(ranks, name)?.isTemporary === true) {
    const previous = String(user.womRank || '').trim();
    if (previous && normalizeRankName(previous) !== normalizeRankName(name) &&
        lookupRank(ranks, previous)?.isTemporary !== true &&
        user.permanentRank !== previous) {
      updates.permanentRank = previous;
    }
  } else if (user.permanentRank !== name) {
    updates.permanentRank = name;
  }
  return updates;
}

function resolvePermanentRank(user, ranks) {
  const womName = String(user.womRank || '').trim();
  const womRank = lookupRank(ranks, user.womRank);
  if (womName && womRank?.isTemporary !== true) {
    return { rank: womRank, name: womName, unknown: false };
  }
  const roleNames = new Set((user.discordRankNames || []).map(normalizeRankName));
  const roleRanks = ranks.filter(rank =>
    rank.isTemporary !== true && roleNames.has(normalizeRankName(rank.name)),
  );
  const roleRank = roleRanks.sort((a, b) => Number(b.order || 0) - Number(a.order || 0))[0];
  const saved = lookupRank(ranks, user.permanentRank);
  const rank = roleRank || (saved?.isTemporary !== true ? saved : undefined);
  const savedName = saved?.isTemporary === true ? '' : String(user.permanentRank || '').trim();
  return {
    rank,
    name: rank?.name || savedName,
    // Seasonal members still need a configured permanent tier. For members
    // without a WOM rank, preserve the existing missing-rank audit behavior.
    unknown: womRank?.isTemporary === true && !rank,
  };
}

function unknownPermanentRanks(ranks, users) {
  return users.filter(user => resolvePermanentRank(user, ranks).unknown).map(user => ({
    userId: user.userId,
    username: user.discordName || user.username || user.userId,
    rsName: user.rsName || (user.rsNames || []).at(-1) || '',
    temporaryRank: user.womRank,
  }));
}

module.exports = { normalizeRankName, womRankUpdates, resolvePermanentRank, unknownPermanentRanks };
