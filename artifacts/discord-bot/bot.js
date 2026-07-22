const { Client, GatewayIntentBits, Events, SlashCommandBuilder, REST, Routes, StringSelectMenuBuilder, ActionRowBuilder , EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createCanvas, loadImage } = require('@napi-rs/canvas');


// --- MongoDB: User Schema ---
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: String,
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 0 },
  lootPoints: { type: Number, default: 0 },
  lastMessageXp: { type: Date, default: null },
  lastVoiceJoinXp: { type: Date, default: null },
  rsName: { type: String, default: null },
  rsNames: { type: [String], default: [] },
  joinedServerAt: { type: Date, default: null },
  joinedClanAt: { type: Date, default: null },
  notifiedRankId: { type: String, default: null },
});

const User = mongoose.model('User', userSchema);

// --- MongoDB: Rank Schema ---
const rankSchema = new mongoose.Schema({
  name: { type: String, required: true },
  minDays: { type: Number, default: 0 },
  minLootPoints: { type: Number, default: 0 },
  minLevel: { type: Number, default: 0 },
  order: { type: Number, default: 0 },
}, { timestamps: true });

const Rank = mongoose.model('Rank', rankSchema);

// --- MongoDB: Settings Schema ---
const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'main' },
  messageXpMin: { type: Number, default: 15 },
  messageXpMax: { type: Number, default: 25 },
  messageXpCooldownSecs: { type: Number, default: 60 },
  voiceJoinXp: { type: Number, default: 50 },
  voiceJoinCooldownSecs: { type: Number, default: 3600 },
  voiceIntervalXp: { type: Number, default: 300 },
  voiceIntervalMins: { type: Number, default: 30 },
  dropTopXp: { type: [Number], default: [5000, 4000, 3000, 2000, 1000, 1000, 1000, 1000, 1000, 1000] },
  afkChannelId: { type: String, default: '155520058762723328' },
  rankNotifyChannelId: { type: String, default: '' },
  womGroupId: { type: String, default: '' },
  womActivityChannelId: { type: String, default: '' },
  womLastActivityAt: { type: Date, default: null },
  droptrackerGroupId: { type: String, default: '' },
  bingoChannelId: { type: String, default: '' },
  bingoReviewChannelId: { type: String, default: '' },
  levelA: { type: Number, default: 5 },
  levelB: { type: Number, default: 50 },
  levelC: { type: Number, default: 100 },
  levelMax: { type: Number, default: 99 },
});

const Settings = mongoose.model('Settings', settingsSchema);

const commandConfigSchema = new mongoose.Schema({
  key:         { type: String, unique: true, required: true },
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  usage:       { type: String, default: '' },
  isMod:       { type: Boolean, default: false },
  category:    { type: String, default: 'General' },
});
const CommandConfig = mongoose.model('CommandConfig', commandConfigSchema);

// --- Bingo Models ---
const bingoTileConfigSchema = new mongoose.Schema({
  tileId: { type: String, required: true, unique: true },
  steps: { type: [String], default: [] },
});
const BingoTileConfig = mongoose.model('BingoTileConfig', bingoTileConfigSchema);

const bingoProgressSchema = new mongoose.Schema({
  tileId: { type: String, required: true },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'BingoTeam', required: true },
  completedSteps: { type: [String], default: [] },
});
bingoProgressSchema.index({ tileId: 1, teamId: 1 }, { unique: true });
const BingoProgress = mongoose.model('BingoProgress', bingoProgressSchema);

const bingoSubmissionSchema = new mongoose.Schema({
  tileId:        { type: String, required: true },
  teamId:        { type: mongoose.Schema.Types.ObjectId, ref: 'BingoTeam', required: true },
  submittedBy:   { type: String, required: true },   // Discord user tag
  submittedById: { type: String, required: true },   // Discord user ID
  imageUrl:      { type: String, default: '' },
  note:          { type: String, default: '' },
  status:        { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  reviewMessageId: { type: String, default: '' },    // message ID in review channel
  reviewedBy:    { type: String, default: '' },
}, { timestamps: true });
const BingoSubmission = mongoose.model('BingoSubmission', bingoSubmissionSchema);

const bingoTeamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  color: { type: String, default: '#e74c3c' },
  order: { type: Number, default: 0 },
}, { timestamps: true });
const BingoTeam = mongoose.model('BingoTeam', bingoTeamSchema);

const bingoCompletionSchema = new mongoose.Schema({
  tileId: { type: String, required: true },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'BingoTeam', required: true },
  completedBy: { type: String, default: '' },
  completedAt: { type: Date, default: Date.now },
});
const BingoCompletion = mongoose.model('BingoCompletion', bingoCompletionSchema);

const DEFAULT_COMMANDS = [
  { key: 'lp',              name: 'lp',              category: 'Loot Points', description: 'Check your LP balance',                  usage: '!lp [@user]',              isMod: false },
  { key: 'total',           name: 'total',            category: 'Loot Points', description: 'Show the top LP leaderboard',            usage: '!total',                   isMod: false },
  { key: 'lplist',          name: 'lplist',           category: 'Loot Points', description: 'Show full LP list A–Z',                  usage: '!lplist',                  isMod: false },
  { key: 'split',           name: 'split',            category: 'Loot Points', description: 'Give each mentioned user LP',            usage: '!split <amount> @users',   isMod: false },
  { key: 'donate',          name: 'donate',           category: 'Loot Points', description: 'Give each user half the LP amount',      usage: '!donate <amount> @users',  isMod: false },
  { key: 'add',             name: 'add',              category: 'Loot Points', description: 'Add LP to a user (mod)',                 usage: '!add <amount> @user',      isMod: true  },
  { key: 'remove',          name: 'remove',           category: 'Loot Points', description: 'Remove LP from a user (mod)',            usage: '!remove <amount> @user',   isMod: true  },
  { key: 'xp',              name: 'xp',               category: 'XP & Levels', description: 'Check XP and level progress',            usage: '!xp [@user]',              isMod: false },
  { key: 'level',           name: 'level',            category: 'XP & Levels', description: 'Check current level',                    usage: '!level [@user]',           isMod: false },
  { key: 'leaderboard',     name: 'leaderboard',      category: 'XP & Levels', description: 'Show the XP leaderboard',                usage: '!leaderboard',             isMod: false },
  { key: 'xptop',           name: 'xptop',            category: 'XP & Levels', description: 'Alias for leaderboard',                  usage: '!xptop',                   isMod: false },
  { key: 'xplist',          name: 'xplist',           category: 'XP & Levels', description: 'Show full XP list A–Z',                  usage: '!xplist',                  isMod: false },
  { key: 'addxp',           name: 'addxp',            category: 'XP & Levels', description: 'Add XP to a user (mod)',                 usage: '!addxp <amount> @user',    isMod: true  },
  { key: 'removexp',        name: 'removexp',         category: 'XP & Levels', description: 'Remove XP from a user (mod)',            usage: '!removexp <amount> @user', isMod: true  },
  { key: 'rslink',          name: 'rslink',           category: 'RS Names',    description: 'Link a RuneScape name to your account',  usage: '!rslink <rsname>',         isMod: false },
  { key: 'rsunlink',        name: 'rsunlink',         category: 'RS Names',    description: 'Unlink a linked RS name',                usage: '!rsunlink <rsname>',       isMod: false },
  { key: 'myrs',            name: 'myrs',             category: 'RS Names',    description: 'See all your linked RS names',           usage: '!myrs',                    isMod: false },
  { key: 'rsnames',         name: 'rsnames',          category: 'RS Names',    description: 'List all linked RS names (mod)',         usage: '!rsnames',                 isMod: true  },
  { key: 'rsset',           name: 'rsset',            category: 'RS Names',    description: 'Set RS name for any user (mod)',         usage: '!rsset @user <rsname>',    isMod: true  },
  { key: 'droptop',         name: 'droptop',          category: 'Droptracker', description: 'Award monthly XP from Droptracker API',  usage: '!droptop',                 isMod: true  },
  { key: 'toploot',         name: 'toploot',          category: 'Droptracker', description: 'Show loot leaderboard from Droptracker',  usage: '!toploot [npc_name]',       isMod: false },
  { key: 'drops',           name: 'drops',            category: 'Droptracker', description: 'Show recent drops from Droptracker',      usage: '!drops [npc_name]',         isMod: false },
  { key: 'syncdroptracker', name: 'syncdroptracker',  category: 'Admin',       description: 'Sync members from Droptracker',           usage: '!syncdroptracker',          isMod: true  },
  { key: 'testaward',       name: 'testaward',        category: 'Admin',       description: 'Test monthly auto-award without waiting',  usage: '!testaward',                isMod: true  },
  { key: 'syncwom',         name: 'syncwom',          category: 'Admin',       description: 'Sync clan join dates from WiseOldMan',   usage: '!syncwom',                 isMod: true  },
  { key: 'checkranks',      name: 'checkranks',       category: 'Admin',       description: 'Trigger rank-up check immediately',      usage: '!checkranks',              isMod: true  },
  { key: 'importmee6',      name: 'importmee6',       category: 'Admin',       description: 'Import levels from MEE6',                usage: '!importmee6',              isMod: true  },
  { key: 'cleanduplicates', name: 'cleanduplicates',  category: 'Admin',       description: 'Remove duplicate RS name entries',       usage: '!cleanduplicates',         isMod: true  },
  { key: 'fixlp',           name: 'fixlp',            category: 'Admin',       description: 'Restore hardcoded LP values',            usage: '!fixlp',                   isMod: true  },
  { key: 'bingoscore',      name: 'bingoscore',       category: 'Bingo',       description: 'Post bingo scoreboard to Discord',                  usage: '!bingoscore [team]',              isMod: false },
  { key: 'bingosubmit',    name: 'bingo-submit',     category: 'Bingo',       description: 'Submit a drop screenshot for bingo review',         usage: '!bingo-submit [note]',            isMod: false },
  { key: 'bingoapprove',   name: 'bingo-approve',    category: 'Bingo',       description: 'Approve a submission — reply to it: !bingo-approve <team> | <tile>', usage: '!bingo-approve <team> | <tile>', isMod: true  },
  { key: 'bingoreject',    name: 'bingo-reject',     category: 'Bingo',       description: 'Reject a submission — reply to it with optional reason', usage: '!bingo-reject [reason]',         isMod: true  },
  { key: 'help',            name: 'help',             category: 'General',     description: 'Show all available commands',            usage: '!help',                    isMod: false },
];

// --- Slash command definitions ---
const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('bingo-submit')
    .setDescription('Submit a drop screenshot for bingo review')
    .addAttachmentOption(opt =>
      opt.setName('image').setDescription('Upload a screenshot directly').setRequired(false))
    .addStringOption(opt =>
      opt.setName('link').setDescription('Or paste a Gyazo / Imgur / image URL instead').setRequired(false))
    .addStringOption(opt =>
      opt.setName('note').setDescription('Optional note about the drop (e.g. boss, task)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('bingo-approve')
    .setDescription('Approve a pending bingo submission and assign it to a team (mods only)')
    .addStringOption(opt =>
      opt.setName('submission').setDescription('Pending submission to approve').setRequired(true).setAutocomplete(true))
    .addStringOption(opt =>
      opt.setName('tile').setDescription('Bingo tile this drop counts for').setRequired(true).setAutocomplete(true))
    .addStringOption(opt =>
      opt.setName('team').setDescription('Team to assign the tile to').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName('bingo-reject')
    .setDescription('Reject a pending bingo submission (mods only)')
    .addStringOption(opt =>
      opt.setName('submission').setDescription('Pending submission to reject').setRequired(true).setAutocomplete(true))
    .addStringOption(opt =>
      opt.setName('reason').setDescription('Reason for rejection').setRequired(false)),
].map(cmd => cmd.toJSON());

async function registerSlashCommands(clientId, guildId) {
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: SLASH_COMMANDS }
    );
    console.log(`Registered ${SLASH_COMMANDS.length} slash commands in guild ${guildId}`);
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}

// Command name cache — key → current name. Updated on startup and via PATCH /api/commands/:key
let commandNames = {};

function cmd(key) {
  return commandNames[key] || key;
}

async function refreshCommandNames() {
  const cmds = await CommandConfig.find({});
  const map = {};
  for (const c of cmds) map[c.key] = c.name;
  commandNames = map;
}

async function seedCommands() {
  for (const def of DEFAULT_COMMANDS) {
    await CommandConfig.findOneAndUpdate(
      { key: def.key },
      { $setOnInsert: { name: def.name, description: def.description, usage: def.usage, isMod: def.isMod, category: def.category } },
      { upsert: true }
    );
  }
  await refreshCommandNames();
}

