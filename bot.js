const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const PREFIX = "!";
const COINS_FILE = path.join(__dirname, 'coins.json');

// Load loot points from file if exists
let coins = {};
if (fs.existsSync(COINS_FILE)) {
  try {
    coins = JSON.parse(fs.readFileSync(COINS_FILE));
  } catch (err) {
    console.error("Error reading coins.json, starting with empty loot points");
    coins = {};
  }
}

// Function to save loot points to disk
function saveCoins() {
  fs.writeFileSync(COINS_FILE, JSON.stringify(coins, null, 2));
}

// Startup message
client.once('ready', () => {
  console.log(`${client.user.tag} is online and ready!`);
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

    saveCoins();
    message.channel.send(`💰 Each user received ${amount} LP`);
  }

  // !add → add an amount of LP to mentioned users
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

    saveCoins();
  }

  // !remove → remove an amount of LP from mentioned users
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

    saveCoins();
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

    saveCoins();
    message.channel.send(`💖 Each user received ${halfAmount} LP`);
  }

  // !total → show leaderboard of all loot points sorted highest to lowest
  if (command === "total") {
    if (Object.keys(coins).length === 0) {
      return message.channel.send("No loot points recorded yet!");
    }

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

    message.channel.send(`🏆 **Loot Points Leaderboard**\n${lines.join("\n")}`);
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
