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
const XP_CHANNEL_ID = "1494732715063509113";

const voiceJoinTime = {};
const voiceIntervals = {};

// --- Level up messages ---
const levelUpMessages = [
  (user, level) => `A wild **${user}** has appeared at level **${level}**!`,
  (user, level) => `**${user}** just leveled up to **${level}**. Let's gooo!`,
  (user, level) => `Yay! You made it, **${user}**! Welcome to level **${level}**!`,
unt} LP from ${user.username}. They now have ${newBalance} LP.`);
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
