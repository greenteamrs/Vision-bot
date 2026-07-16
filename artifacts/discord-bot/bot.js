const { Client, GatewayIntentBits, Events } = require('discord.js');
const mongoose = require('mongoose');
const http = require('http');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- MongoDB Setup ---
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

// --- Gemini Vision Setup ---
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

// --- DropTracker monthly XP awards ---
const DROP_TOP_XP = [5000, 4000, 3000, 2000, 1000, 1000, 1000, 1000, 1000, 1000];

async function awardDropTopXp(rankedNames, guild, channel) {
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const lines = [];
  const unmatched = [];

  for (let i = 0; i < rankedNames.length && i < 10; i++) {
    const rsName = rankedNames[i].toLowerCase();
    const xpReward = DROP_TOP_XP[i];

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

  // !leaderboard → XP leaderboard
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

  // !rslink → link your RS name to your Discord account
  // Usage: !rslink YourRsName
  if (command === "rslink") {
    const rsName = args.join(' ').trim();
    if (!rsName) return message.reply("Usage: `!rslink YourRuneScapeName`");

    const existing = await User.findOne({ rsName: { $regex: new RegExp(`^${rsName}$`, 'i') } });
    if (existing && existing.userId !== message.author.id) {
      return message.reply(`❌ The RS name **${rsName}** is already linked to another Discord account.`);
    }

    await User.findOneAndUpdate(
      { userId: message.author.id },
      { $set: { rsName: rsName, username: message.author.username } },
      { upsert: true, new: true }
    );
    message.reply(`✅ Your RS name **${rsName}** has been linked to your Discord account!`);
  }

  // !myrs → check your linked RS name
  if (command === "myrs") {
    const user = await getUser(message.author.id, message.author.username);
    if (!user.rsName) return message.reply("You haven't linked an RS name yet. Use `!rslink YourRsName`");
    message.reply(`Your linked RS name is: **${user.rsName}**`);
  }

  // !rsnames → list all linked RS names (admin only)
  if (command === "rsnames") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Only admins can use this command.");
    const users = await User.find({ rsName: { $ne: null } }).sort({ rsName: 1 });
    if (users.length === 0) return message.channel.send("No RS names linked yet.");
    const lines = users.map(u => `• **${u.rsName}** → ${u.username || u.userId}`);
    message.channel.send(`📋 **Linked RS Names (${users.length}):**\n${lines.join('\n')}`);
  }

  // !rsset → admin sets RS name for any user
  // Usage: !rsset @user RsName
  if (command === "rsset") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Only admins can use this command.");
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

  // !droptop → read a screenshot of the monthly loot leaderboard and award XP
  // Usage: !droptop (with an image attached)
  if (command === "droptop") {
    if (!message.member.permissions.has('Administrator')) return message.reply("❌ Only admins can use this command.");
    if (!process.env.GEMINI_API_KEY) return message.reply("❌ GEMINI_API_KEY is not set.");

    const attachment = message.attachments.first();
    if (!attachment) return message.reply("❌ Please attach a screenshot of the DropTracker leaderboard.\nUsage: `!droptop` with an image attached.");

    const processingMsg = await message.channel.send("⏳ Reading leaderboard screenshot with AI, please wait...");

    try {
      const names = await extractLeaderboardFromImage(attachment.url);

      if (!Array.isArray(names) || names.length === 0) {
        await processingMsg.delete().catch(() => {});
        return message.channel.send("❌ Couldn't extract any names from the image. Please try a clearer screenshot.");
      }

      await processingMsg.delete().catch(() => {});

      const preview = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
      await message.channel.send(`📋 **Detected rankings:**\n${preview}\n\nAwarding XP now...`);

      await awardDropTopXp(names, message.guild, message.channel);
    } catch (err) {
      console.error("!droptop error:", err);
      await processingMsg.delete().catch(() => {});
      message.channel.send(`❌ Failed to read the screenshot: ${err.message}`);
    }
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

  // !addxp → add XP (admin only)
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

  // !removexp → remove XP (admin only)
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

  // !help → list available commands
  if (command === "help") {
    message.channel.send(`📖 **Visionary Bot Commands**

**XP & Levels**
\`!xp [@user]\` — Check XP and level
\`!level [@user]\` — Check current level
\`!leaderboard\` / \`!xptop\` — XP leaderboard

**Loot Points**
\`!lp [@user]\` — Check LP balance
\`!total\` — LP leaderboard
\`!split <amount> @users\` — Give each user LP
\`!donate <amount> @users\` — Give each user half LP
\`!add <amount> @user\` — Add LP
\`!remove <amount> @user\` — Remove LP

**RS Name Linking**
\`!rslink <rsname>\` — Link your RS name to Discord
\`!myrs\` — Check your linked RS name

**Admin Only**
\`!addxp <amount> @user\` — Add XP
\`!removexp <amount> @user\` — Remove XP
\`!rsnames\` — List all linked RS names
\`!rsset @user <rsname>\` — Link RS name for any user
\`!droptop\` — Award monthly XP from a screenshot (attach image)`);
  }
});

// --- Voice XP ---
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId = newState.member?.id || oldState.member?.id;
  const username = newState.member?.user?.username || oldState.member?.user?.username;
  if (!userId || newState.member?.user?.bot) return;

  const isAfk = (channel) => channel && channel.id === "155520058762723328";

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
    }, 30 * 60 * 1000);
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
