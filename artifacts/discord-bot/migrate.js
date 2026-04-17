const mongoose = require('mongoose');

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

const data = [
  { username: 'xfly',        lootPoints: 973 },
  { username: '_valkan',     lootPoints: 893 },
  { username: 'hades_7444',  lootPoints: 488 },
  { username: 'gaz1188',     lootPoints: 387 },
  { username: 'artemas5936', lootPoints: 8   },
  { username: 'teamflight',  lootPoints: 6   },
  { username: 'slacks96',    lootPoints: 6   },
  { username: 'trapbunnies', lootPoints: 6   },
];

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  for (const entry of data) {
    const fakeUserId = `migrated_${entry.username}`;
    await User.findOneAndUpdate(
      { username: entry.username },
      { $set: { username: entry.username, lootPoints: entry.lootPoints }, $setOnInsert: { userId: fakeUserId } },
      { upsert: true, new: true }
    );
    console.log(`✅ ${entry.username} → ${entry.lootPoints} LP`);
  }

  console.log('Migration complete!');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
