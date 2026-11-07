const { normalizeRankName, resolvePermanentRank } = require('./rank-history');

const rankKey = name => normalizeRankName(name).replace(/[^a-z0-9]/g, '');
const EXTRA_REQUIREMENTS = {
  maxed: { field: 'totalLevel', minimum: 2376, label: 'Total level ≥ 2376' },
  tzkal: { field: 'combatAchievementPoints', minimum: 1965, label: 'Combat Achievement points ≥ 1965' },
  collector: { field: 'collectionLogCount', minimum: 900, label: 'Collection log count ≥ 900' },
};

function hasFixedImpRank(user, ranks) {
  const womKey = rankKey(user.womRank);
  const seasonal = ranks.some(rank => rankKey(rank.name) === womKey && rank.isTemporary === true);
  return rankKey(user.womRank) === 'imp' ||
    (user.discordRankNames || []).some(name => rankKey(name) === 'imp') ||
    ((!womKey || seasonal) && rankKey(user.permanentRank) === 'imp') ||
    rankKey(resolvePermanentRank(user, ranks).name) === 'imp';
}

function requiresDroptracker(rank, ranks) {
  const leader = ranks.find(item => rankKey(item.name) === 'leader');
  if (leader) return Number(rank.order || 0) > Number(leader.order || 0);
  // Missing hierarchy information must not allow a promotion without setup.
  return !['gnomechild', 'leader'].includes(rankKey(rank.name));
}

function automaticRequirements(rank, ranks) {
  if (rankKey(rank.name) === 'imp') return ['Fixed rank — no automatic rank-ups'];
  const labels = [];
  if (requiresDroptracker(rank, ranks)) labels.push('DropTracker setup confirmed');
  const extra = EXTRA_REQUIREMENTS[rankKey(rank.name)];
  if (extra) labels.push(extra.label);
  return labels;
}

function meetsRankRequirements(rank, user, days, ranks) {
  if (rank.notifyOnEligibility === false || rank.isTemporary === true || rankKey(rank.name) === 'imp') return false;
  if (!(days >= Number(rank.minDays || 0) &&
      Number(user.lootPoints || 0) >= Number(rank.minLootPoints || 0) &&
      Number(user.level || 0) >= Number(rank.minLevel || 0))) return false;
  if (requiresDroptracker(rank, ranks) && user.droptrackerSetup !== true) return false;
  const extra = EXTRA_REQUIREMENTS[rankKey(rank.name)];
  if (extra) {
    const value = user[extra.field];
    if (!Number.isFinite(value) || value < extra.minimum) return false;
  }
  return true;
}

module.exports = { hasFixedImpRank, requiresDroptracker, automaticRequirements, meetsRankRequirements };
