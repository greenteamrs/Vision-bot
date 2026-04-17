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
  return 100 * (level + 1);
}

async function addXp(userId, username, amount) {
  const user = await getUser(userId, username);
  user.xp += amount;
  user.username = username;

  // Level up logic
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
const AFKChannelName = "afk"; // adjust if your AFK channel has a different name

// Track voice join times: { userId: Date }
const voiceJoinTime = {};
// Track 30-min XP intervals: { userId: intervalId }
const voiceIntervals = {};

// --- Loot Points helpers (kept from old system) ---
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

// --- Leaderboard ---
async function buildLeaderboard() {
  const users = await User.find({ lootPoints: { $gt: 0 } }).sort({ lootPoints: -1 }).limit(20);
  if (users.length === 0) return "No loot points recorded yet!";
  const lines = users.map((u, i) => `${i + 1}. ${u.username || u.userId} — ${u.lootPoints} LP`);
  return `🏆 **Loot Points Leaderboard**\n${lines.join("\n")}`;
}

async function buildXpLeaderboard() {
  const users = await User.find().sort({ level: -1, xp: -1 }).limit(20);
  if (users.length === 0) return "No XP recorded yet!";
  const lines = users.map((u, i) => `${i + 1}. ${u.username || u.userId} — Level ${u.level} (${u.xp} XP)`);
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
    channel.send(`✅ **Bot is online!**\n${leaderboard}`);
  } catch (err) {
    console.error("Failed to post startup message:", err);
  }

  // Daily leaderboard at 11:59 PM UTC
  cron.schedule("59 23 * * *", async () => {
    try {
      const channel = await client.channels.fetch(channelId);
      const leaderboard = await buildLeaderboard();
      channel.send(`📅 **Daily Loot Points Summary**\n${leaderboard}`);
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
    const cooldown = 60 * 1000; // 1 minute

    if (!user.lastMessageXp || (now - user.lastMessageXp) > cooldown) {
      const xpGained = Math.floor(Math.random() * 11) + 15; // 15-25 XP
      const prevLevel = user.level;
      const updated = await addXp(message.author.id, message.author.username, xpGained);

      await User.updateOne({ userId: message.author.id }, { lastMessageXp: now });

      if (updated.level > prevLevel) {
        message.channel.send(`🎉 Congrats ${message.author.username}! You reached **Level ${updated.level}**!`);
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

  // !xptop → XP leaderboard
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
    if (!isMod(message.member)) return message.reply("❌ Only mods can use this command.");
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

  // !migratedata → one-time LP migration (mods only)
  if (command === "migratedata") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Only admins can use this command.");
    const oldData = [
      { username: 'xfly',        lootPoints: 973 },
      { username: '_valkan',     lootPoints: 893 },
      { username: 'hades_7444',  lootPoints: 488 },
      { username: 'gaz1188',     lootPoints: 387 },
      { username: 'artemas5936', lootPoints: 8   },
      { username: 'teamflight',  lootPoints: 6   },
      { username: 'slacks96',    lootPoints: 6   },
      { username: 'trapbunnies', lootPoints: 6   },
    ];
    const lines = [];
    for (const entry of oldData) {
      const fakeUserId = `migrated_${entry.username}`;
      await User.findOneAndUpdate(
        { username: entry.username },
        { $set: { username: entry.username, lootPoints: entry.lootPoints }, $setOnInsert: { userId: fakeUserId } },
        { upsert: true, new: true }
      );
      lines.push(`✅ ${entry.username} → ${entry.lootPoints} LP`);
    }
    return message.channel.send(`**Migration complete!**\n${lines.join('\n')}`);
  }

  // !removexp → remove XP (mods only)
  if (command === "removexp") {
    if (!isMod(message.member)) return message.reply("❌ Only mods can use this command.");
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
      const cooldown = 60 * 60 * 1000; // 1 hour

      if (!user.lastVoiceJoinXp || (now - user.lastVoiceJoinXp) > cooldown) {
        const prevLevel = user.level;
        const updated = await addXp(userId, username, 50);
        await User.updateOne({ userId }, { lastVoiceJoinXp: now });
        console.log(`${username} earned 50 XP for joining voice.`);

        if (updated.level > prevLevel) {
          try {
            const channel = await client.channels.fetch(process.env.DAILY_CHANNEL_ID);
            channel.send(`🎉 ${username} reached **Level ${updated.level}**!`);
          } catch {}
        }
      }
    } catch (err) {
      console.error("Voice join XP error:", err);
    }

    // Start 30-min interval XP (300 XP every 30 mins)
    voiceIntervals[userId] = setInterval(async () => {
      try {
        // Re-check they are still in a non-AFK channel
        const member = await newState.guild.members.fetch(userId);
        if (!member.voice.channelId || isAfk(member.voice.channel)) return;

        const prevLevel = (await getUser(userId, username)).level;
        const updated = await addXp(userId, username, 300);
        console.log(`${username} earned 300 XP for 30 mins in voice.`);

        if (updated.level > prevLevel) {
          try {
            const channel = await client.channels.fetch(process.env.DAILY_CHANNEL_ID);
            channel.send(`🎉 ${username} reached **Level ${updated.level}**!`);
          } catch {}
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
