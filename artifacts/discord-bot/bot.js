const { Client, GatewayIntentBits, Events } = require('discord.js');
const mongoose = require('mongoose');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
});

const User = mongoose.model('User', userSchema);

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
});

const Settings = mongoose.model('Settings', settingsSchema);

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
    'dropTopXp', 'afkChannelId',
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
async function getUser(userId, username) {
  let user = await User.findOne({ userId });
  if (!user) {
    user = new User({ userId, username });
    await user.save();
  }
  return user;
}

function xpForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

async function addXp(userId, username, amount) {
  const user = await getUser(userId, username);
  user.xp += amount;
  user.username = username;
  while (user.xp >= xpForLevel(user.level)) {
    user.xp -= xpForLevel(user.level);
    user.level += 1;
  }
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

// --- Drop Top XP Awards ---
async function awardDropTopXp(rankedNames, guild, channel) {
  const s = await getSettings();
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const lines = [];
  const unmatched = [];

  for (let i = 0; i < rankedNames.length && i < 10; i++) {
    const rsName = rankedNames[i].toLowerCase();
    const xpReward = s.dropTopXp[i] || 1000;
    const dbUser = await User.findOne({ rsName: { $regex: new RegExp(`^${rsName}$`, 'i') } });

    if (!dbUser) {
      unmatched.push(`${medals[i]} **${rankedNames[i]}** — no Discord link found`);
      continue;
    }

    const updated = await addXp(dbUser.userId, dbUser.username, xpReward);
    const discordMember = await guild.members.fetch(dbUser.userId).catch(() => null);
    const displayName = discordMember ? `<@${dbUser.userId}>` : dbUser.username;
    lines.push(`${medals[i]} ${displayName} (**${rankedNames[i]}**) — +${xpReward.toLocaleString()} XP → Level ${updated.level}`);
  }

  let response = `🏆 **Monthly DropTracker Awards!**\n\n`;
  if (lines.length > 0) response += lines.join('\n') + '\n';
  if (unmatched.length > 0) {
    response += `\n⚠️ **Unmatched RS names** (ask them to use \`!rslink <rsname>\`):\n`;
    response += unmatched.join('\n');
  }
  channel.send(response);
}

// --- Ready ---
client.once('ready', async () => {
  console.log(`${client.user.tag} is online and ready!`);
  await getSettings();

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
  });

  console.log("Daily leaderboard scheduled for 11:59 PM UTC.");
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
      const user = await getUser(message.author.id, message.author.username);
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

  if (command === "lp") {
    const user = message.mentions.users.first() || message.author;
    const balance = await getLootPoints(user.id, user.username);
    message.channel.send(`${user.username} has ${balance} LP`);
  }

  if (command === "xp") {
    const target = message.mentions.users.first() || message.author;
    const user = await getUser(target.id, target.username);
    message.channel.send(`⭐ ${target.username} — **Level ${user.level}** | ${user.xp}/${xpForLevel(user.level)} XP`);
  }

  if (command === "level") {
    const target = message.mentions.users.first() || message.author;
    const user = await getUser(target.id, target.username);
    message.channel.send(`🏅 ${target.username} is **Level ${user.level}** — ${user.xp}/${xpForLevel(user.level)} XP to next level`);
  }

  if (command === "leaderboard" || command === "xptop") {
    message.channel.send(await buildXpLeaderboard());
  }

  if (command === "total") {
    message.channel.send(await buildLeaderboard());
  }

  // !lplist → full LP list A-Z
  if (command === "lplist") {
    const users = await User.find({ lootPoints: { $gt: 0 } }).sort({ username: 1 });
    if (users.length === 0) return message.channel.send("No loot points recorded yet!");
    const lines = users.map(u => `• ${u.username || u.userId} — ${u.lootPoints} LP`);
    await sendLongMessage(message.channel, `🏆 **LP List (A–Z) — ${users.length} members**`, lines);
  }

  // !xplist → full XP/level list A-Z
  if (command === "xplist") {
    const users = await User.find({ $or: [{ level: { $gt: 0 } }, { xp: { $gt: 0 } }] }).sort({ username: 1 });
    if (users.length === 0) return message.channel.send("No XP recorded yet!");
    const lines = users.map(u => `• ${u.username || u.userId} — Level ${u.level} | ${u.xp}/${xpForLevel(u.level)} XP`);
    await sendLongMessage(message.channel, `⭐ **XP List (A–Z) — ${users.length} members**`, lines);
  }

  if (command === "rslink") {
    const rsName = args.join(' ').trim();
    if (!rsName) return message.reply("Usage: `!rslink YourRuneScapeName`");
    const existing = await User.findOne({ rsName: { $regex: new RegExp(`^${rsName}$`, 'i') } });
    if (existing && existing.userId !== message.author.id)
      return message.reply(`❌ The RS name **${rsName}** is already linked to another account.`);
    await User.findOneAndUpdate(
      { userId: message.author.id },
      { $set: { rsName, username: message.author.username } },
      { upsert: true, new: true }
    );
    message.reply(`✅ Your RS name **${rsName}** has been linked!`);
  }

  if (command === "myrs") {
    const user = await getUser(message.author.id, message.author.username);
    if (!user.rsName) return message.reply("You haven't linked an RS name yet. Use `!rslink YourRsName`");
    message.reply(`Your linked RS name is: **${user.rsName}**`);
  }

  if (command === "rsnames") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    const users = await User.find({ rsName: { $ne: null } }).sort({ rsName: 1 });
    if (users.length === 0) return message.channel.send("No RS names linked yet.");
    const lines = users.map(u => `• **${u.rsName}** → ${u.username || u.userId}`);
    message.channel.send(`📋 **Linked RS Names (${users.length}):**\n${lines.join('\n')}`);
  }

  if (command === "rsset") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    const target = message.mentions.users.first();
    const rsName = args.slice(1).join(' ').trim();
    if (!target || !rsName) return message.reply("Usage: `!rsset @user RsName`");
    await User.findOneAndUpdate(
      { userId: target.id },
      { $set: { rsName, username: target.username } },
      { upsert: true, new: true }
    );
    message.channel.send(`✅ Linked **${rsName}** to ${target.username}`);
  }

  if (command === "droptop") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    if (!process.env.GEMINI_API_KEY) return message.reply("❌ GEMINI_API_KEY is not set.");
    const attachment = message.attachments.first();
    if (!attachment) return message.reply("❌ Attach a screenshot of the DropTracker leaderboard.");

    const processingMsg = await message.channel.send("⏳ Reading leaderboard screenshot with AI...");
    try {
      const names = await extractLeaderboardFromImage(attachment.url);
      if (!Array.isArray(names) || names.length === 0) {
        await processingMsg.delete().catch(() => {});
        return message.channel.send("❌ Couldn't extract names. Try a clearer screenshot.");
      }
      await processingMsg.delete().catch(() => {});
      const preview = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
      await message.channel.send(`📋 **Detected rankings:**\n${preview}\n\nAwarding XP now...`);
      await awardDropTopXp(names, message.guild, message.channel);
    } catch (err) {
      console.error("!droptop error:", err);
      await processingMsg.delete().catch(() => {});
      message.channel.send(`❌ Failed to read screenshot: ${err.message}`);
    }
  }

  if (command === "split") {
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

  if (command === "donate") {
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

  if (command === "add") {
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

  if (command === "remove") {
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

  if (command === "addxp") {
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

  if (command === "removexp") {
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

  if (command === "fixlp") {
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

  if (command === "cleanduplicates") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Admins only.");
    const result = await User.deleteMany({ userId: { $regex: /^migrated_/ } });
    return message.channel.send(`✅ Removed **${result.deletedCount}** duplicate entries.`);
  }

  if (command === "importmee6") {
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

  if (command === "help") {
    const s = await getSettings();
    message.channel.send(`📖 **Visionary Bot Commands**

**XP & Levels** *(Visionaries role only earns XP)*
\`!xp [@user]\` — Check XP and level
\`!level [@user]\` — Check current level
\`!leaderboard\` / \`!xptop\` — Top 20 XP leaderboard
\`!xplist\` — Full XP list A–Z

**Loot Points**
\`!lp [@user]\` — Check LP balance
\`!total\` — Top 20 LP leaderboard
\`!lplist\` — Full LP list A–Z
\`!split <amount> @users\` — Give each user LP
\`!donate <amount> @users\` — Give each user half LP
\`!add <amount> @user\` — Add LP
\`!remove <amount> @user\` — Remove LP

**RS Name Linking**
\`!rslink <rsname>\` — Link your RS name
\`!myrs\` — Check your linked RS name

**Admin Only**
\`!addxp <amount> @user\` — Add XP
\`!removexp <amount> @user\` — Remove XP
\`!rsnames\` — List all linked RS names
\`!rsset @user <rsname>\` — Link RS name for any user
\`!droptop\` — Award monthly XP from screenshot

📊 **Current XP Rates** (from dashboard)
Message XP: ${s.messageXpMin}–${s.messageXpMax} XP (${s.messageXpCooldownSecs}s cooldown)
Voice Join: ${s.voiceJoinXp} XP | Voice Activity: ${s.voiceIntervalXp} XP / ${s.voiceIntervalMins} mins`);
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

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
        ? { $or: [{ username: { $regex: search, $options: 'i' } }, { rsName: { $regex: search, $options: 'i' } }] }
        : {};
      const total = await User.countDocuments(query);
      const users = await User.find(query).sort({ level: -1, xp: -1 }).skip((page - 1) * limit).limit(limit);
      sendJson(res, 200, { users, total, page, pages: Math.ceil(total / limit) });
      return;
    }

    // PATCH /api/users/:id
    const userMatch = pathname.match(/^\/api\/users\/(.+)$/);
    if (userMatch && req.method === 'PATCH') {
      try {
        const data = await readBody(req);
        const allowed = ['xp', 'level', 'lootPoints', 'rsName', 'username'];
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
