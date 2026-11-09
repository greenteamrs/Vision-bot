const mongoose = require('mongoose');

const dmSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  authorId: { type: String, required: true },
  username: { type: String, default: '' },
  displayName: { type: String, default: '' },
  content: { type: String, default: '' },
  sentAt: { type: Date, required: true },
  readAt: { type: Date, default: null },
  attachments: [{
    _id: false,
    name: String,
    url: String,
    size: Number,
  }],
}, { timestamps: true });

const BotDirectMessage = mongoose.model('BotDirectMessage', dmSchema);

function createDmInbox({ Message = BotDirectMessage } = {}) {
  async function capture(message) {
    if (message.guildId || message.author?.bot || !message.author || message.webhookId) return false;
    const attachments = [...(message.attachments?.values() || [])].map(attachment => ({
      name: attachment.name || 'Attachment',
      url: attachment.url,
      size: attachment.size,
    }));
    // Replayed Discord gateway events must not create duplicate inbox entries.
    await Message.updateOne({ messageId: message.id }, { $setOnInsert: {
      messageId: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      username: message.author.username,
      displayName: message.author.globalName || message.author.username,
      content: message.content || '',
      sentAt: new Date(message.createdTimestamp),
      attachments,
    } }, { upsert: true });
    return true;
  }

  async function list(before = '') {
    if (before && !/^[a-f\d]{24}$/i.test(before)) {
      throw Object.assign(new Error('Invalid inbox cursor.'), { status: 400 });
    }
    const messages = await Message.find(before ? { _id: { $lt: before } } : {})
      .sort({ _id: -1 }).limit(51).lean();
    const hasMore = messages.length > 50;
    const page = messages.slice(0, 50);
    return { messages: page, nextCursor: hasMore ? String(page[page.length - 1]._id) : null };
  }
  async function count() {
    // null also matches legacy messages created before read tracking existed.
    return { count: await Message.countDocuments({ readAt: null }) };
  }
  async function markRead(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 ||
        ids.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) {
      throw Object.assign(new Error('Provide between 1 and 50 valid message IDs.'), { status: 400 });
    }
    await Message.updateMany({ _id: { $in: [...new Set(ids)] }, readAt: null },
      { $set: { readAt: new Date() } });
    return count();
  }
  return { capture, list, count, markRead };
}

module.exports = { BotDirectMessage, createDmInbox };