let cachedSettings = null;

async function getSettings() {
  if (cachedSettings) return cachedSettings;
  let s = await Settings.findOne({ key: 'main' });
  if (!s) {
    s = await Settings.create({ key: 'main' });
  }
  cachedSettings = s.toObject();
  return cachedSettings;
}

async function saveSettings(data) {
  const allowed = [
    'messageXpMin', 'messageXpMax', 'messageXpCooldownSecs',
    'voiceJoinXp', 'voiceJoinCooldownSecs',
    'voiceIntervalXp', 'voiceIntervalMins',
    'dropTopXp', 'afkChannelId', 'rankNotifyChannelId', 'womGroupId', 'womActivityChannelId', 'droptrackerGroupId', 'bingoChannelId', 'bingoReviewChannelId',
    'levelA', 'levelB', 'levelC', 'levelMax',
  ];
  const update = {};
  for (const k of allowed) {
    if (data[k] !== undefined) update[k] = data[k];
  }
  await Settings.findOneAndUpdate({ key: 'main' }, { $set: update }, { upsert: true, new: true });
  cachedSettings = null;
}

// Refresh settings cache every 5 minutes
setInterval(() => { cachedSettings = null; }, 5 * 60 * 1000);

// --- User helpers ---
async function getUser(userId, username, member = null) {
  let user = await User.findOne({ userId });
  if (!user) {
    user = new User({ userId, username });
    if (member?.joinedAt) user.joinedServerAt = member.joinedAt;
    await user.save();
  } else if (!user.joinedServerAt && member?.joinedAt) {
    user.joinedServerAt = member.joinedAt;
    await user.save();
  }
  return user;
}

function xpForLevel(level) {
  const A = cachedSettings?.levelA ?? 5;
  const B = cachedSettings?.levelB ?? 50;
  const C = cachedSettings?.levelC ?? 100;
  return Math.floor(A * level * level + B * level + C);
}

async function addXp(userId, username, amount) {
  const user = await getUser(userId, username);
  const maxLvl = cachedSettings?.levelMax ?? 99;
  user.xp += amount;
  user.username = username;
  while (user.level < maxLvl && user.xp >= xpForLevel(user.level)) {
    user.xp -= xpForLevel(user.level);
    user.level += 1;
  }
  if (user.level >= maxLvl) user.xp = 0;
  await user.save();
  return user;
}

// --- Gemini Vision ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function extractLeaderboardFromImage(imageUrl) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const imageRes = await fetch(imageUrl);
  const imageBuffer = await imageRes.arrayBuffer();
  const base64Image = Buffer.from(imageBuffer).toString('base64');
  const mimeType = imageRes.headers.get('content-type') || 'image/png';

  const prompt = `This is a RuneScape clan loot leaderboard screenshot.
Extract ONLY the player names in rank order (1st place first).
Return ONLY a JSON array of names, no explanation, no markdown, no code block.
Example: ["PlayerOne","PlayerTwo","PlayerThree"]
List up to 10 players. If fewer than 10 are visible, list only those shown.`;

  const result = await model.generateContent([
    prompt,
    { inlineData: { data: base64Image, mimeType } },
  ]);

  const text = result.response.text().trim();
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ]
});

const PREFIX = "!";
const XP_CHANNEL_ID = "1494732715063509113";
const voiceJoinTime = {};
const voiceIntervals = {};

// --- Level up messages ---
const levelUpMessages = [
  (user, level) => `A wild **${user}** has appeared at level **${level}**!`,
  (user, level) => `**${user}** just leveled up to **${level}**. Let's gooo!`,
  (user, level) => `Yay! You made it, **${user}**! Welcome to level **${level}**!`,
  (user, level) => `**${user}** is joining the level **${level}** party!`,
  (user, level) => `**${user}** reached level **${level}**. Absolutely unstoppable.`,
  (user, level) => `Level **${level}** unlocked! Nice work, **${user}**!`,
  (user, level) => `**${user}** just hit level **${level}**. The grind is real.`,
  (user, level) => `Look who leveled up! **${user}** is now level **${level}**!`,
  (user, level) => `**${user}** evolved into a level **${level}** legend!`,
  (user, level) => `Up, up and away! **${user}** soared to level **${level}**!`,
];

function getLevelUpMessage(username, level) {
  const fn = levelUpMessages[Math.floor(Math.random() * levelUpMessages.length)];
  return fn(username, level);
}

async function sendToXpChannel(message) {
  try {
    const channel = await client.channels.fetch(XP_CHANNEL_ID);
    channel.send(message);
  } catch (err) {
    console.error("Failed to send to XP channel:", err);
  }
}

// --- Loot Points ---
async function getLootPoints(userId, username) {
  const user = await getUser(userId, username);
  return user.lootPoints;
}

async function modifyLootPoints(userId, username, amount) {
  const user = await getUser(userId, username);
  user.lootPoints += amount;
  user.username = username;
  await user.save();
  return user.lootPoints;
}

// --- Leaderboards ---
async function buildLeaderboard() {
  const users = await User.find({ lootPoints: { $gt: 0 } }).sort({ lootPoints: -1 }).limit(20);
  if (users.length === 0) return "No loot points recorded yet!";
  const lines = users.map((u, i) => `${i + 1}. ${u.username || u.userId} — ${u.lootPoints} LP`);
  return `🏆 **Loot Points Leaderboard**\n${lines.join("\n")}`;
}

async function buildXpLeaderboard() {
  const users = await User.find().sort({ level: -1, xp: -1 }).limit(20);
  if (users.length === 0) return "No XP recorded yet!";
  const lines = users.map((u, i) => `${i + 1}. ${u.username || u.userId} — Level ${u.level} | ${u.xp}/${xpForLevel(u.level)} XP`);
  return `⭐ **XP Leaderboard**\n${lines.join("\n")}`;
}

function isMod(member) {
  return member.roles.cache.some(r => r.name.toLowerCase() === "mods" || r.name.toLowerCase() === "mod");
}

function daysInClan(user) {
  const date = user.joinedClanAt || user.joinedServerAt;
  if (!date) return 0;
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
}

async function syncWomMembers() {
  const s = await getSettings();
  const groupId = String(s.womGroupId || '').trim();
  if (!groupId) return { updated: 0, total: 0, error: 'No WOM Group ID set. Add it in XP Settings.' };

  const headers = { 'User-Agent': 'VisionaryBot/1.0', 'x-user-agent': 'VisionaryBot/1.0' };

  // Helper to fetch with error handling
  async function womFetch(url) {
    try {
      const r = await fetch(url, { headers });
      return r;
    } catch (e) {
      return null;
    }
  }

  // Try the dedicated memberships endpoint first, then fall back to group details
  let memberships = null;

  // Attempt 1: /groups/{id}/memberships (paginate if needed)
  const mUrl = `https://api.wiseoldman.net/v2/groups/${groupId}/memberships?limit=500`;
  const mRes = await womFetch(mUrl);
  if (mRes && mRes.ok) {
    const body = await mRes.json();
    memberships = Array.isArray(body) ? body
      : Array.isArray(body.memberships) ? body.memberships
      : Array.isArray(body.data) ? body.data
      : null;
  }

  // Attempt 2: /groups/{id} — WOM embeds memberships in the group detail response
  if (!memberships) {
    const gRes = await womFetch(`https://api.wiseoldman.net/v2/groups/${groupId}`);
    if (!gRes) return { updated: 0, total: 0, error: 'Network error reaching WOM API.' };
    if (gRes.status === 404) {
      return { updated: 0, total: 0, error: `WOM group "${groupId}" not found. Check the Group ID in XP Settings (should be a number, e.g. 1234).` };
    }
    if (!gRes.ok) {
      return { updated: 0, total: 0, error: `WOM API error ${gRes.status} for group "${groupId}".` };
    }
    const gBody = await gRes.json();
    memberships = Array.isArray(gBody.memberships) ? gBody.memberships
      : Array.isArray(gBody.members) ? gBody.members
      : null;
  }

  if (!memberships) return { updated: 0, total: 0, error: 'Could not read memberships from WOM API. The API response format may have changed.' };

  let updated = 0;
  for (const m of memberships) {
    const rsName = m.player?.displayName || m.player?.username;
    if (!rsName || !m.createdAt) continue;

    const user = await User.findOne({
      $or: [
        { rsName: { $regex: new RegExp(`^${rsName}$`, 'i') } },
        { rsNames: new RegExp(`^${rsName}$`, 'i') },
      ],
    });
    if (!user) continue;

    const newDate = new Date(m.createdAt);
    if (!user.joinedClanAt || Math.abs(user.joinedClanAt - newDate) > 1000) {
      await User.updateOne({ _id: user._id }, { joinedClanAt: newDate });
      updated++;
    }
  }
  return { updated, total: memberships.length };
}

// --- WOM Activity Feed ---
async function checkWomActivity(discordClient) {
  const s = await getSettings();
  const groupId = String(s.womGroupId || '').trim();
  const channelId = String(s.womActivityChannelId || '').trim();
  if (!groupId || !channelId) return;

  try {
    const r = await fetch(`https://api.wiseoldman.net/v2/groups/${groupId}/activity?limit=20`, {
      headers: { 'User-Agent': 'VisionaryBot/1.0', 'x-user-agent': 'VisionaryBot/1.0' }
    });
    if (!r.ok) return;
    const body = await r.json();
    const events = Array.isArray(body) ? body : (body.activities || body.activity || []);
    if (!events.length) return;

    // Only post events newer than the last seen timestamp
    const lastSeen = s.womLastActivityAt ? new Date(s.womLastActivityAt) : null;
    const newEvents = lastSeen
      ? events.filter(e => new Date(e.createdAt) > lastSeen)
      : events.slice(0, 1); // first run — just seed the timestamp, post nothing

    if (!newEvents.length) return;

    // Save new high-water mark
    const latest = new Date(Math.max(...newEvents.map(e => new Date(e.createdAt).getTime())));
    await Settings.findOneAndUpdate({ key: 'main' }, { $set: { womLastActivityAt: latest } });
    cachedSettings = null;

    const channel = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    // Post newest-first so they read top-down in Discord
    for (const e of [...newEvents].reverse()) {
      const name = e.player?.displayName || e.player?.username || 'Unknown';
      const type = (e.type || '').toUpperCase();
      let emoji, text;
      if (type === 'LEFT') {
        emoji = '📤'; text = `**${name}** left the clan.`;
      } else if (type === 'JOINED') {
        emoji = '📥'; text = `**${name}** joined the clan!`;
      } else if (type === 'CHANGED_ROLE') {
        const role = e.role || 'unknown';
        emoji = '🔰'; text = `**${name}** was promoted to **${role}**.`;
      } else {
        emoji = '📋'; text = `**${name}** — ${type.toLowerCase()}`;
      }
      const ts = e.createdAt ? `<t:${Math.floor(new Date(e.createdAt).getTime() / 1000)}:R>` : '';
      await channel.send(`${emoji} ${text} ${ts}`).catch(() => {});
    }
  } catch (err) {
    console.error('[WOM Activity] Error:', err.message);
  }
}

