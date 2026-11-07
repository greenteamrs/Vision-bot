function findPendingRankUps({ ranks, users, daysInClan }) {
  if (!Array.isArray(ranks) || !Array.isArray(users) || typeof daysInClan !== 'function') {
    throw new TypeError('ranks, users, and daysInClan are required.');
  }
  if (!ranks.length) return [];

  const normalizedRankNames = ranks.map(rank => String(rank.name || '').trim().toLowerCase());
  const pending = [];
  for (const user of users) {
    const days = daysInClan(user);
    let qualifiedIndex = -1;
    for (let index = 0; index < ranks.length; index++) {
      const rank = ranks[index];
      if (days >= rank.minDays &&
          Number(user.lootPoints || 0) >= Number(rank.minLootPoints || 0) &&
          Number(user.level || 0) >= Number(rank.minLevel || 0)) {
        qualifiedIndex = index;
      }
    }
    if (qualifiedIndex < 0) continue;

    const currentWomRank = String(user.womRank || '').trim();
    const currentIndex = normalizedRankNames.indexOf(currentWomRank.toLowerCase());
    const targetRank = ranks[qualifiedIndex];
    const currentRank = currentIndex >= 0 ? ranks[currentIndex] : null;
    if (currentRank && Number(currentRank.order || 0) >= Number(targetRank.order || 0)) continue;

    pending.push({
      userId: user.userId,
      username: user.username || user.userId,
      currentRank: currentWomRank || 'No WOM rank recorded',
      rankName: targetRank.name,
      days,
      lootPoints: Number(user.lootPoints || 0),
      level: Number(user.level || 0),
      specialRequirement: String(targetRank.specialRequirement || '').trim(),
    });
  }
  return pending;
}

function formatPendingRankUps(pending, { maxLines = 18, maxChars = 1700 } = {}) {
  if (!pending.length) return 'No outstanding rank-ups. Everyone currently qualifies for the rank recorded in WOM.';

  const lines = [];
  for (const person of pending) {
    if (lines.length >= maxLines) break;
    const username = String(person.username || person.userId || 'Unknown member').slice(0, 70);
    const currentRank = String(person.currentRank || 'Unknown rank').slice(0, 60);
    const rankName = String(person.rankName || 'Unknown rank').slice(0, 60);
    const requirement = person.specialRequirement
      ? ` (manual check: ${String(person.specialRequirement).slice(0, 90)})`
      : '';
    const line = `• ${username}: ${currentRank} → ${rankName}${requirement}`;
    const currentLength = `Found ${pending.length} outstanding rank-ups:\n${lines.join('\n')}`.length;
    if (currentLength + line.length + 1 > maxChars) break;
    lines.push(line);
  }
  const remaining = pending.length - lines.length;
  if (remaining > 0) lines.push(`…and ${remaining} more. Open the dashboard for the full list.`);
  return `Found ${pending.length} outstanding rank-up${pending.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

module.exports = { findPendingRankUps, formatPendingRankUps };
