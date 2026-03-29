const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs'); // For persistent storage

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const PREFIX = "!";

// Load coins from file if exists
let coins = {};
if (fs.existsSync('coins.json')) {
  try {
    coins = JSON.parse(fs.readFileSync('coins.json'));
  } catch (err) {
    console.error("Error reading coins.json, starting with empty coins");
    coins = {};
  }
}

// Function to save coins to disk
function saveCoins() {
  fs.writeFileSync('coins.json', JSON.stringify(coins, null, 2));
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

    saveCoins(); // Save after updating
    message.channel.send(`💰 Each user received ${amount} CP`);
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

    saveCoins(); // Save after updating
    message.channel.send(`💖 Each user received ${halfAmount} CP`);
  }
});

// Replace with your actual token (keep it in quotes!)
client.login("MTQ4NzgyNjA2OTQ0MzgzNzk2Mg.GOCP22.QC4MSGEPj178RNA-iE6IKeNv15KB8dtOqj4fpU");