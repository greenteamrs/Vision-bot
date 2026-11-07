const { resolvePermanentRank } = require('./rank-history');

function findPendingRankUps({ ranks, users, daysInClan }) {
  if (!Array.isArray(ranks) || !Array.isArray(users) || typeof daysInClan !== 'function') {
    throw new TypeError('ranks, users, and daysInClan are required.');
  }
  if (!ranks.length) return [];

  const pending = [];
  for (const user of users) {
    const days = daysInClan(user);
    let qualifiedIndex = -1;
    for (let index = 0; index < ranks.length; index++) {
      const rank = ranks[index];
      // Notification-disabled ranks are manually assigned, not earned by thresholds.
      // Keep them in the full list only to recognize a member's current WOM rank.
      if (rank.notifyOnEligibility === false || rank.isTemporary === true) continue;
      if (days >= rank.minDays &&
          Number(user.lootPoints || 0) >= Number(rank.minLootPoints || 0) &&
          Number(user.level || 0) >= Number(rank.minLevel || 0)) {
        qualifiedIndex = index;
      }
    }
    if (qualifiedIndex < 0) continue;

    const current = resolvePermanentRank(user, ranks);
    if (current.unknown) continue;
    const targetRank = ranks[qualifiedIndex];
    const currentRank = current.rank;
    if (currentRank && Number(currentRank.order || 0) >= Number(targetRank.order || 0)) continue;

    pending.push({
      userId: user.userId,
      username: user.discordName || user.username || user.userId,
      rsName: user.rsName || (user.rsNames || []).at(-1) || 'Unknown RSN',
      droptrackerSetup: user.droptrackerSetup === true,
      currentRank: current.name || 'No WOM rank recorded',
      rankName: targetRank.name,
      days,
      lootPoints: Number(user.lootPoints || 0),
      level: Number(user.level || 0),
      specialRequirement: String(targetRank.specialRequirement || '').trim(),
    });
  }
  return pending;
}

function formatPendingRankUps(pending, { maxLines = 18, maxChars = 1700, unknownRanks = [] } = {}) {
  if (!pending.length && !unknownRanks.length) return 'No outstanding rank-ups among the checked Visionaries members.';

  const lines = [];
  for (const person of pending) {
    if (lines.length >= maxLines) break;
    const username = String(person.username || person.userId || 'Unknown member').slice(0, 70);
    const currentRank = String(person.currentRank || 'Unknown rank').slice(0, 60);
    const rankName = String(person.rankName || 'Unknown rank').slice(0, 60);
    const requirement = person.specialRequirement
      ? ` (manual check: ${String(person.specialRequirement).slice(0, 90)})`
      : '';
    const rsName = String(person.rsName || 'Unknown RSN').slice(0, 70);
    const lp = String(Number(person.lootPoints || 0)).replace('.', ',');
    const line = `${rsName} / ${username} / LP: ${lp} / Days in clan: ${Number(person.days || 0)} / Community: ${Number(person.level || 0)} / Droptracker: ${person.droptrackerSetup === true ? '✅' : '❌'} / ${currentRank} → ${rankName}${requirement}`;
    const currentLength = `Found ${pending.length} outstanding rank-ups:\n${lines.join('\n')}`.length;
    if (currentLength + line.length + 1 > maxChars) break;
    lines.push(line);
  }
  const remaining = pending.length - lines.length;
  if (remaining > 0) lines.push(`…and ${remaining} more. Open the dashboard for the full list.`);
  for (const user of unknownRanks) {
    lines.push(`Original rank unknown: ${String(user.rsName || 'Unknown RSN').slice(0, 70)} / ${String(user.username).slice(0, 70)} — seasonal rank ${String(user.temporaryRank).slice(0, 60)}. Set their original rank in dashboard Users; eligibility was not guessed.`);
  }
  return `Found ${pending.length} outstanding rank-up${pending.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

module.exports = { findPendingRankUps, formatPendingRankUps };
