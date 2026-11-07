// The dashboard numbers priorities top-down (1 = highest). Keep the existing
// internal hierarchy convention (larger order = higher) used by rank checks.
function buildPriorityUpdates(ranks, priorities) {
  const byId = new Map(ranks.map(rank => [String(rank._id), rank]));
  if (!Array.isArray(priorities) || priorities.length !== ranks.length ||
      priorities.some(item => !item || !byId.has(item.id)) ||
      new Set(priorities.map(item => item.id)).size !== ranks.length) {
    throw new Error('The rank list changed. Refresh the ranks and try again.');
  }
  if (priorities.some(item => !Number.isSafeInteger(item.priorityLevel) || item.priorityLevel < 1)) {
    throw new Error('Priority level must be a positive whole number. Ranks may share the same priority.');
  }
  return priorities.flatMap(({ id, priorityLevel }) => {
    const order = -priorityLevel;
    return Number(byId.get(id).order) === order ? [] : [{ id, order }];
  });
}

function withPriorityLevels(ranks) {
  // Older records used arbitrary nonnegative weights. Preserve their hierarchy
  // (including ties) until a priority edit explicitly saves the new values.
  const legacy = ranks.some(rank => Number(rank.order || 0) >= 0);
  const tiers = [...new Set(ranks.map(rank => Number(rank.order || 0)))].sort((a, b) => b - a);
  return ranks.map(rank => ({
    ...(typeof rank.toObject === 'function' ? rank.toObject() : rank),
    priorityLevel: legacy ? tiers.indexOf(Number(rank.order || 0)) + 1 : -Number(rank.order),
  }));
}

module.exports = { buildPriorityUpdates, withPriorityLevels };