// --- Droptracker API ---
async function dtFetch(path) {
  const apiKey = process.env.DROPTRACKER_API_KEY;
  if (!apiKey) return { error: 'DROPTRACKER_API_KEY not set.' };
  const s = await getSettings();
  const groupId = String(s.droptrackerGroupId || '').trim();
  if (!groupId) return { error: 'No Droptracker Group ID set. Add it in XP Settings.' };
  try {
    const res = await fetch(`https://api.droptracker.io/groups/${groupId}${path}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': 'VisionaryBot/1.0' }
    });
    if (!res.ok) return { error: `Droptracker API error ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}

async function syncDroptrackerMembers() {
  const result = await dtFetch('/export/members');
  if (result.error) return { updated: 0, total: 0, error: result.error };
  const members = Array.isArray(result.data) ? result.data : (result.data.members || []);
  let updated = 0;
  let linked = 0;
  for (const m of members) {
    const rsName = m.player_name || m.name || m.username;
    if (!rsName) continue;

    const discordId = m.discord_id || m.discordId || m.discord_user_id;
    const womId = m.wom_id || m.wom_player_id;

    let user = null;

    // 1. Try to find by Discord ID from Droptracker (most reliable)
    if (discordId) {
      user = await User.findOne({ discordId: String(discordId) });
      if (user) {
        // Auto-link RS name if not already linked
        const alreadyLinked =
          (user.rsName || '').toLowerCase() === rsName.toLowerCase() ||
          (user.rsNames || []).some(n => n.toLowerCase() === rsName.toLowerCase());
        if (!alreadyLinked) {
          const changes = { $addToSet: { rsNames: rsName } };
          if (!user.rsName) changes.$set = { rsName };
          await User.updateOne({ _id: user._id }, changes);
          linked++;
          updated++;
        }
      }
    }

    // 2. Fall back to matching by RS name already in our DB
    if (!user) {
      user = await User.findOne({ $or: [
        { rsName: { $regex: new RegExp(`^${rsName}$`, 'i') } },
        { rsNames: new RegExp(`^${rsName}$`, 'i') },
      ]});
    }

    if (!user) continue;

    // Store WOM ID if provided
    const changes = {};
    if (womId && !user.womPlayerId) changes.womPlayerId = womId;
    if (discordId && !user.discordLinkedViaDroptracker) changes.discordLinkedViaDroptracker = true;
    if (Object.keys(changes).length) {
      await User.updateOne({ _id: user._id }, changes);
      updated++;
    }
  }
  return { updated, linked, total: members.length };
}

async function getDroptrackerTopPlayers(npcName, limit = 10) {
  let path = `/export/top-players?limit=${limit}`;
  if (npcName) path += `&npc_name=${encodeURIComponent(npcName)}`;
  return dtFetch(path);
}

async function getDroptrackerDrops(npcName, limit = 10) {
  let path = `/export/drops?limit=${limit}`;
  if (npcName) path += `&npc_name=${encodeURIComponent(npcName)}`;
  return dtFetch(path);
}

function formatGp(n) {
  if (!n && n !== 0) return '?';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

async function checkRankUps(guild) {
  const s = await getSettings();
  const notifyChannelId = s.rankNotifyChannelId || XP_CHANNEL_ID;
  const ranks = await Rank.find().sort({ order: 1, minLevel: 1, minLootPoints: 1 });
  if (ranks.length === 0) return 0;

  const users = await User.find({});
  let notified = 0;

  for (const user of users) {
    const days = daysInClan(user);
    let qualifiedRank = null;

    for (const rank of ranks) {
      if (days >= rank.minDays && user.lootPoints >= rank.minLootPoints && user.level >= rank.minLevel) {
        qualifiedRank = rank;
      }
    }

    if (!qualifiedRank) continue;
    if (user.notifiedRankId === qualifiedRank._id.toString()) continue;

    await User.updateOne({ userId: user.userId }, { notifiedRankId: qualifiedRank._id.toString() });

    try {
      const channel = await client.channels.fetch(notifyChannelId);
      const discordMember = guild ? await guild.members.fetch(user.userId).catch(() => null) : null;
      const mention = discordMember ? `<@${user.userId}>` : (user.username || user.userId);
      channel.send(
        `🎉 **Rank-up alert!** ${mention} now qualifies for **${qualifiedRank.name}**!\n` +
        `📅 ${days} days | 🏆 ${user.lootPoints} LP | ⭐ Level ${user.level}`
      );
      notified++;
    } catch (err) {
      console.error(`Rank notify error for ${user.username}:`, err);
    }
  }
  return notified;
}

// --- Drop Top XP Awards ---
async function awardDropTopXp(players, guild, channel) {
  const s = await getSettings();
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const lines = [];
  const unmatched = [];

  // Accept either full player objects (from Droptracker API) or plain RS name strings
  const entries = players.map(p =>
    typeof p === 'string'
      ? { rsName: p, discordId: null }
      : {
          rsName: p.player_name || p.name || p.username || '',
          discordId: String(p.discord_id || p.discordId || p.discord_user_id || '').trim() || null,
        }
  );

  for (let i = 0; i < entries.length && i < 10; i++) {
    const { rsName, discordId } = entries[i];
    const xpReward = s.dropTopXp[i] || 1000;

    let dbUser = null;

    // 1. Match by Discord ID from Droptracker (/claim-rsn) — most reliable
    if (discordId) {
      dbUser = await User.findOne({ discordId });
    }

    // 2. Fall back to RS name match in our DB
    if (!dbUser && rsName) {
      dbUser = await User.findOne({ $or: [
        { rsName: { $regex: new RegExp(`^${rsName}$`, 'i') } },
        { rsNames: new RegExp(`^${rsName}$`, 'i') },
      ] });
    }

    if (!dbUser) {
      unmatched.push(`${medals[i]} **${rsName || '?'}** — no Discord link found`);
      continue;
    }

    const updated = await addXp(dbUser.userId, dbUser.username, xpReward);
    const discordMember = await guild.members.fetch(dbUser.userId).catch(() => null);
    const displayName = discordMember ? `<@${dbUser.userId}>` : dbUser.username;
    lines.push(`${medals[i]} ${displayName} (**${rsName}**) — +${xpReward.toLocaleString()} XP → Level ${updated.level}`);
  }

  let response = `🏆 **Monthly DropTracker Awards!**\n\n`;
  if (lines.length > 0) response += lines.join('\n') + '\n';
  if (unmatched.length > 0) {
    response += `\n⚠️ **Unmatched** (ask them to do \`/claim-rsn\` on Droptracker):\n`;
    response += unmatched.join('\n');
  }
  channel.send(response);
}

// --- Bingo Tile Definitions ---
const BINGO_TILES = [
  { id: 'r1c1', name: 'Zenyte+',           row: 1, col: 1, rowSpan: 1, value: 1 },
  { id: 'r1c2', name: 'Lord of the Rings', row: 1, col: 2, rowSpan: 1, value: 1 },
  { id: 'r1c3', name: 'OG GWD Warrior',    row: 1, col: 3, rowSpan: 1, value: 1 },
  { id: 'r1c4', name: 'Nex',               row: 1, col: 4, rowSpan: 1, value: 1 },
  { id: 'r1c5', name: 'Not Picky',         row: 1, col: 5, rowSpan: 1, value: 1 },
  { id: 'r1c6', name: 'Voidwaker',         row: 1, col: 6, rowSpan: 1, value: 1 },
  { id: 'r2c1', name: 'CHAOS',             row: 2, col: 1, rowSpan: 1, value: 1 },
  { id: 'r2c2', name: 'Nightmare',         row: 2, col: 2, rowSpan: 1, value: 1 },
  { id: 'r2c3', name: 'Fang Collector',    row: 2, col: 3, rowSpan: 1, value: 1 },
  { id: 'r2c4', name: "Nike's",            row: 2, col: 4, rowSpan: 1, value: 1 },
  { id: 'r2c5', name: 'Bloody',            row: 2, col: 5, rowSpan: 1, value: 1 },
  { id: 'r2c6', name: 'Better get fishin', row: 2, col: 6, rowSpan: 1, value: 1 },
  { id: 'r3c1', name: 'Hammering',         row: 3, col: 1, rowSpan: 1, value: 1 },
  { id: 'r3c2', name: 'Full Godsword',     row: 3, col: 2, rowSpan: 1, value: 1 },
  { id: 'r3c3', name: 'Corporeal Beast',   row: 3, col: 3, rowSpan: 2, value: 2 },
  { id: 'r3c4', name: 'Mega Rare',         row: 3, col: 4, rowSpan: 2, value: 2 },
  { id: 'r3c5', name: 'Prayer Upgrade',    row: 3, col: 5, rowSpan: 1, value: 1 },
  { id: 'r3c6', name: 'Suit up',           row: 3, col: 6, rowSpan: 1, value: 1 },
  { id: 'r4c1', name: 'Pyramid Plunder',   row: 4, col: 1, rowSpan: 1, value: 1 },
  { id: 'r4c2', name: 'Shielding',         row: 4, col: 2, rowSpan: 1, value: 1 },
  { id: 'r4c5', name: 'Pet',               row: 4, col: 5, rowSpan: 1, value: 1 },
  { id: 'r4c6', name: 'Priffy',            row: 4, col: 6, rowSpan: 1, value: 1 },
  { id: 'r5c1', name: 'On an Oath',        row: 5, col: 1, rowSpan: 1, value: 1 },
  { id: 'r5c2', name: 'Tormenting',        row: 5, col: 2, rowSpan: 1, value: 1 },
  { id: 'r5c3', name: 'MGK',              row: 5, col: 3, rowSpan: 1, value: 1 },
  { id: 'r5c4', name: 'DT2',              row: 5, col: 4, rowSpan: 1, value: 1 },
  { id: 'r5c5', name: 'Dual Damage',       row: 5, col: 5, rowSpan: 1, value: 1 },
  { id: 'r5c6', name: 'Set Completor',     row: 5, col: 6, rowSpan: 1, value: 1 },
  { id: 'r6c1', name: 'Speeding',          row: 6, col: 1, rowSpan: 1, value: 1 },
  { id: 'r6c2', name: 'Granite Warrior',   row: 6, col: 2, rowSpan: 1, value: 1 },
  { id: 'r6c3', name: 'Gladiator',         row: 6, col: 3, rowSpan: 1, value: 1 },
  { id: 'r6c4', name: 'Better get Slayin', row: 6, col: 4, rowSpan: 1, value: 1 },
  { id: 'r6c5', name: 'Avernic Hilt',      row: 6, col: 5, rowSpan: 1, value: 1 },
  { id: 'r6c6', name: 'Slayer Starter Kit',row: 6, col: 6, rowSpan: 1, value: 1 },
];
const BINGO_TOTAL_POINTS = BINGO_TILES.reduce((s, t) => s + t.value, 0);

// Lines that award a bonus point when fully completed
// Note: r3c3 (Corp Beast) occupies rows 3&4 col 3; r3c4 (Mega Rare) occupies rows 3&4 col 4
const BINGO_LINES = [
  { type: 'row',  label: 'Row 1',         tiles: ['r1c1','r1c2','r1c3','r1c4','r1c5','r1c6'] },
  { type: 'row',  label: 'Row 2',         tiles: ['r2c1','r2c2','r2c3','r2c4','r2c5','r2c6'] },
  { type: 'row',  label: 'Row 3',         tiles: ['r3c1','r3c2','r3c3','r3c4','r3c5','r3c6'] },
  { type: 'row',  label: 'Row 4',         tiles: ['r4c1','r4c2','r3c3','r3c4','r4c5','r4c6'] },
  { type: 'row',  label: 'Row 5',         tiles: ['r5c1','r5c2','r5c3','r5c4','r5c5','r5c6'] },
  { type: 'row',  label: 'Row 6',         tiles: ['r6c1','r6c2','r6c3','r6c4','r6c5','r6c6'] },
  { type: 'col',  label: 'Column 1',      tiles: ['r1c1','r2c1','r3c1','r4c1','r5c1','r6c1'] },
  { type: 'col',  label: 'Column 2',      tiles: ['r1c2','r2c2','r3c2','r4c2','r5c2','r6c2'] },
  { type: 'col',  label: 'Column 3',      tiles: ['r1c3','r2c3','r3c3','r5c3','r6c3'] },
  { type: 'col',  label: 'Column 4',      tiles: ['r1c4','r2c4','r3c4','r5c4','r6c4'] },
  { type: 'col',  label: 'Column 5',      tiles: ['r1c5','r2c5','r3c5','r4c5','r5c5','r6c5'] },
  { type: 'col',  label: 'Column 6',      tiles: ['r1c6','r2c6','r3c6','r4c6','r5c6','r6c6'] },
  { type: 'diag', label: 'Diagonal ↘',    tiles: ['r1c1','r2c2','r3c3','r3c4','r5c5','r6c6'] },
  { type: 'diag', label: 'Diagonal ↙',    tiles: ['r1c6','r2c5','r3c4','r3c3','r5c2','r6c1'] },
];

function calcBingoScore(completedTileIds) {
  const tilePoints = completedTileIds.reduce((s, id) => s + (BINGO_TILES.find(t => t.id === id)?.value || 0), 0);
  const doneLines = BINGO_LINES.filter(line => line.tiles.every(tid => completedTileIds.includes(tid)));
  return { tilePoints, lineBonus: doneLines.length, total: tilePoints + doneLines.length, doneLines };
}

// --- Bingo Board Image Generation ---
function drawCheckmark(ctx, cx, cy, size, color, lineWidth) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = lineWidth * 2;
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.5, cy + size * 0.05);
  ctx.lineTo(cx - size * 0.05, cy + size * 0.48);
  ctx.lineTo(cx + size * 0.55, cy - size * 0.45);
  ctx.stroke();
  ctx.restore();
}

async function generateBingoImage(filterTeam) {
  const COLS = 6, ROWS = 6;
  const teams = await BingoTeam.find();
  const completions = await BingoCompletion.find().populate('teamId', 'name color');

  const boardPath = path.join(__dirname, 'bingo-board.png');
  const img = await loadImage(boardPath);

  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const cw = img.width / COLS;
  const rh = img.height / ROWS;

  if (filterTeam) {
    const color = filterTeam.color || '#00ff00';
    const teamComps = completions.filter(c => c.teamId?._id?.toString() === filterTeam._id.toString());
    for (const comp of teamComps) {
      const tile = BINGO_TILES.find(t => t.id === comp.tileId);
      if (!tile) continue;
      const cx = (tile.col - 1) * cw + cw / 2;
      const cy = (tile.row - 1) * rh + (rh * tile.rowSpan) / 2;
      const size = Math.min(cw, rh * tile.rowSpan) * 0.52;
      drawCheckmark(ctx, cx, cy, size, color, Math.max(7, size * 0.16));
    }
  } else {
    for (const tile of BINGO_TILES) {
      const tileComps = completions.filter(c => c.tileId === tile.id);
      if (!tileComps.length) continue;

      const tx = (tile.col - 1) * cw;
      const ty = (tile.row - 1) * rh;
      const th = rh * tile.rowSpan;
      const n = tileComps.length;

      const maxSize = Math.min(cw, th) * 0.3;
      const spacing = Math.min(maxSize * 1.4, (cw * 0.85) / n);
      const size = Math.min(maxSize, spacing * 0.72);
      const lineW = Math.max(3, size * 0.13);

      const totalW = (n - 1) * spacing;
      const startX = tx + cw / 2 - totalW / 2;
      const centerY = ty + th / 2;

      tileComps.forEach((comp, i) => {
        const team = teams.find(t => t._id.toString() === comp.teamId?._id?.toString());
        const color = team?.color || '#ffffff';
        drawCheckmark(ctx, startX + i * spacing, centerY, size, color, lineW);
      });
    }
  }

  return canvas.toBuffer('image/png');
}

// --- Ready ---
client.once('ready', async () => {
  console.log(`${client.user.tag} is online and ready!`);
  await getSettings();
  await seedCommands();
  setInterval(() => refreshCommandNames().catch(() => {}), 60000);

  // Register slash commands in every guild
  for (const [guildId] of client.guilds.cache) {
    await registerSlashCommands(client.user.id, guildId);
  }

  const channelId = process.env.DAILY_CHANNEL_ID;
  if (!channelId) {
    console.warn("DAILY_CHANNEL_ID not set — skipping channel messages.");
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    const leaderboard = await buildLeaderboard();
    const xpLeaderboard = await buildXpLeaderboard();
    channel.send(`✅ **Bot is online!**\n${leaderboard}\n\n${xpLeaderboard}`);
  } catch (err) {
    console.error("Failed to post startup message:", err);
  }

  cron.schedule("59 23 * * *", async () => {
    try {
      const channel = await client.channels.fetch(channelId);
      const leaderboard = await buildLeaderboard();
      const xpLeaderboard = await buildXpLeaderboard();
      channel.send(`📅 **Daily Summary**\n${leaderboard}\n\n${xpLeaderboard}`);
    } catch (err) {
      console.error("Failed to post daily leaderboard:", err);
    }

    try {
      const result = await syncWomMembers();
      if (result.error) {
        console.log(`[WOM] Sync skipped: ${result.error}`);
      } else {
        console.log(`[WOM] Daily sync complete. ${result.updated} updated / ${result.total} clan members.`);
      }
    } catch (err) {
      console.error("WOM daily sync error:", err.message);
    }
  });

  // WOM activity feed — poll every 10 minutes
  setInterval(() => checkWomActivity(client).catch(() => {}), 10 * 60 * 1000);
  checkWomActivity(client).catch(() => {}); // seed the timestamp on startup

  // Daily rank-up check at noon UTC
  cron.schedule("0 12 * * *", async () => {
    try {
      const guild = client.guilds.cache.first();
      const count = await checkRankUps(guild);
      console.log(`[Ranks] Daily check complete. ${count} rank-up notification(s) sent.`);
    } catch (err) {
      console.error("Daily rank check error:", err);
    }
  });


  // Auto-award Droptracker top 10 XP at midnight on 1st of each month
  cron.schedule("0 0 1 * *", async () => {
    try {
      const s = await getSettings();
      const notifyChannelId = s.rankNotifyChannelId || XP_CHANNEL_ID;
      const channel = await client.channels.fetch(notifyChannelId);
      const guild = client.guilds.cache.first();

      channel.send("⏳ **Monthly Droptracker Awards** — fetching last month's top 10...");

      const result = await getDroptrackerTopPlayers(null, 10);
      if (result.error) {
        channel.send(`❌ Monthly auto-award failed: ${result.error}`);
        return;
      }

      const players = Array.isArray(result.data) ? result.data
        : (result.data.players || result.data.members || []);
      if (!players.length) {
        channel.send("❌ Monthly auto-award: no Droptracker data returned.");
        return;
      }

      await awardDropTopXp(players, guild, channel);
    } catch (err) {
      console.error("Monthly auto-award error:", err);
    }
  });

  console.log("Daily leaderboard + rank check scheduled.");
});

function hasVisionariesRole(member) {
  return member && member.roles.cache.some(r => r.name.toLowerCase() === 'visionaries');
}

async function sendLongMessage(channel, header, lines) {
  const chunks = [];
  let current = header + '\n';
  for (const line of lines) {
    if ((current + line + '\n').length > 1900) {
      chunks.push(current);
      current = line + '\n';
    } else {
      current += line + '\n';
    }
  }
  if (current.trim()) chunks.push(current);
  for (const chunk of chunks) await channel.send(chunk);
}

// --- Message Handler ---
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // XP for chatting — Visionaries role only
  try {
    if (hasVisionariesRole(message.member)) {
      const s = await getSettings();
      const user = await getUser(message.author.id, message.author.username, message.member);
      const now = new Date();

      if (!user.lastMessageXp || (now - user.lastMessageXp) > s.messageXpCooldownSecs * 1000) {
        const xpGained = Math.floor(Math.random() * (s.messageXpMax - s.messageXpMin + 1)) + s.messageXpMin;
        const prevLevel = user.level;
        const updated = await addXp(message.author.id, message.author.username, xpGained);
        await User.updateOne({ userId: message.author.id }, { lastMessageXp: now });
        console.log(`[XP] ${message.author.username} earned ${xpGained} XP. Level ${updated.level} | ${updated.xp} XP`);
        if (updated.level > prevLevel) sendToXpChannel(getLevelUpMessage(message.author.username, updated.level));
      }
    }
  } catch (err) {
    console.error("Message XP error:", err);
  }

  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === cmd('lp')) {
    const user = message.mentions.users.first() || message.author;
    const balance = await getLootPoints(user.id, user.username);
    message.channel.send(`${user.username} has ${balance} LP`);
  }

  if (command === cmd('xp')) {
    const target = message.mentions.users.first() || message.author;
    const user = await getUser(target.id, target.username);
    message.channel.send(`⭐ ${target.username} — **Level ${user.level}** | ${user.xp}/${xpForLevel(user.level)} XP`);
  }

  if (command === cmd('level')) {
    const target = message.mentions.users.first() || message.author;
    const user = await getUser(target.id, target.username);
    message.channel.send(`🏅 ${target.username} is **Level ${user.level}** — ${user.xp}/${xpForLevel(user.level)} XP to next level`);
  }

  if (command === cmd('leaderboard') || command === cmd('xptop')) {
    message.channel.send(await buildXpLeaderboard());
  }

  if (command === cmd('total')) {
    message.channel.send(await buildLeaderboard());
  }

  // !lplist → full LP list A-Z
  if (command === cmd('lplist')) {
    const users = await User.find({ lootPoints: { $gt: 0 } }).sort({ username: 1 });
    if (users.length === 0) return message.channel.send("No loot points recorded yet!");
    const lines = users.map(u => `• ${u.username || u.userId} — ${u.lootPoints} LP`);
    await sendLongMessage(message.channel, `🏆 **LP List (A–Z) — ${users.length} members**`, lines);
  }

  // !xplist → full XP/level list A-Z
  if (command === cmd('xplist')) {
    const users = await User.find({ $or: [{ level: { $gt: 0 } }, { xp: { $gt: 0 } }] }).sort({ username: 1 });
    if (users.length === 0) return message.channel.send("No XP recorded yet!");
    const lines = users.map(u => `• ${u.username || u.userId} — Level ${u.level} | ${u.xp}/${xpForLevel(u.level)} XP`);
    await sendLongMessage(message.channel, `⭐ **XP List (A–Z) — ${users.length} members**`, lines);
  }

  if (command === cmd('rslink')) {
    const rsName = args.join(' ').trim();
    if (!rsName) return message.reply("Usage: `!rslink YourRuneScapeName`");
    const existing = await User.findOne({
      userId: { $ne: message.author.id },
      $or: [
        { rsName: { $regex: new RegExp(`^${rsName}$`, 'i') } },
        { rsNames: new RegExp(`^${rsName}$`, 'i') },
      ],
    });
    if (existing) return message.reply(`❌ The RS name **${rsName}** is already linked to another account.`);
    const currentUser = await User.findOne({ userId: message.author.id });
    const hasNames = currentUser?.rsNames?.length > 0 || !!currentUser?.rsName;
    const alreadyHas = currentUser?.rsNames?.some(n => n.toLowerCase() === rsName.toLowerCase());
    const setFields = { username: message.author.username };
    if (!hasNames) {
      // First RS name: set as primary and record join date
      setFields.rsName = rsName;
      if (!currentUser?.joinedClanAt) setFields.joinedClanAt = new Date();
    }
    const update = { $set: setFields };
    if (!alreadyHas) update.$push = { rsNames: rsName }; // always appends to back
    await User.findOneAndUpdate({ userId: message.author.id }, update, { upsert: true, new: true });
    message.reply(`✅ RS name **${rsName}** linked! Use \`!myrs\` to see all your linked names.`);
  }

  if (command === cmd('rsunlink')) {
    const rsName = args.join(' ').trim();
    if (!rsName) return message.reply("Usage: `!rsunlink YourRuneScapeName`");
    const user = await User.findOne({ userId: message.author.id });
    if (!user || !user.rsNames?.length) return message.reply("You have no linked RS names.");
    const idx = user.rsNames.findIndex(n => n.toLowerCase() === rsName.toLowerCase());
    if (idx === -1) return message.reply(`❌ **${rsName}** is not linked to your account.`);
    user.rsNames.splice(idx, 1);
    user.rsName = user.rsNames[user.rsNames.length - 1] || null;
    await user.save();
    message.reply(`✅ RS name **${rsName}** unlinked.`);
  }

  if (command === cmd('myrs')) {
    const user = await getUser(message.author.id, message.author.username);
    const names = user.rsNames?.length ? user.rsNames : (user.rsName ? [user.rsName] : []);
    if (!names.length) return message.reply("You haven't linked any RS names yet. Use `!rslink YourRsName`");
    message.reply(`Your linked RS name(s): ${names.map(n => `**${n}**`).join(', ')}`);
  }

  if (command === cmd('rsnames')) {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    const users = await User.find({
      $or: [{ rsNames: { $exists: true, $not: { $size: 0 } } }, { rsName: { $ne: null } }]
    }).sort({ username: 1 });
    if (users.length === 0) return message.channel.send("No RS names linked yet.");
    const lines = users.map(u => {
      const names = u.rsNames?.length ? u.rsNames : (u.rsName ? [u.rsName] : []);
      return `• ${names.map(n => `**${n}**`).join(', ')} → ${u.username || u.userId}`;
    });
    await sendLongMessage(message.channel, `📋 **Linked RS Names (${users.length} members):**`, lines);
  }

  if (command === cmd('rsset')) {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    const target = message.mentions.users.first();
    const rsName = args.slice(1).join(' ').trim();
    if (!target || !rsName) return message.reply("Usage: `!rsset @user RsName`");
    const targetUser = await User.findOne({ userId: target.id });
    const targetHasNames = targetUser?.rsNames?.length > 0 || !!targetUser?.rsName;
    const targetAlreadyHas = targetUser?.rsNames?.some(n => n.toLowerCase() === rsName.toLowerCase());
    const setFields2 = { username: target.username };
    if (!targetHasNames) {
      setFields2.rsName = rsName;
      if (!targetUser?.joinedClanAt) setFields2.joinedClanAt = new Date();
    }
    const update2 = { $set: setFields2 };
    if (!targetAlreadyHas) update2.$push = { rsNames: rsName };
    await User.findOneAndUpdate({ userId: target.id }, update2, { upsert: true, new: true });
    message.channel.send(`✅ Linked **${rsName}** to ${target.username}`);
  }

  if (command === cmd('droptop')) {
    if (!message.member.permissions.has('Administrator') && !isMod(message.member))
      return message.reply("❌ Mods only.");
    const processingMsg = await message.channel.send("⏳ Fetching DropTracker leaderboard...");
    const npcName = args.join(' ').trim() || null;
    const result = await getDroptrackerTopPlayers(npcName, 10);
    await processingMsg.delete().catch(() => {});
    if (result.error) return message.channel.send(`❌ ${result.error}`);
    const players = Array.isArray(result.data) ? result.data : (result.data.players || result.data.members || []);
    if (!players.length) return message.channel.send("❌ No players found in Droptracker.");
    const preview = players.slice(0, 10).map((p, i) => `${i + 1}. ${p.player_name || p.name || p.username || '?'}`).join('\n');
    await message.channel.send(`📋 **DropTracker Rankings:**\n${preview}\n\nAwarding XP now...`);
    await awardDropTopXp(players, message.guild, message.channel);
  }

  if (command === cmd('toploot')) {
    const npcName = args.join(' ').trim() || null;
    const processingMsg = await message.channel.send("⏳ Fetching loot leaderboard...");
    const result = await getDroptrackerTopPlayers(npcName, 10);
    await processingMsg.delete().catch(() => {});
    if (result.error) return message.channel.send(`❌ ${result.error}`);
    const players = Array.isArray(result.data) ? result.data : (result.data.players || result.data.members || []);
    if (!players.length) return message.channel.send("No loot data found.");
    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    const title = npcName ? `🏆 **Top ${npcName} Looters**` : `🏆 **Top Looters (Last 30 Days)**`;
    const lines = players.slice(0, 10).map((p, i) => {
      const name = p.player_name || p.name || p.username || '?';
      const gp = formatGp(p.total_value || p.total_gp || p.gp_gained || 0);
      const drops = p.drop_count || p.total_drops || '';
      return `${medals[i] || `${i+1}.`} **${name}** — ${gp} GP${drops ? ` (${drops} drops)` : ''}`;
    });
    message.channel.send(`${title}\n${lines.join('\n')}`);
  }

  if (command === cmd('bingoscore')) {
    const teams = await BingoTeam.find().sort({ order: 1, createdAt: 1 });
    const completions = await BingoCompletion.find().populate('teamId', 'name color');
    if (!teams.length) return message.channel.send("❌ No bingo teams set up. Configure teams in the dashboard.");

    const filterTeam = args.join(' ').trim().toLowerCase();
    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣'];

    const scores = teams.map(team => {
      const comps = completions.filter(c => c.teamId?._id?.toString() === team._id.toString());
      const tileIds = comps.map(c => c.tileId);
      const { tilePoints, lineBonus, total, doneLines } = calcBingoScore(tileIds);
      return { team, tilePoints, lineBonus, total, tileCount: comps.length, doneLines };
    }).sort((a, b) => b.total - a.total);

    const maxTotal = BINGO_TOTAL_POINTS + BINGO_LINES.length;

    if (filterTeam) {
      const found = scores.find(s => s.team.name.toLowerCase().includes(filterTeam));
      if (!found) return message.channel.send(`❌ Team not found. Teams: ${teams.map(t => t.name).join(', ')}`);
      const comps = completions.filter(c => c.teamId?._id?.toString() === found.team._id.toString());
      const done = comps.map(c => BINGO_TILES.find(t => t.id === c.tileId)).filter(Boolean);
      const todo = BINGO_TILES.filter(t => !comps.find(c => c.tileId === t.id));
      const lineEmoji = { row: '➡️', col: '⬇️', diag: '↗️' };
      const lines = [
        `🎯 **${found.team.name} — Bingo Progress**`,
        `**Score: ${found.total} pts** (${found.tilePoints} tiles + ${found.lineBonus} line bonus${found.lineBonus!==1?'es':''})`,
        ``,
        `✅ **Completed (${done.length}):** ${done.map(t => `${t.name}${t.value>1?' ×2':''}`).join(', ') || 'none'}`,
        ``,
        found.doneLines.length ? `🎉 **Lines completed:** ${found.doneLines.map(l => `${lineEmoji[l.type]||'📏'} ${l.label}`).join(', ')}` : `📏 **Lines completed:** none yet`,
        ``,
        `⬜ **Remaining (${todo.length}):** ${todo.map(t => t.name).join(', ')}`,
      ];
      try {
        const imgBuffer = await generateBingoImage(found.team);
        await message.channel.send({
          content: lines.join('\n'),
          files: [{ attachment: imgBuffer, name: 'bingo-progress.png' }],
        });
      } catch (e) {
        console.error('Bingo image error:', e);
        await sendLongMessage(message.channel, '', lines);
      }
    } else {
      const lines = [
        `🎯 **Bingo Leaderboard** (max ${maxTotal} pts: ${BINGO_TOTAL_POINTS} tiles + ${BINGO_LINES.length} lines)`,
        ``,
        ...scores.map((s, i) => `${medals[i]||`${i+1}.`} **${s.team.name}** — ${s.total} pts  *(${s.tilePoints} tiles + ${s.lineBonus} line${s.lineBonus!==1?'s':''})*`),
      ];
      try {
        const imgBuffer = await generateBingoImage(null);
        await message.channel.send({
          content: lines.join('\n'),
          files: [{ attachment: imgBuffer, name: 'bingo-board.png' }],
        });
      } catch (e) {
        console.error('Bingo image error:', e);
        message.channel.send(lines.join('\n'));
      }
    }
  }

  // !bingo-submit [note] — player attaches image, bot posts to review channel
  if (command === cmd('bingosubmit')) {
    const s = await getSettings();
    const reviewChannelId = String(s.bingoReviewChannelId || '').trim();
    if (!reviewChannelId) return message.reply('❌ No bingo review channel set. Ask an admin to configure it in the dashboard.');

    const attachment = message.attachments.first();
    if (!attachment || !attachment.contentType?.startsWith('image/')) {
      return message.reply('❌ Please attach an image to your submission.');
    }

    const note = args.join(' ').trim();
    const sub = await BingoSubmission.create({
      tileId: 'pending',
      teamId: new mongoose.Types.ObjectId('000000000000000000000001'), // placeholder — assigned on approve
      submittedBy: message.author.tag,
      submittedById: message.author.id,
      imageUrl: attachment.url,
      note,
      status: 'pending',
    });

    const reviewChannel = await client.channels.fetch(reviewChannelId).catch(() => null);
    if (!reviewChannel) return message.reply('❌ Could not find review channel. Ask an admin to check the channel ID.');

    const reviewMsg = await reviewChannel.send({
      content: [
        `📥 **Bingo Submission** — ID: \`${sub._id}\``,
        `**From:** ${message.author} (${message.author.tag})`,
        note ? `**Note:** ${note}` : null,
        ``,
        `Mods: reply to this with \`!bingo-approve <team> | <tile>\` or \`!bingo-reject [reason]\``,
      ].filter(Boolean).join('\n'),
      files: [attachment.url],
    });

    await BingoSubmission.findByIdAndUpdate(sub._id, { reviewMessageId: reviewMsg.id });
    await message.react('✅');
    await message.reply(`📥 Your submission has been posted for mod review!`);
    return;
  }

  // !bingo-approve <team> | <tile> — mod replies to a review message
  if (command === cmd('bingoapprove')) {
    if (!message.member.permissions.has('Administrator') && !isMod(message.member))
      return message.reply('❌ Mods only.');

    const full = args.join(' ');
    const [teamPart, tilePart] = full.split('|').map(s => s.trim());
    if (!teamPart || !tilePart) return message.reply('❌ Usage: `!bingo-approve <team> | <tile>` (reply to the submission message)');

    // Find the submission from the replied-to message
    const ref = message.reference;
    let sub = null;
    if (ref?.messageId) {
      sub = await BingoSubmission.findOne({ reviewMessageId: ref.messageId, status: 'pending' });
    }
    if (!sub) return message.reply('❌ Reply directly to the submission message in the review channel, and make sure it\'s still pending.');

    // Match team
    const teams = await BingoTeam.find();
    const team = teams.find(t => t.name.toLowerCase().includes(teamPart.toLowerCase()));
    if (!team) return message.reply(`❌ Team not found. Teams: ${teams.map(t => t.name).join(', ')}`);

    // Match tile
    const tile = BINGO_TILES.find(t =>
      t.name.toLowerCase().includes(tilePart.toLowerCase()) || t.id === tilePart.toLowerCase()
    );
    if (!tile) return message.reply(`❌ Tile not found: "${tilePart}". Check the tile name.`);

    // For multi-step tiles: complete all remaining steps + tile
    const tileConfig = await BingoTileConfig.findOne({ tileId: tile.id }).lean();
    if (tileConfig && tileConfig.steps.length > 0) {
      await BingoProgress.findOneAndUpdate(
        { tileId: tile.id, teamId: team._id },
        { $set: { completedSteps: tileConfig.steps } },
        { upsert: true, new: true }
      );
    }

    // Mark tile complete
    const alreadyDone = await BingoCompletion.findOne({ tileId: tile.id, teamId: team._id });
    if (!alreadyDone) {
      await BingoCompletion.create({ tileId: tile.id, teamId: team._id, completedBy: sub.submittedBy });
    }

    // Update submission
    await BingoSubmission.findByIdAndUpdate(sub._id, {
      tileId: tile.id,
      teamId: team._id,
      status: 'approved',
      reviewedBy: message.author.tag,
    });

    const stepNote = tileConfig && tileConfig.steps.length > 0 ? ` (all ${tileConfig.steps.length} steps marked complete)` : '';
    await message.reply(`✅ Approved! **${tile.name}** assigned to **${team.name}**${stepNote} — submitted by ${sub.submittedBy}.\n💡 Use \`/bingo-approve\` to approve individual steps instead of the full tile.`);

    // DM the submitter
    const submitter = await client.users.fetch(sub.submittedById).catch(() => null);
    if (submitter) {
      submitter.send(`✅ Your bingo submission was approved! **${tile.name}** has been marked complete for **${team.name}**.`).catch(() => {});
    }
    return;
  }

  // !bingo-reject [reason] — mod replies to a review message
  if (command === cmd('bingoreject')) {
    if (!message.member.permissions.has('Administrator') && !isMod(message.member))
      return message.reply('❌ Mods only.');

    const ref = message.reference;
    let sub = null;
    if (ref?.messageId) {
      sub = await BingoSubmission.findOne({ reviewMessageId: ref.messageId, status: 'pending' });
    }
    if (!sub) return message.reply('❌ Reply directly to the submission message in the review channel, and make sure it\'s still pending.');

    const reason = args.join(' ').trim() || 'No reason given.';
    await BingoSubmission.findByIdAndUpdate(sub._id, { status: 'rejected', reviewedBy: message.author.tag });
    await message.reply(`❌ Submission rejected. Reason: ${reason}`);

    const submitter = await client.users.fetch(sub.submittedById).catch(() => null);
    if (submitter) {
      submitter.send(`❌ Your bingo submission was rejected. Reason: **${reason}**`).catch(() => {});
    }
    return;
  }

  if (command === cmd('drops')) {
    const npcName = args.join(' ').trim() || null;
    const processingMsg = await message.channel.send("⏳ Fetching recent drops...");
    const result = await getDroptrackerDrops(npcName, 10);
    await processingMsg.delete().catch(() => {});
    if (result.error) return message.channel.send(`❌ ${result.error}`);
    const drops = Array.isArray(result.data) ? result.data : (result.data.drops || result.data.items || []);
    if (!drops.length) return message.channel.send("No recent drops found.");
    const title = npcName ? `💰 **Recent ${npcName} Drops**` : `💰 **Recent Drops**`;
    const lines = drops.slice(0, 10).map(d => {
      const player = d.player_name || d.player || d.username || '?';
      const item = d.item_name || d.name || '?';
      const qty = d.quantity > 1 ? ` x${d.quantity}` : '';
      const gp = formatGp(d.value || d.item_value || 0);
      const npc = d.npc_name ? ` from ${d.npc_name}` : '';
      return `• **${player}** — ${item}${qty}${npc} (${gp} GP)`;
    });
    message.channel.send(`${title}\n${lines.join('\n')}`);
  }

  if (command === cmd('syncdroptracker')) {
    if (!message.member.permissions.has('Administrator') && !isMod(message.member))
      return message.reply("❌ Mods only.");
    const msg = await message.channel.send("⏳ Syncing Droptracker members...");
    const result = await syncDroptrackerMembers();
    if (result.error) { await msg.delete().catch(() => {}); return message.channel.send(`❌ ${result.error}`); }
    const linkNote = result.linked ? ` (${result.linked} RS name(s) auto-linked from Discord)` : '';
    msg.edit(`✅ Droptracker sync complete — ${result.updated} user(s) updated out of ${result.total} members${linkNote}.`);
  }

  if (command === cmd('testaward')) {
    if (!message.member.permissions.has('Administrator') && !isMod(message.member))
      return message.reply("❌ Mods only.");
    await message.channel.send("⏳ **Test Monthly Award** — fetching Droptracker top 10...");
    const result = await getDroptrackerTopPlayers(null, 10);
    if (result.error) return message.channel.send(`❌ ${result.error}`);
    const players = Array.isArray(result.data) ? result.data
      : (result.data.players || result.data.members || []);
    if (!players.length) return message.channel.send("❌ No Droptracker data returned.");
    await awardDropTopXp(players, message.guild, message.channel);
  }

  if (command === cmd('split')) {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !split amount @users");
    const lines = [];
    for (const user of users.values()) {
      const newBalance = await modifyLootPoints(user.id, user.username, amount);
      lines.push(`${user.username} received ${amount} LP — now has ${newBalance} LP`);
    }
    message.channel.send(`💰 **Split:**\n${lines.join("\n")}`);
  }

  if (command === cmd('donate')) {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !donate amount @users");
    const halfAmount = Math.floor(amount / 2);
    const lines = [];
    for (const user of users.values()) {
      const newBalance = await modifyLootPoints(user.id, user.username, halfAmount);
      lines.push(`${user.username} received ${halfAmount} LP — now has ${newBalance} LP`);
    }
    message.channel.send(`💖 **Donate:**\n${lines.join("\n")}`);
  }

  if (command === cmd('add')) {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !add amount @user");
    const lines = [];
    for (const user of users.values()) {
      const newBalance = await modifyLootPoints(user.id, user.username, amount);
      lines.push(`✅ Added ${amount} LP to ${user.username}. Now has ${newBalance} LP.`);
    }
    message.channel.send(lines.join("\n"));
  }

  if (command === cmd('remove')) {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !remove amount @user");
    const lines = [];
    for (const user of users.values()) {
      const newBalance = await modifyLootPoints(user.id, user.username, -amount);
      lines.push(`❌ Removed ${amount} LP from ${user.username}. Now has ${newBalance} LP.`);
    }
    message.channel.send(lines.join("\n"));
  }

  if (command === cmd('addxp')) {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !addxp amount @user");
    const lines = [];
    for (const user of users.values()) {
      const updated = await addXp(user.id, user.username, amount);
      lines.push(`✅ Added ${amount} XP to ${user.username}. Now Level ${updated.level} (${updated.xp} XP).`);
    }
    message.channel.send(lines.join("\n"));
  }

  if (command === cmd('removexp')) {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !removexp amount @user");
    const lines = [];
    for (const user of users.values()) {
      const u = await getUser(user.id, user.username);
      u.xp = Math.max(0, u.xp - amount);
      await u.save();
      lines.push(`❌ Removed ${amount} XP from ${user.username}. Now Level ${u.level} (${u.xp} XP).`);
    }
    message.channel.send(lines.join("\n"));
  }

  if (command === cmd('fixlp')) {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    const lpData = [
      { username: '_valkan',     lootPoints: 893 },
      { username: 'hades_7444',  lootPoints: 488 },
      { username: 'gaz1188',     lootPoints: 387 },
      { username: 'artemas5936', lootPoints: 8   },
      { username: 'teamflight',  lootPoints: 6   },
      { username: 'slacks96',    lootPoints: 6   },
      { username: 'trapbunnies', lootPoints: 6   },
    ];
    const lines = [];
    for (const entry of lpData) {
      const result = await User.findOneAndUpdate(
        { username: entry.username },
        { $set: { lootPoints: entry.lootPoints } },
        { new: true }
      );
      lines.push(result ? `✅ ${entry.username} → ${entry.lootPoints} LP` : `⚠️ ${entry.username} not found`);
    }
    return message.channel.send(`**LP Restore Complete:**\n${lines.join('\n')}`);
  }

  if (command === cmd('cleanduplicates')) {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    const result = await User.deleteMany({ userId: { $regex: /^migrated_/ } });
    return message.channel.send(`✅ Removed **${result.deletedCount}** duplicate entries.`);
  }

  if (command === cmd('importmee6')) {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    await message.channel.send("⏳ Fetching MEE6 leaderboard...");
    try {
      const guildId = message.guild.id;
      let page = 0, allPlayers = [], hasMore = true;
      while (hasMore) {
        const res = await fetch(`https://mee6.xyz/api/plugins/levels/leaderboard/${guildId}?limit=1000&page=${page}`);
        if (!res.ok) return message.channel.send(`❌ MEE6 fetch failed (${res.status}).`);
        const data = await res.json();
        const players = data.players || [];
        allPlayers = allPlayers.concat(players);
        hasMore = players.length === 1000;
        page++;
      }
      if (allPlayers.length === 0) return message.channel.send("❌ No players found.");
      for (const player of allPlayers) {
        const mee6Xp = player.detailed_xp ? player.detailed_xp[0] : (player.xp || 0);
        await User.findOneAndUpdate(
          { userId: player.id },
          { $set: { userId: player.id, username: player.username, level: player.level || 0, xp: mee6Xp } },
          { upsert: true, new: true }
        );
      }
      message.channel.send(`✅ Imported **${allPlayers.length} users** from MEE6!`);
    } catch (err) {
      console.error("MEE6 import error:", err);
      message.channel.send("❌ Something went wrong importing from MEE6.");
    }
  }

  if (command === cmd('syncwom') && isMod(message.member)) {
    message.channel.send("⏳ Syncing clan join dates from WiseOldMan...");
    try {
      const result = await syncWomMembers();
      if (result.error) {
        message.channel.send(`⚠️ ${result.error} — set your WOM Group ID in the dashboard first.`);
      } else {
        message.channel.send(`✅ WOM sync complete! **${result.updated}** user(s) updated out of **${result.total}** clan members.`);
      }
    } catch (err) {
      console.error("!syncwom error:", err);
      message.channel.send(`❌ WOM sync failed: ${err.message}`);
    }
  }

  if (command === cmd('checkranks') && isMod(message.member)) {
    message.channel.send("🔍 Checking rank-ups...");
    try {
      const guild = message.guild;
      const count = await checkRankUps(guild);
      message.channel.send(`✅ Rank check complete. **${count}** new rank-up notification(s) sent.`);
    } catch (err) {
      console.error("!checkranks error:", err);
      message.channel.send("❌ Error during rank check.");
    }
  }

  if (command === cmd('help')) {
    const s = await getSettings();
    const allCmds = await CommandConfig.find({}).sort({ category: 1, key: 1 });
    const groups = {};
    for (const c of allCmds) {
      if (!groups[c.category]) groups[c.category] = [];
      groups[c.category].push(c);
    }
    const catEmoji = { 'XP & Levels': '⭐', 'Loot Points': '💰', 'RS Names': '⚔️', 'Admin': '🔧', 'General': '📖' };
    let helpText = `📖 **Visionary Bot Commands**\n`;
    for (const [cat, list] of Object.entries(groups)) {
      helpText += `\n**${catEmoji[cat] || '•'} ${cat}**\n`;
      for (const c of list) {
        helpText += `\`!${c.name}\` — ${c.description}\n`;
      }
    }
    helpText += `\n📊 **Current XP Rates**\nMessage XP: ${s.messageXpMin}–${s.messageXpMax} XP (${s.messageXpCooldownSecs}s cooldown)\nVoice Join: ${s.voiceJoinXp} XP | Voice Activity: ${s.voiceIntervalXp} XP / ${s.voiceIntervalMins} mins`;
    message.channel.send(helpText);
  }
});

