const { Client, GatewayIntentBits } = require('discord.js');
const https = require('https');
const http = require('http');
const cron = require('node-cron');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const PREFIX = "!";
const BIN_ID = process.env.JSONBIN_BIN_ID;
const API_KEY = process.env.JSONBIN_API_KEY;

// In-memory loot points (loaded from JSONBin on startup)
let coins = {};

// Read loot points from JSONBin
function loadCoins() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${BIN_ID}/latest`,
      method: 'GET',
      headers: { 'X-Master-Key': API_KEY }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.record || {});
        } catch {
          resolve({});
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Save loot points to JSONBin
function saveCoins() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(coins);
    const options = {
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${BIN_ID}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': API_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Helper to build leaderboard text
async function buildLeaderboard() {
  if (Object.keys(coins).length === 0) return "No loot points recorded yet!";

  const sorted = Object.entries(coins).sort((a, b) => b[1] - a[1]);

  const lines = await Promise.all(
    sorted.map(async ([userId, amount], index) => {
      try {
        const user = await client.users.fetch(userId);
        return `${index + 1}. ${user.username} — ${amount} LP`;
      } catch {
        return `${index + 1}. Unknown User — ${amount} LP`;
      }
    })
  );

  return `🏆 **Loot Points Leaderboard**\n${lines.join("\n")}`;
}

// Startup: load coins, post online message + leaderboard, schedule daily summary
client.once('ready', async () => {
  console.log(`${client.user.tag} is online and ready!`);

  try {
    coins = await loadCoins();
    console.log("Loot points loaded from JSONBin.");
  } catch (err) {
    console.error("Failed to load loot points from JSONBin:", err);
  }

  const channelId = process.env.DAILY_CHANNEL_ID;
  if (!channelId) {
    console.warn("DAILY_CHANNEL_ID not set — skipping channel messages.");
    return;
  }

  // Post startup message + leaderboard
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
      console.log("Daily leaderboard posted.");
    } catch (err) {
      console.error("Failed to post daily leaderboard:", err);
    }
  });

  console.log("Daily leaderboard scheduled for 11:59 PM UTC.");
});

client.on("messageCreate", async (message) => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // !lp → check balance
  if (command === "lp") {
    const user = message.mentions.users.first() || message.author;
    const balance = coins[user.id] || 0;
    message.channel.send(`${user.username} has ${balance} LP`);
  }

  // !split → give each user full amount
  if (command === "split") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;

    if (isNaN(amount) || users.size === 0) {
      return message.reply("Usage: !split amount @users");
    }

    users.forEach(user => {
      coins[user.id] = (coins[user.id] || 0) + amount;
    });

    await saveCoins();
    message.channel.send(`💰 Each user received ${amount} LP`);
  }

  // !add → add LP to mentioned users
  if (command === "add") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;

    if (isNaN(amount) || users.size === 0) {
      return message.reply("Usage: !add amount @user");
    }

    users.forEach(user => {
      coins[user.id] = (coins[user.id] || 0) + amount;
      message.channel.send(`✅ Added ${amount} LP to ${user.username}. They now have ${coins[user.id]} LP.`);
    });

    await saveCoins();
  }

  // !remove → remove LP from mentioned users
  if (command === "remove") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;

    if (isNaN(amount) || users.size === 0) {
      return message.reply("Usage: !remove amount @user");
    }

    users.forEach(user => {
      coins[user.id] = (coins[user.id] || 0) - amount;
      message.channel.send(`❌ Removed ${amount} LP from ${user.username}. They now have ${coins[user.id]} LP.`);
    });

    await saveCoins();
  }

  // !donate → give each user half the amount
  if (command === "donate") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;

    if (isNaN(amount) || users.size === 0) {
      return message.reply("Usage: !donate amount @users");
    }

    const halfAmount = Math.floor(amount / 2);

    users.forEach(user => {
      coins[user.id] = (coins[user.id] || 0) + halfAmount;
    });

    await saveCoins();
    message.channel.send(`💖 Each user received ${halfAmount} LP`);
  }

  // !total → show leaderboard
  if (command === "total") {
    const leaderboard = await buildLeaderboard();
    message.channel.send(leaderboard);
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN environment variable is not set!");
  process.exit(1);
}

client.login(token);

// Keep-alive HTTP server so Render doesn't spin the service down
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is alive!");
}).listen(PORT, () => {
  console.log(`Keep-alive server running on port ${PORT}`);
});
