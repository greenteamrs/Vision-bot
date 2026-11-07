// The dashboard numbers priorities top-down (1 = highest). Keep the existing
// internal hierarchy convention (larger order = higher) used by rank checks.
function buildPriorityUpdates(ranks, rankIds) {
  const byId = new Map(ranks.map(rank => [String(rank._id), rank]));
  if (!Array.isArray(rankIds) || rankIds.length !== ranks.length ||
      new Set(rankIds).size !== ranks.length || rankIds.some(id => !byId.has(id))) {
    throw new Error('The rank list changed. Refresh the ranks and try again.');
  }
  return rankIds.flatMap((id, index) => {
    const order = rankIds.length - index;
    return Number(byId.get(id).order) === order ? [] : [{ id, order }];
  });
}

module.exports = { buildPriorityUpdates };
