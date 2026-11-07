const STAT_FIELDS = ['totalLevel', 'combatAchievementTier', 'collectionLogCount'];
const CA_TIERS = ['None', 'Easy', 'Medium', 'Hard', 'Elite', 'Master', 'Grandmaster'];
const normalizeRsn = value => String(value || '').trim().replace(/[_\u00a0]/g, ' ').toLowerCase();
const primaryRsn = user => String(user.rsName || user.rsNames?.at(-1) || '').trim();
const isCount = value => Number.isSafeInteger(value) && value >= 0;

// Rewards are point-based, not based on completing every task of a difficulty.
// Use the provider's current task totals (including account exemptions), rather
// than hardcoding thresholds that change when Jagex adds tasks.
function combatTier(rows) {
  if (!Array.isArray(rows) || rows.length !== 6) return null;
  const tiers = CA_TIERS.slice(1).map(name =>
    rows.find(row => String(row.name).toLowerCase() === name.toLowerCase()));
  if (tiers.some(row => !row || !isCount(row.total) || !isCount(row.completed) ||
    row.completed > row.total)) return null;
  const points = tiers.reduce((sum, row, i) => sum + row.completed * (i + 1), 0);
  if (!tiers.some(row => row.total > 0)) return null;
  let threshold = 0, tier = 'None';
  tiers.forEach((row, i) => {
    threshold += row.total * (i + 1);
    if (points >= threshold) tier = CA_TIERS[i + 1];
  });
  return tier;
}

function profileStats(profile, rsn) {
  if (normalizeRsn(profile?.username) !== normalizeRsn(rsn)) {
    throw new Error('RuneProfile returned a different account.');
  }
  const stats = {};
  if (isCount(profile.skills?.totalLevel) && profile.skills.totalLevel > 0) {
    stats.totalLevel = profile.skills.totalLevel;
  }
  if (isCount(profile.collectionLog?.obtained)) {
    stats.collectionLogCount = profile.collectionLog.obtained;
  }
  const tier = combatTier(profile.combatAchievements);
  if (tier !== null) stats.combatAchievementTier = tier;
  if (!Object.keys(stats).length) throw new Error('RuneProfile returned no valid stats.');
  return stats;
}

function manualStatUpdates(existing, data) {
  const patch = {};
  for (const field of STAT_FIELDS) {
    if (data[field] === undefined) continue;
    const value = data[field] === '' ? null : data[field];
    if (value !== null && (field === 'combatAchievementTier'
      ? !CA_TIERS.includes(value)
      : !isCount(value) || (field === 'totalLevel' && value === 0))) {
      throw new Error(field === 'combatAchievementTier'
        ? 'Choose a valid Combat Achievement tier.'
        : `${field} must be a whole ${field === 'totalLevel' ? 'positive' : 'non-negative'} number, or blank for automatic sync.`);
    }
    if (value === (existing[field] ?? null)) continue;
    patch[field] = value;
    patch[`statsManual.${field}`] = value !== null;
  }
  return patch;
}

function createUserStatsService({ User, getSettings, getLocks, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  let running = false;
  let state = { status: 'idle' };
  let lastProfileRequest = null;

  async function getJson(url, profile = false) {
    if (profile && lastProfileRequest !== null) {
      await sleep(Math.max(0, 2100 - (now() - lastProfileRequest)));
    }
    if (profile) lastProfileRequest = now();
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'VisionaryBot/1.0 (clan dashboard)', 'x-user-agent': 'VisionaryBot/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404 && profile) return null;
    if (!response.ok) {
      if (response.status === 429) {
        const retry = Number(response.headers?.get('retry-after'));
        lastProfileRequest = now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60000);
      }
      throw new Error(`Stats provider returned HTTP ${response.status}.`);
    }
    return response.json();
  }

  async function run() {
    try {
      const users = await User.find({}).lean();
      state.total = users.length;
      const settings = await getSettings();
      const wom = new Map();
      if (String(settings.womGroupId || '').trim()) {
        try {
          const rows = await getJson(`https://api.wiseoldman.net/v2/groups/${encodeURIComponent(settings.womGroupId)}/bulk-hiscores`);
          if (!Array.isArray(rows)) throw new Error('Invalid WOM bulk stats response.');
          for (const row of rows) {
            const level = row.data?.data?.skills?.overall?.level;
            if (isCount(level) && level > 0) {
              wom.set(normalizeRsn(row.player?.username), level);
            }
          }
        } catch (error) { state.warnings.push(`WOM: ${error.message}`); }
      }
      for (const user of users) {
        const rsn = primaryRsn(user);
        if (!rsn) { state.missingRsn++; state.processed++; continue; }
        const stats = {};
        try {
          const profile = await getJson(`https://api.runeprofile.com/v1/accounts/${encodeURIComponent(rsn)}`, true);
          if (profile === null) state.missingProfile++;
          else Object.assign(stats, profileStats(profile, rsn));
        } catch (error) {
          state.failed++;
          if (state.warnings.length < 10) state.warnings.push(`${rsn}: ${error.message}`);
        }
        // WOM remains the preferred source for total level.
        if (wom.has(normalizeRsn(rsn))) stats.totalLevel = wom.get(normalizeRsn(rsn));
        // Read locks at write time, and use conditional writes so manual edits,
        // account changes, and deleted users cannot be overwritten mid-sync.
        const locks = await getLocks();
        let updated = false;
        for (const field of STAT_FIELDS) {
          if (stats[field] === undefined || locks[`user.${user.userId}.${field}`]) continue;
          const result = await User.updateOne({
            userId: user.userId,
            rsName: user.rsName ?? null,
            rsNames: user.rsNames ?? null,
            [`statsManual.${field}`]: { $ne: true },
          }, { $set: { [field]: stats[field], statsSyncedAt: new Date(now()) } });
          if (result.matchedCount) updated = true;
        }
        if (updated) state.updated++;
        state.processed++;
      }
      state.status = 'complete';
    } catch (error) {
      state.status = 'failed';
      state.error = error.message;
    } finally {
      state.finishedAt = new Date(now()).toISOString();
      running = false;
    }
  }
  return {
    status: () => ({ ...state, warnings: [...(state.warnings || [])] }),
    start() {
      if (!running) {
        running = true;
        state = { status: 'running', total: 0, processed: 0, updated: 0,
          missingRsn: 0, missingProfile: 0, failed: 0, warnings: [],
          startedAt: new Date(now()).toISOString() };
        void run();
      }
      return this.status();
    },
  };
}

module.exports = { STAT_FIELDS, CA_TIERS, combatTier, profileStats, manualStatUpdates, createUserStatsService };
