const { Client, GatewayIntentBits, Events } = require('discord.js');
const mongoose = require('mongoose');
const http = require('http');
const cron = require('node-cron');

// --- MongoDB Setup ---
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: String,
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 0 },
  lootPoints: { type: Number, default: 0 },
  lastMessageXp: { type: Date, default: null },
  lastVoiceJoinXp: { type: Date, default: null },
});

const User = mongoose.model('User', userSchema);

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
const AFKChannelName = "afk";
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

// --- Send to XP channel ---
async function sendToXpChannel(message) {
  try {
    const channel = await client.channels.fetch(XP_CHANNEL_ID);
    channel.send(message);
  } catch (err) {
    console.error("Failed to send to XP channel:", err);
  }
}

// --- Loot Points helpers ---
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

// --- Helper: Check if user is a mod ---
function isMod(member) {
  return member.roles.cache.some(r => r.name.toLowerCase() === "mods" || r.name.toLowerCase() === "mod");
}

// --- Ready ---
client.once('ready', async () => {
  console.log(`${client.user.tag} is online and ready!`);

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

  // Daily leaderboard at 11:59 PM UTC
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

// --- Message XP (1 min cooldown, 15-25 XP per message) ---
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // XP for chatting
  try {
    const user = await getUser(message.author.id, message.author.username);
    const now = new Date();
    const cooldown = 60 * 1000;

    if (!user.lastMessageXp || (now - user.lastMessageXp) > cooldown) {
      const xpGained = Math.floor(Math.random() * 11) + 15;
      const prevLevel = user.level;
      const updated = await addXp(message.author.id, message.author.username, xpGained);

      await User.updateOne({ userId: message.author.id }, { lastMessageXp: now });
      console.log(`[XP] ${message.author.username} earned ${xpGained} XP from message. Level ${updated.level} | ${updated.xp} XP`);

      if (updated.level > prevLevel) {
        sendToXpChannel(getLevelUpMessage(message.author.username, updated.level));
      }
    }
  } catch (err) {
    console.error("Message XP error:", err);
  }

  // Commands
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // !lp → check loot points balance
  if (command === "lp") {
    const user = message.mentions.users.first() || message.author;
    const balance = await getLootPoints(user.id, user.username);
    message.channel.send(`${user.username} has ${balance} LP`);
  }

  // !xp → check XP/level
  if (command === "xp") {
    const target = message.mentions.users.first() || message.author;
    const user = await getUser(target.id, target.username);
    const needed = xpForLevel(user.level);
    message.channel.send(`⭐ ${target.username} — **Level ${user.level}** | ${user.xp}/${needed} XP`);
  }

  // !level → show your current level
  if (command === "level") {
    const target = message.mentions.users.first() || message.author;
    const user = await getUser(target.id, target.username);
    const needed = xpForLevel(user.level);
    message.channel.send(`🏅 ${target.username} is **Level ${user.level}** — ${user.xp}/${needed} XP to next level`);
  }

  // !leaderboard → XP leaderboard with username, level, xp
  if (command === "leaderboard") {
    const lb = await buildXpLeaderboard();
    message.channel.send(lb);
  }

  // !xptop → XP leaderboard (alias)
  if (command === "xptop") {
    const lb = await buildXpLeaderboard();
    message.channel.send(lb);
  }

  // !total → loot points leaderboard
  if (command === "total") {
    const leaderboard = await buildLeaderboard();
    message.channel.send(leaderboard);
  }

  // !split → give each user full amount of LP
  if (command === "split") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !split amount @users");

    const lines = [];
    for (const user of users.values()) {
      const newBalance = await modifyLootPoints(user.id, user.username, amount);
      lines.push(`${user.username} received ${amount} LP — they now have ${newBalance} LP`);
    }
    message.channel.send(`💰 **Split:**\n${lines.join("\n")}`);
  }

  // !donate → give each user half the amount of LP
  if (command === "donate") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !donate amount @users");

    const halfAmount = Math.floor(amount / 2);
    const lines = [];
    for (const user of users.values()) {
      const newBalance = await modifyLootPoints(user.id, user.username, halfAmount);
      lines.push(`${user.username} received ${halfAmount} LP — they now have ${newBalance} LP`);
    }
    message.channel.send(`💖 **Donate:**\n${lines.join("\n")}`);
  }

  // !add → add LP (anyone can use)
  if (command === "add") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !add amount @user");

    const lines = [];
    for (const user of users.values()) {
      const newBalance = await modifyLootPoints(user.id, user.username, amount);
      lines.push(`✅ Added ${amount} LP to ${user.username}. They now have ${newBalance} LP.`);
    }
    message.channel.send(lines.join("\n"));
  }

  // !remove → remove LP (anyone can use)
  if (command === "remove") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !remove amount @user");

    const lines = [];
    for (const user of users.values()) {
      const newBalance = await modifyLootPoints(user.id, user.username, -amount);
      lines.push(`❌ Removed ${amount} LP from ${user.username}. They now have ${newBalance} LP.`);
    }
    message.channel.send(lines.join("\n"));
  }

  // !addxp → add XP (mods only)
  if (command === "addxp") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Only admins can use this command.");
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !addxp amount @user");

    const lines = [];
    for (const user of users.values()) {
      const updated = await addXp(user.id, user.username, amount);
      lines.push(`✅ Added ${amount} XP to ${user.username}. They are now Level ${updated.level} (${updated.xp} XP).`);
    }
    message.channel.send(lines.join("\n"));
  }

  // !fixlp → restore lost LP values by username (admin only)
  if (command === "fixlp") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Only admins can use this command.");
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
      if (result) {
        lines.push(`✅ ${entry.username} → ${entry.lootPoints} LP`);
      } else {
        lines.push(`⚠️ ${entry.username} not found in database`);
      }
    }
    return message.channel.send(`**LP Restore Complete:**\n${lines.join('\n')}`);
  }

  // !cleanduplicates → remove old manually migrated entries (admin only)
  if (command === "cleanduplicates") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Only admins can use this command.");
    const result = await User.deleteMany({ userId: { $regex: /^migrated_/ } });
    return message.channel.send(`✅ Removed **${result.deletedCount}** duplicate entries.`);
  }

  // !importmee6 → import XP/levels from MEE6 (admin only)
  if (command === "importmee6") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Only admins can use this command.");

    await message.channel.send("⏳ Fetching MEE6 leaderboard, please wait...");

    try {
      const guildId = message.guild.id;
      let page = 0;
      let allPlayers = [];
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(`https://mee6.xyz/api/plugins/levels/leaderboard/${guildId}?limit=1000&page=${page}`);
        if (!res.ok) {
          return message.channel.send(`❌ Failed to fetch MEE6 data (status ${res.status}). Make sure the MEE6 levels plugin is public.`);
        }
        const data = await res.json();
        const players = data.players || [];
        allPlayers = allPlayers.concat(players);
        hasMore = players.length === 1000;
        page++;
      }

      if (allPlayers.length === 0) {
        return message.channel.send("❌ No players found on the MEE6 leaderboard.");
      }

      let imported = 0;
      for (const player of allPlayers) {
        const userId = player.id;
        const username = player.username;
        const mee6Level = player.level || 0;
        const mee6Xp = player.detailed_xp ? player.detailed_xp[0] : (player.xp || 0);

        await User.findOneAndUpdate(
          { userId },
          { $set: { userId, username, level: mee6Level, xp: mee6Xp } },
          { upsert: true, new: true }
        );
        imported++;
      }

      message.channel.send(`✅ Imported **${imported} users** from MEE6 successfully!`);
    } catch (err) {
      console.error("MEE6 import error:", err);
      message.channel.send("❌ Something went wrong while importing from MEE6.");
    }
  }

  // !removexp → remove XP (mods only)
  if (command === "removexp") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Only admins can use this command.");
    const amount = parseInt(args[0]);
    const users = message.mentions.users;
    if (isNaN(amount) || users.size === 0) return message.reply("Usage: !removexp amount @user");

    const lines = [];
    for (const user of users.values()) {
      const u = await getUser(user.id, user.username);
      u.xp = Math.max(0, u.xp - amount);
      await u.save();
      lines.push(`❌ Removed ${amount} XP from ${user.username}. They are now Level ${u.level} (${u.xp} XP).`);
    }
    message.channel.send(lines.join("\n"));
  }
});