// --- Slash Commands ---
client.on(Events.InteractionCreate, async interaction => {
  // Autocomplete
  if (interaction.isAutocomplete()) {
    const { commandName, options } = interaction;
    const focused = options.getFocused(true);

    if (commandName === 'bingo-approve' || commandName === 'bingo-reject') {
      if (focused.name === 'submission') {
        const subs = await BingoSubmission.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(25);
        const choices = subs.map(s => ({
          name: `${s.submittedBy} — ${new Date(s.createdAt).toLocaleDateString()} ${new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${s.note ? ' · ' + s.note.slice(0, 30) : ''}`,
          value: s._id.toString(),
        })).filter(c => c.name.toLowerCase().includes(focused.value.toLowerCase()));
        return interaction.respond(choices.slice(0, 25));
      }
      if (focused.name === 'tile' && commandName === 'bingo-approve') {
        const choices = BINGO_TILES
          .filter(t => t.name.toLowerCase().includes(focused.value.toLowerCase()))
          .slice(0, 25)
          .map(t => ({ name: t.name + (t.value > 1 ? ` (×${t.value})` : ''), value: t.id }));
        return interaction.respond(choices);
      }
      if (focused.name === 'team' && commandName === 'bingo-approve') {
        const teams = await BingoTeam.find();
        const choices = teams
          .filter(t => t.name.toLowerCase().includes(focused.value.toLowerCase()))
          .slice(0, 25)
          .map(t => ({ name: t.name, value: t._id.toString() }));
        return interaction.respond(choices);
      }
    }
    return interaction.respond([]);
  }

  // --- Step select menu (multi-step bingo approve) ---
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bingo_steps:')) {
    const parts = interaction.customId.split(':');
    const subId = parts[1];
    const tileId = parts[2];
    const teamId = parts[3];
    const selectedSteps = interaction.values;

    await interaction.deferUpdate();

    const tileConfig = await BingoTileConfig.findOne({ tileId }).lean();
    const tile = BINGO_TILES.find(t => t.id === tileId);
    const team = await BingoTeam.findById(teamId).catch(() => null);

    // Merge selected steps with existing progress
    let prog = await BingoProgress.findOne({ tileId, teamId }).lean();
    const existing = prog?.completedSteps || [];
    const merged = [...new Set([...existing, ...selectedSteps])];

    await BingoProgress.findOneAndUpdate(
      { tileId, teamId },
      { $set: { completedSteps: merged } },
      { upsert: true, new: true }
    );

    // Auto-complete tile if all steps done
    const allDone = tileConfig && tileConfig.steps.every(s => merged.includes(s));
    if (allDone) {
      const sub = await BingoSubmission.findById(subId).catch(() => null);
      const already = await BingoCompletion.findOne({ tileId, teamId });
      if (!already) await BingoCompletion.create({ tileId, teamId, completedBy: sub?.submittedBy || '' });
    }

    // Mark submission approved
    const sub = await BingoSubmission.findById(subId).catch(() => null);
    if (sub && sub.status === 'pending') {
      await BingoSubmission.findByIdAndUpdate(subId, {
        tileId, teamId, status: 'approved', reviewedBy: interaction.user.tag,
      });
      const submitter = await client.users.fetch(sub.submittedById).catch(() => null);
      if (submitter) {
        const msg = allDone
          ? `✅ Your bingo submission was approved! **${tile?.name}** is now fully complete for **${team?.name}**.`
          : `✅ Your bingo submission was approved! ${selectedSteps.length} step(s) marked on **${tile?.name}** for **${team?.name}**.`;
        submitter.send(msg).catch(() => {});
      }
    }

    const totalSteps = tileConfig?.steps.length || 0;
    await interaction.editReply({
      content: [
        `✅ Marked **${selectedSteps.length}** step(s) on **${tile?.name}** for **${team?.name}**:`,
        selectedSteps.map(s => `• ${s}`).join('\n'),
        '',
        allDone
          ? `🎉 All ${totalSteps} steps done — tile fully completed!`
          : `📊 ${merged.length}/${totalSteps} steps done.`,
      ].join('\n'),
      components: [],
    });
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, options, user, member } = interaction;

  // /bingo-submit
  if (commandName === 'bingo-submit') {
    const s = await getSettings();
    const reviewChannelId = String(s.bingoReviewChannelId || '').trim();
    if (!reviewChannelId) return interaction.reply({ content: '❌ No bingo review channel set. Ask an admin to configure it in the dashboard.', ephemeral: false });

    const attachment = options.getAttachment('image');
    const link = options.getString('link') || '';
    const note = options.getString('note') || '';
    const imageUrl = attachment?.url || link;

    if (!imageUrl) return interaction.reply({ content: '❌ Please attach a screenshot or paste an image link (Gyazo, Imgur, etc.).', ephemeral: false });

    await interaction.deferReply({ ephemeral: false });

    const sub = await BingoSubmission.create({
      tileId: 'pending',
      teamId: new mongoose.Types.ObjectId('000000000000000000000001'),
      submittedBy: user.tag,
      submittedById: user.id,
      imageUrl,
      note,
      status: 'pending',
    });

    const reviewChannel = await client.channels.fetch(reviewChannelId).catch(() => null);
    if (!reviewChannel) return interaction.editReply('❌ Could not find review channel. Ask an admin to check the channel ID.');

    const embed = new EmbedBuilder()
  .setColor(0x2b8cff)
  .setTitle('📥 New Bingo Submission')
  .addFields(
    {
      name: 'Submitted By',
      value: `${user} (${user.tag})`,
      inline: false,
    },
    {
      name: 'Submission ID',
      value: `\`${sub._id}\``,
      inline: false,
    }
  )
  .setFooter({
    text: 'Use /bingo-approve or /bingo-reject to review this submission.',
  });

if (note) {
  embed.addFields({
    name: 'Note',
    value: note,
    inline: false,
  });
}

embed.setImage(imageUrl);

const reviewMsg = await reviewChannel.send({
  embeds: [embed],
});

    await BingoSubmission.findByIdAndUpdate(sub._id, { reviewMessageId: reviewMsg.id });
    return interaction.editReply('📥 Your screenshot has been submitted for mod review!');
  }

  // /bingo-approve
  if (commandName === 'bingo-approve') {
    if (!member.permissions.has('Administrator') && !isMod(member))
      return interaction.reply({ content: '❌ Mods only.', ephemeral: false });

    const subId = options.getString('submission');
    const tileId = options.getString('tile');
    const teamId = options.getString('team');

    await interaction.deferReply({ ephemeral: false });

    const sub = await BingoSubmission.findById(subId).catch(() => null);
    if (!sub || sub.status !== 'pending') return interaction.editReply('❌ Submission not found or already reviewed.');

    const tile = BINGO_TILES.find(t => t.id === tileId);
    const team = await BingoTeam.findById(teamId);
    if (!tile || !team) return interaction.editReply('❌ Invalid tile or team.');

    // Check if tile has steps configured
    const tileConfig = await BingoTileConfig.findOne({ tileId }).lean();
    if (tileConfig && tileConfig.steps.length > 0) {
      // Get existing progress so already-done steps show as default
      const prog = await BingoProgress.findOne({ tileId, teamId }).lean();
      const completedSteps = prog?.completedSteps || [];

      const menuOptions = tileConfig.steps.map(step => ({
        label: step.slice(0, 100),
        value: step,
        description: completedSteps.includes(step) ? '✓ Already done' : 'Not done yet',
        default: completedSteps.includes(step),
      }));

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`bingo_steps:${subId}:${tileId}:${teamId}`)
        .setPlaceholder('Pick the step(s) this submission completes...')
        .setMinValues(1)
        .setMaxValues(menuOptions.length)
        .addOptions(menuOptions);

      const row = new ActionRowBuilder().addComponents(menu);

      return interaction.editReply({
        content: [
          `**${tile.name}** has ${tileConfig.steps.length} step(s) — ${completedSteps.length} already done.`,
          `Select which step(s) **${sub.submittedBy}**'s submission completes:`,
        ].join('\n'),
        components: [row],
      });
    }

    // No steps — complete tile directly
    const already = await BingoCompletion.findOne({ tileId, teamId });
    if (!already) await BingoCompletion.create({ tileId, teamId, completedBy: sub.submittedBy });
    await BingoSubmission.findByIdAndUpdate(sub._id, { tileId, teamId, status: 'approved', reviewedBy: user.tag });

    const submitter = await client.users.fetch(sub.submittedById).catch(() => null);
    if (submitter) submitter.send(`✅ Your bingo submission was approved! **${tile.name}** has been marked complete for **${team.name}**.`).catch(() => {});

    return interaction.editReply(`✅ Approved! **${tile.name}** assigned to **${team.name}** (submitted by ${sub.submittedBy}).`);
  }

  // /bingo-reject
  if (commandName === 'bingo-reject') {
    if (!member.permissions.has('Administrator') && !isMod(member))
      return interaction.reply({ content: '❌ Mods only.', ephemeral: false });

    const subId = options.getString('submission');
    const reason = options.getString('reason') || 'No reason given.';

    await interaction.deferReply({ ephemeral: false });

    const sub = await BingoSubmission.findById(subId).catch(() => null);
    if (!sub || sub.status !== 'pending') return interaction.editReply('❌ Submission not found or already reviewed.');

    await BingoSubmission.findByIdAndUpdate(sub._id, { status: 'rejected', reviewedBy: user.tag });

    const submitter = await client.users.fetch(sub.submittedById).catch(() => null);
    if (submitter) submitter.send(`❌ Your bingo submission was rejected. Reason: **${reason}**`).catch(() => {});

    return interaction.editReply(`❌ Submission rejected. Reason: ${reason}`);
  }
});

