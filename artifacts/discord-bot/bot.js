const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const PREFIX = "!";
const COINS_FILE = path.join(__dirname, 'coins.json');

// Load coins from file if exists
let coins = {};
if (fs.existsSync(COINS_FILE)) {
  try {
    coins = JSON.parse(fs.readFileSync(COINS_FILE));
  } catch (err) {
    console.error("Error reading coins.json, starting with empty coins");
    coins = {};
  }
}

// Function to save coins to disk
function saveCoins() {
  fs.writeFileSync(COINS_FILE, JSON.stringify(coins, null, 2));
}

// Startup message
client.once('ready', () => {
  console.log(`${client.user.tag} is online and ready!`);
});

client.on("messageCreate", (message) => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // !cp → check balance
  if (command === "cp") {
    const user = message.mentions.users.first() || message.author;
    const balance = coins[user.id] || 0;
    message.channel.send(`${user.username} has ${balance} CP`);
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
    message.channel.send(`💰 Each user received ${amount} CP`);
  }

  // !add → add an amount of CP to mentioned users
  if (command === "add") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;

    if (isNaN(amount) || users.size === 0) {
      return message.reply("Usage: !add amount @user");
    }

    users.forEach(user => {
      coins[user.id] = (coins[user.id] || 0) + amount;
      message.channel.send(`✅ Added ${amount} CP to ${user.username}. They now have ${coins[user.id]} CP.`);
    });

    saveCoins();
  }

  // !remove → remove an amount of CP from mentioned users
  if (command === "remove") {
    const amount = parseInt(args[0]);
    const users = message.mentions.users;

    if (isNaN(amount) || users.size === 0) {
      return message.reply("Usage: !remove amount @user");
    }

    users.forEach(user => {
      coins[user.id] = (coins[user.id] || 0) - amount;
      message.channel.send(`❌ Removed ${amount} CP from ${user.username}. They now have ${coins[user.id]} CP.`);
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
    message.channel.send(`💖 Each user received ${halfAmount} CP`);
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN environment variable is not set!");
  process.exit(1);
}

client.login(token);