// --- Voice XP ---
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId = newState.member?.id || oldState.member?.id;
  const username = newState.member?.user?.username || oldState.member?.user?.username;
  if (!userId || newState.member?.user?.bot) return;

  const isAfk = (channel) => channel && channel.name.toLowerCase().includes(AFKChannelName);

  // User joined a voice channel
  if (!oldState.channelId && newState.channelId && !isAfk(newState.channel)) {
    voiceJoinTime[userId] = new Date();

    // Join XP: 50 XP with 1-hour cooldown
    try {
      const user = await getUser(userId, username);
      const now = new Date();
      const cooldown = 60 * 60 * 1000;

      if (!user.lastVoiceJoinXp || (now - user.lastVoiceJoinXp) > cooldown) {
        const prevLevel = user.level;
        const updated = await addXp(userId, username, 50);
        await User.updateOne({ userId }, { lastVoiceJoinXp: now });
        console.log(`[XP] ${username} earned 50 XP for joining voice. Level ${updated.level} | ${updated.xp} XP`);

        if (updated.level > prevLevel) {
          sendToXpChannel(getLevelUpMessage(username, updated.level));
        }
      }
    } catch (err) {
      console.error("Voice join XP error:", err);
    }

    // Start 30-min interval XP (300 XP every 30 mins)
    voiceIntervals[userId] = setInterval(async () => {
      try {
        const member = await newState.guild.members.fetch(userId);
        if (!member.voice.channelId || isAfk(member.voice.channel)) return;

        const prevLevel = (await getUser(userId, username)).level;
        const updated = await addXp(userId, username, 300);
        console.log(`[XP] ${username} earned 300 XP for 30 mins in voice. Level ${updated.level} | ${updated.xp} XP`);

        if (updated.level > prevLevel) {
          sendToXpChannel(`🎉 ${username} reached **Level ${updated.level}**!`);
        }
      } catch (err) {
        console.error("Voice interval XP error:", err);
      }
    }, 30 * 60 * 1000); // every 30 minutes
  }

  // User left a voice channel or moved to AFK
  if (oldState.channelId && (!newState.channelId || isAfk(newState.channel))) {
    delete voiceJoinTime[userId];
    if (voiceIntervals[userId]) {
      clearInterval(voiceIntervals[userId]);
      delete voiceIntervals[userId];
    }
  }
});

// --- Start ---
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

// Keep-alive HTTP server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is alive!");
}).listen(PORT, () => {
  console.log(`Keep-alive server running on port ${PORT}`);
});