// --- Voice XP ---
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId = newState.member?.id || oldState.member?.id;
  const username = newState.member?.user?.username || oldState.member?.user?.username;
  if (!userId || newState.member?.user?.bot) return;

  const s = await getSettings();
  const isAfk = (channel) => channel && channel.id === s.afkChannelId;

  if (!oldState.channelId && newState.channelId && !isAfk(newState.channel)) {
    voiceJoinTime[userId] = new Date();

    // Voice join XP — Visionaries role only
    try {
      const member = await newState.guild.members.fetch(userId);
      if (hasVisionariesRole(member)) {
        const user = await getUser(userId, username);
        const now = new Date();
        if (!user.lastVoiceJoinXp || (now - user.lastVoiceJoinXp) > s.voiceJoinCooldownSecs * 1000) {
          const prevLevel = user.level;
          const updated = await addXp(userId, username, s.voiceJoinXp);
          await User.updateOne({ userId }, { lastVoiceJoinXp: now });
          console.log(`[XP] ${username} earned ${s.voiceJoinXp} XP for joining voice.`);
          if (updated.level > prevLevel) sendToXpChannel(getLevelUpMessage(username, updated.level));
        }
      }
    } catch (err) {
      console.error("Voice join XP error:", err);
    }

    voiceIntervals[userId] = setInterval(async () => {
      try {
        const currentSettings = await getSettings();
        const member = await newState.guild.members.fetch(userId);
        if (!member.voice.channelId || isAfk(member.voice.channel)) return;
        if (!hasVisionariesRole(member)) return;
        const prevLevel = (await getUser(userId, username)).level;
        const updated = await addXp(userId, username, currentSettings.voiceIntervalXp);
        console.log(`[XP] ${username} earned ${currentSettings.voiceIntervalXp} XP for voice activity.`);
        if (updated.level > prevLevel) sendToXpChannel(`🎉 ${username} reached **Level ${updated.level}**!`);
      } catch (err) {
        console.error("Voice interval XP error:", err);
      }
    }, s.voiceIntervalMins * 60 * 1000);
  }

  if (oldState.channelId && (!newState.channelId || isAfk(newState.channel))) {
    delete voiceJoinTime[userId];
    if (voiceIntervals[userId]) {
      clearInterval(voiceIntervals[userId]);
      delete voiceIntervals[userId];
    }
  }
});

