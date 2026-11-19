const TEST_CHANNEL_ID = '1572351838823653397';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHALLENGES = [
  'tempoross unique (4 rarest)',
  'tormented demons claws/synapse',
  'maggot king',
  'armoured zombies axe+helmet',
  'Toa any purple',
  'Chambers any purple',
  'TzHaar-Ket helm/body/legs (1)',
  'Yama horn/armor (1)',
  'ring of endurance',
  'colosseum armor/ralos',
  'Zalcano shard/tool',
  'Tob any purple',
  'Tfa any purple',
  'volcanic mine dragon pick',
  'dragon pickaxe from wildy boss',
  'kril staff of the dead/hilt/pet',
  'kree body/legs/pet',
  'nex anything',
  'bandos hilt/boots/pet',
  'sara hilt/acb/pet',
  'runescroll bloody notes/bloodbark',
  'Zulrah one of the four uniques',
  'Royal titans Full staff',
  'bigfish/ hugefish',
  'vale offerings fletching knife',
];

function clock(config, now = Date.now()) {
  let day = Number(config.startDay || 0);
  let dayEndsAt = null;
  if (config.state === 'running') {
    const duration = config.dayDurationSeconds * 1000;
    const elapsed = Math.max(0, now - new Date(config.startedAt).getTime());
    day += Math.floor(elapsed / duration);
    dayEndsAt = new Date(new Date(config.startedAt).getTime()
      + (Math.floor(elapsed / duration) + 1) * duration).toISOString();
  }
  day = Math.min(26, day);
  if (config.state === 'idle') day = 0;
  return {
    id: config.runId,
    state: day > 25 ? 'completed' : config.state,
    day,
    opened: Math.min(25, day),
    dayEndsAt: config.state === 'running' && day <= 25 ? dayEndsAt : null,
  };
}

function liveClock(config, now = Date.now()) {
  const status = config.liveStatus || 'off';
  const firstPostAt = config.liveFirstPostAt ? new Date(config.liveFirstPostAt) : null;
  if (status === 'off' || !firstPostAt || Number.isNaN(firstPostAt.getTime())) return null;
  const base = { id: config.runId, firstPostAt: firstPostAt.toISOString() };
  if (status === 'scheduled') return { ...base, state:'scheduled', day:0, opened:0, dayEndsAt:null };
  if (status === 'converting') return { ...base, state:'converting', day:0, opened:0, dayEndsAt:null };
  if (status === 'completed') return { ...base, state:'completed', day:26, opened:25, dayEndsAt:null };
  const nextMidnight = Date.UTC(firstPostAt.getUTCFullYear(), firstPostAt.getUTCMonth(), firstPostAt.getUTCDate() + 1);
  const day = Math.min(26, now < nextMidnight ? 1 : 2 + Math.floor((now - nextMidnight) / DAY_MS));
  return {
    ...base,
    state: day <= 25 ? 'running' : 'closing',
    day,
    opened: Math.min(25, day),
    dayEndsAt: day <= 25 ? new Date(nextMidnight + (day - 1) * DAY_MS).toISOString() : null,
  };
}

function liveDayDueAt(firstPostAt, day) {
  const first = new Date(firstPostAt);
  if (Number.isNaN(first.getTime()) || !Number.isInteger(day) || day < 1 || day > 26) {
    throw new Error('Choose a valid live day and first-post date.');
  }
  if (day === 1) return first;
  const nextMidnight = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate() + 1);
  return new Date(nextMidnight + (day - 2) * DAY_MS);
}

function validateLiveStart(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error('Choose the first-post date and time in UTC.');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new Error('Choose a valid UTC date and time.');
  if (date.getTime() <= now) throw new Error('The first picture must be scheduled for a future date and time.');
  return date;
}

function challengeText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 1000) throw new Error('Challenge must contain 1–1000 characters.');
  return text;
}

function defaultAnnouncement(day) {
  return day === 26
    ? '**Advent calendar complete**\n\nAll 25 doors are open! Picture submissions are closed. Staff can still review submissions in the dashboard.'
    : '**December {day} advent challenge**\n\n**{challenge}**\n\nComplete this challenge during the current calendar day. Use `/adventsubmit` with your screenshot in this channel. Staff will review it.\nCloses {closes}.\nOne calendar day lasts {duration} seconds.';
}

function renderAnnouncement(text, config, day, closes = '<t:1796169600:F>', duration = config.dayDurationSeconds) {
  const values = {
    day: String(day), challenge: config.challenges[day - 1] || '',
    closes, duration: String(duration),
  };
  const result = text.replace(/\{(day|challenge|closes|duration)\}/g, (_, key) => values[key]);
  if (result.length > 4096) throw new Error('The full announcement exceeds the supported 4096-character limit after filling in its placeholders.');
  return result;
}

function announcementText(value, config, day) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) {
    throw new Error('Announcement must contain 1–4000 characters.');
  }
  renderAnnouncement(value, config, day);
  return value;
}

function settingsInput(input, config) {
  if (config.state !== 'idle') throw new Error('Reset the test before changing its clock or year.');
  const result = {};
  if (input.year !== undefined) {
    if (!Number.isInteger(input.year) || input.year < 2026 || input.year > 2100) {
      throw new Error('Year must be a whole number between 2026 and 2100.');
    }
    result.year = input.year;
  }
  if (input.dayDurationSeconds !== undefined) {
    if (!Number.isInteger(input.dayDurationSeconds)
      || input.dayDurationSeconds < 60 || input.dayDurationSeconds > 86400) {
      throw new Error('A test day must last 60–86400 seconds.');
    }
    result.dayDurationSeconds = input.dayDurationSeconds;
  }
  return result;
}

function actionUpdate(config, action, now = Date.now()) {
  const current = clock(config, now);
  const at = new Date(now);
  switch (action) {
    case 'start':
      if (config.state !== 'idle') throw new Error('This test has already started.');
      return { state: 'running', startDay: 1, startedAt: at };
    case 'pause':
      if (current.state !== 'running') throw new Error('Only a running test can be paused.');
      return {
        state: 'paused', startDay: current.day, startedAt: null,
        pausedElapsedMs: (now - new Date(config.startedAt).getTime()) % (config.dayDurationSeconds * 1000),
      };
    case 'resume':
      if (current.state !== 'paused') throw new Error('Only a paused test can be resumed.');
      return {
        state: 'running', startDay: current.day,
        startedAt: new Date(now - Number(config.pausedElapsedMs || 0)), pausedElapsedMs: 0,
      };
    case 'advance':
      if (!['running', 'paused'].includes(current.state)) throw new Error('Start a test before advancing it.');
      return { state: current.day === 25 ? 'completed' : 'running', startDay: current.day + 1, startedAt: at };
    default: throw new Error('Unknown test action.');
  }
}

function assertAccepting(config, { channelId, now = Date.now() }) {
  if (String(channelId) !== String(config.channelId || TEST_CHANNEL_ID)) {
    throw new Error(`Advent testing is restricted to its selected channel (<#${config.channelId || TEST_CHANNEL_ID}>).`);
  }
  const run = clock(config, now);
  if (run.state !== 'running' || run.day < 1 || run.day > 25) {
    throw new Error('The advent test is not accepting pictures right now.');
  }
  return run;
}

module.exports = {
  TEST_CHANNEL_ID, DEFAULT_CHALLENGES, clock, liveClock, liveDayDueAt, validateLiveStart,
  challengeText, settingsInput, actionUpdate, assertAccepting,
  defaultAnnouncement, renderAnnouncement, announcementText,
};