// --- Dashboard HTTP Server ---
function checkAuth(req) {
  const pwd = process.env.DASHBOARD_PASSWORD;
  if (!pwd) return true;
  const auth = req.headers['authorization'];
  return auth === `Bearer ${pwd}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;
  const params = url.searchParams;

  // Keep-alive
  if (pathname === '/' || pathname === '') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive!');
    return;
  }

  // Dashboard HTML
  if (pathname === '/dashboard') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Dashboard file not found.');
    }
    return;
  }

  // Serve bingo board image
  if (pathname === '/bingo-board.png') {
    try {
      const data = fs.readFileSync(path.join(__dirname, 'bingo-board.png'));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
      res.end(data);
    } catch (e) {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // Auth check for all /api/* routes
  if (pathname.startsWith('/api/')) {
    if (!checkAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    // GET /api/settings
    if (pathname === '/api/settings' && req.method === 'GET') {
      const s = await getSettings();
      sendJson(res, 200, s);
      return;
    }

    // POST /api/settings
    if (pathname === '/api/settings' && req.method === 'POST') {
      try {
        const data = await readBody(req);
        await saveSettings(data);
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    // GET /api/users
    if (pathname === '/api/users' && req.method === 'GET') {
      const search = url.searchParams.get('search') || '';
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = 25;
      const query = search
        ? { $or: [{ username: { $regex: search, $options: 'i' } }, { rsName: { $regex: search, $options: 'i' } }, { rsNames: new RegExp(search, 'i') }] }
        : {};
      const validSorts = { username: 1, rsName: 1, level: 1, xp: 1, lootPoints: 1 };
      const rawSort = url.searchParams.get('sort');
      const sortDir = url.searchParams.get('dir') === 'asc' ? 1 : -1;
      let sortObj;
      if (rawSort === 'daysInClan') {
        // Oldest joinedClanAt = most days in clan; nulls last
        const clanDir = sortDir === -1 ? 1 : -1; // invert: "desc days" = earliest date first
        sortObj = { joinedClanAt: clanDir };
      } else {
        const sortField = validSorts.hasOwnProperty(rawSort) ? rawSort : 'level';
        sortObj = { [sortField]: sortDir };
        if (sortField !== 'level') sortObj.level = -1;
        if (sortField !== 'xp') sortObj.xp = -1;
      }
      const total = await User.countDocuments(query);
      const users = await User.find(query).sort(sortObj).skip((page - 1) * limit).limit(limit);
      sendJson(res, 200, { users, total, page, pages: Math.ceil(total / limit) });
      return;
    }

    // DELETE /api/users/:id
    const userMatchDel = pathname.match(/^\/api\/users\/(.+)$/);
    if (userMatchDel && req.method === 'DELETE') {
      try {
        await User.deleteOne({ userId: userMatchDel[1] });
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    // PATCH /api/users/:id
    const userMatch = pathname.match(/^\/api\/users\/(.+)$/);
    if (userMatch && req.method === 'PATCH') {
      try {
        const data = await readBody(req);
        const allowed = ['xp', 'level', 'lootPoints', 'rsName', 'rsNames', 'username'];
        const update = {};
        for (const k of allowed) {
          if (data[k] !== undefined) update[k] = data[k];
        }
        const user = await User.findOneAndUpdate({ userId: userMatch[1] }, { $set: update }, { new: true });
        sendJson(res, 200, user);
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    // GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      const userCount = await User.countDocuments();
      sendJson(res, 200, {
        botOnline: client.isReady(),
        botTag: client.user?.tag || null,
        userCount,
        uptime: process.uptime(),
      });
      return;
    }

    // GET /api/wom/search?name=...
    if (pathname === '/api/wom/search' && req.method === 'GET') {
      const name = (params.get('name') || '').trim();
      if (!name) { sendJson(res, 400, { error: 'name is required' }); return; }
      try {
        const searchUrl = `https://api.wiseoldman.net/v2/groups?name=${encodeURIComponent(name)}&limit=10`;
        const r = await fetch(searchUrl, { headers: { 'User-Agent': 'VisionaryBot/1.0', 'x-user-agent': 'VisionaryBot/1.0' } });
        if (!r.ok) { sendJson(res, 502, { error: `WOM API returned ${r.status}` }); return; }
        const body = await r.json();
        const groups = Array.isArray(body) ? body : (Array.isArray(body.groups) ? body.groups : []);
        sendJson(res, 200, groups.map(g => ({ id: g.id, name: g.name, memberCount: g.memberCount })));
      } catch (e) {
        sendJson(res, 502, { error: e.message });
      }
      return;
    }

    // POST /api/wom/sync
    if (pathname === '/api/wom/sync' && req.method === 'POST') {
      try {
        const result = await syncWomMembers();
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // GET /api/droptracker/top-players
    if (pathname === '/api/droptracker/top-players' && req.method === 'GET') {
      const npcName = params.get('npc_name') || null;
      const limit = Math.min(parseInt(params.get('limit') || '25'), 100);
      const result = await getDroptrackerTopPlayers(npcName, limit);
      if (result.error) { sendJson(res, 502, result); return; }
      sendJson(res, 200, result.data);
      return;
    }

    // GET /api/droptracker/drops
    if (pathname === '/api/droptracker/drops' && req.method === 'GET') {
      const npcName = params.get('npc_name') || null;
      const limit = Math.min(parseInt(params.get('limit') || '25'), 100);
      const result = await getDroptrackerDrops(npcName, limit);
      if (result.error) { sendJson(res, 502, result); return; }
      sendJson(res, 200, result.data);
      return;
    }

    // POST /api/droptracker/sync
    if (pathname === '/api/droptracker/sync' && req.method === 'POST') {
      const result = await syncDroptrackerMembers();
      sendJson(res, result.error ? 502 : 200, result);
      return;
    }

    // GET /api/ranks
    if (pathname === '/api/ranks' && req.method === 'GET') {
      const ranks = await Rank.find().sort({ order: 1, minLevel: 1 });
      sendJson(res, 200, ranks);
      return;
    }

    // POST /api/ranks
    if (pathname === '/api/ranks' && req.method === 'POST') {
      try {
        const data = await readBody(req);
        const rank = await Rank.create({
          name: data.name,
          minDays: Number(data.minDays) || 0,
          minLootPoints: Number(data.minLootPoints) || 0,
          minLevel: Number(data.minLevel) || 0,
          order: Number(data.order) || 0,
        });
        sendJson(res, 201, rank);
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    // POST /api/ranks/check
    if (pathname === '/api/ranks/check' && req.method === 'POST') {
      try {
        const guild = client.guilds.cache.first();
        const count = await checkRankUps(guild);
        sendJson(res, 200, { notified: count });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // PATCH /api/ranks/:id
    const rankMatchPatch = pathname.match(/^\/api\/ranks\/(.+)$/);
    if (rankMatchPatch && req.method === 'PATCH') {
      try {
        const data = await readBody(req);
        const allowed = ['name', 'minDays', 'minLootPoints', 'minLevel', 'order'];
        const update = {};
        for (const k of allowed) {
          if (data[k] !== undefined) update[k] = data[k];
        }
        const rank = await Rank.findByIdAndUpdate(rankMatchPatch[1], { $set: update }, { new: true });
        if (!rank) { sendJson(res, 404, { error: 'Not found' }); return; }
        sendJson(res, 200, rank);
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    // DELETE /api/ranks/:id
    const rankMatchDelete = pathname.match(/^\/api\/ranks\/(.+)$/);
    if (rankMatchDelete && req.method === 'DELETE') {
      try {
        await Rank.findByIdAndDelete(rankMatchDelete[1]);
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    // GET /api/commands
    if (pathname === '/api/commands' && req.method === 'GET') {
      const cmds = await CommandConfig.find({}).sort({ category: 1, key: 1 });
      sendJson(res, 200, cmds);
      return;
    }

    // PATCH /api/commands/:key
    const cmdMatch = pathname.match(/^\/api\/commands\/(.+)$/);
    if (cmdMatch && req.method === 'PATCH') {
      try {
        const data = await readBody(req);
        const { name } = data;
        if (!name || !/^[a-z0-9_-]+$/i.test(name.trim())) {
          sendJson(res, 400, { error: 'Invalid command name. Use only letters, numbers, hyphens, underscores.' });
          return;
        }
        const updated = await CommandConfig.findOneAndUpdate(
          { key: cmdMatch[1] },
          { name: name.trim().toLowerCase() },
          { new: true }
        );
        if (!updated) { sendJson(res, 404, { error: 'Command not found' }); return; }
        commandNames[cmdMatch[1]] = updated.name; // hot-reload immediately
        sendJson(res, 200, updated);
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    // GET /api/bingo/submissions
    if (pathname === '/api/bingo/submissions' && req.method === 'GET') {
      const status = new URL('http://x' + req.url).searchParams.get('status') || 'pending';
      const subs = await BingoSubmission.find(status === 'all' ? {} : { status })
        .populate('teamId', 'name color')
        .sort({ createdAt: -1 })
        .limit(50);
      sendJson(res, 200, subs);
      return;
    }

    // POST /api/bingo/submissions/:id/approve
    const approveMatch = pathname.match(/^\/api\/bingo\/submissions\/(.+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      try {
        const data = await readBody(req);
        const { tileId, teamId } = data;
        if (!tileId || !teamId) { sendJson(res, 400, { error: 'tileId and teamId required' }); return; }
        const sub = await BingoSubmission.findById(approveMatch[1]);
        if (!sub) { sendJson(res, 404, { error: 'Submission not found' }); return; }
        const already = await BingoCompletion.findOne({ tileId, teamId });
        if (!already) await BingoCompletion.create({ tileId, teamId, completedBy: sub.submittedBy });
        await BingoSubmission.findByIdAndUpdate(sub._id, { tileId, teamId, status: 'approved', reviewedBy: 'dashboard' });
        // DM the submitter
        const submitter = await client.users.fetch(sub.submittedById).catch(() => null);
        const tile = BINGO_TILES.find(t => t.id === tileId);
        const team = await BingoTeam.findById(teamId);
        if (submitter) submitter.send(`✅ Your bingo submission was approved! **${tile?.name || tileId}** has been marked complete for **${team?.name || ''}**.`).catch(() => {});
        sendJson(res, 200, { success: true });
      } catch (e) { sendJson(res, 400, { error: e.message }); }
      return;
    }

    // POST /api/bingo/submissions/:id/reject
    const rejectMatch = pathname.match(/^\/api\/bingo\/submissions\/(.+)\/reject$/);
    if (rejectMatch && req.method === 'POST') {
      try {
        const data = await readBody(req);
        const sub = await BingoSubmission.findById(rejectMatch[1]);
        if (!sub) { sendJson(res, 404, { error: 'Submission not found' }); return; }
        await BingoSubmission.findByIdAndUpdate(sub._id, { status: 'rejected', reviewedBy: 'dashboard' });
        const submitter = await client.users.fetch(sub.submittedById).catch(() => null);
        if (submitter) submitter.send(`❌ Your bingo submission was rejected.${data.reason ? ' Reason: **' + data.reason + '**' : ''}`).catch(() => {});
        sendJson(res, 200, { success: true });
      } catch (e) { sendJson(res, 400, { error: e.message }); }
      return;
    }

    // GET /api/bingo/state
    if (pathname === '/api/bingo/state' && req.method === 'GET') {
      const [teams, completions, tileConfigs, progress] = await Promise.all([
        BingoTeam.find().sort({ order: 1, createdAt: 1 }),
        BingoCompletion.find().populate('teamId', 'name color'),
        BingoTileConfig.find(),
        BingoProgress.find().populate('teamId', 'name color'),
      ]);
      sendJson(res, 200, { teams, completions, tiles: BINGO_TILES, lines: BINGO_LINES, tileConfigs, progress });
      return;
    }

    // PUT /api/bingo/tile-config/:tileId — set step definitions for a tile
    const tileConfigMatch = pathname.match(/^\/api\/bingo\/tile-config\/(.+)$/);
    if (tileConfigMatch && req.method === 'PUT') {
      try {
        const data = await readBody(req);
        const steps = Array.isArray(data.steps) ? data.steps.map(s => String(s).trim()).filter(Boolean) : [];
        const config = await BingoTileConfig.findOneAndUpdate(
          { tileId: tileConfigMatch[1] },
          { $set: { steps } },
          { upsert: true, new: true }
        );
        sendJson(res, 200, config);
      } catch (e) { sendJson(res, 400, { error: e.message }); }
      return;
    }

    // PATCH /api/bingo/progress — toggle a step for a tile+team
    if (pathname === '/api/bingo/progress' && req.method === 'PATCH') {
      try {
        const data = await readBody(req);
        const { tileId, teamId, step } = data;
        if (!tileId || !teamId || !step) { sendJson(res, 400, { error: 'tileId, teamId, step required' }); return; }

        const existing = await BingoProgress.findOne({ tileId, teamId });
        let completedSteps;
        if (!existing) {
          await BingoProgress.create({ tileId, teamId, completedSteps: [step] });
          completedSteps = [step];
        } else {
          if (existing.completedSteps.includes(step)) {
            completedSteps = existing.completedSteps.filter(s => s !== step);
          } else {
            completedSteps = [...existing.completedSteps, step];
          }
          await BingoProgress.findOneAndUpdate({ tileId, teamId }, { $set: { completedSteps } });
        }

        // Auto-complete the tile if all steps are done
        const config = await BingoTileConfig.findOne({ tileId });
        if (config && config.steps.length > 0 && config.steps.every(s => completedSteps.includes(s))) {
          const already = await BingoCompletion.findOne({ tileId, teamId });
          if (!already) await BingoCompletion.create({ tileId, teamId, completedBy: 'auto (all steps done)' });
        } else if (config && config.steps.length > 0) {
          // Uncomplete tile if a step was removed
          await BingoCompletion.deleteOne({ tileId, teamId });
        }

        sendJson(res, 200, { completedSteps });
      } catch (e) { sendJson(res, 400, { error: e.message }); }
      return;
    }

    // POST /api/bingo/teams
    if (pathname === '/api/bingo/teams' && req.method === 'POST') {
      try {
        const data = await readBody(req);
        const team = await BingoTeam.create({ name: data.name, color: data.color || '#e74c3c', order: data.order || 0 });
        sendJson(res, 201, team);
      } catch (e) { sendJson(res, 400, { error: e.message }); }
      return;
    }

    // PATCH /api/bingo/teams/:id
    const bingoTeamPatch = pathname.match(/^\/api\/bingo\/teams\/(.+)$/);
    if (bingoTeamPatch && req.method === 'PATCH') {
      try {
        const data = await readBody(req);
        const upd = {};
        if (data.name !== undefined) upd.name = data.name;
        if (data.color !== undefined) upd.color = data.color;
        if (data.order !== undefined) upd.order = Number(data.order);
        const team = await BingoTeam.findByIdAndUpdate(bingoTeamPatch[1], { $set: upd }, { new: true });
        if (!team) { sendJson(res, 404, { error: 'Not found' }); return; }
        sendJson(res, 200, team);
      } catch (e) { sendJson(res, 400, { error: e.message }); }
      return;
    }

    // DELETE /api/bingo/teams/:id
    const bingoTeamDel = pathname.match(/^\/api\/bingo\/teams\/(.+)$/);
    if (bingoTeamDel && req.method === 'DELETE') {
      await BingoTeam.findByIdAndDelete(bingoTeamDel[1]);
      await BingoCompletion.deleteMany({ teamId: bingoTeamDel[1] });
      sendJson(res, 200, { success: true });
      return;
    }

    // POST /api/bingo/complete
    if (pathname === '/api/bingo/complete' && req.method === 'POST') {
      try {
        const data = await readBody(req);
        const existing = await BingoCompletion.findOne({ tileId: data.tileId, teamId: data.teamId });
        if (existing) { sendJson(res, 200, existing); return; }
        const comp = await BingoCompletion.create({ tileId: data.tileId, teamId: data.teamId, completedBy: data.completedBy || '' });
        sendJson(res, 201, comp);
      } catch (e) { sendJson(res, 400, { error: e.message }); }
      return;
    }

    // DELETE /api/bingo/complete
    if (pathname === '/api/bingo/complete' && req.method === 'DELETE') {
      try {
        const data = await readBody(req);
        await BingoCompletion.deleteOne({ tileId: data.tileId, teamId: data.teamId });
        sendJson(res, 200, { success: true });
      } catch (e) { sendJson(res, 400, { error: e.message }); }
      return;
    }

    // POST /api/bingo/post-score
    if (pathname === '/api/bingo/post-score' && req.method === 'POST') {
      try {
        const data = await readBody(req);
        const channelId = data.channelId;
        if (!channelId) { sendJson(res, 400, { error: 'channelId required' }); return; }
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) { sendJson(res, 404, { error: 'Channel not found. Check the channel ID.' }); return; }
        const base64 = data.imageData.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        const label = data.teamName ? ` — ${data.teamName}` : '';
        await channel.send({ content: `🎯 **Bingo Score${label}**`, files: [{ attachment: buffer, name: 'bingo-score.png' }] });
        sendJson(res, 200, { success: true });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
});

// --- Start Bot ---
const token = process.env.DISCORD_TOKEN;
if (!token) { console.error("DISCORD_TOKEN not set!"); process.exit(1); }

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) { console.error("MONGODB_URI not set!"); process.exit(1); }

mongoose.connect(mongoUri)
  .then(() => {
    console.log("Connected to MongoDB.");
    client.login(token);
  })
  .catch(err => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });
