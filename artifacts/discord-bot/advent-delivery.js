const crypto = require('node:crypto');
const { AttachmentBuilder, MessageFlags } = require('discord.js');

function splitAnnouncement(text) {
  const chunks = [];
  while (text.length > 2000) {
    let end = Math.max(text.lastIndexOf('\n', 2000), text.lastIndexOf(' ', 2000));
    if (end < 1000) end = 2000;
    // Never split a surrogate pair in the middle of an emoji.
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks.filter(chunk => chunk.trim());
}

async function deliverAnnouncement({ target, recent, marker, delivery, text, bytes, extension = 'png', save, now }) {
  const basename = `${marker.replace(/:/g, '-')}-calendar`;
  const filename = `${basename}.${extension}`;
  const nonce = part => crypto.createHash('sha256').update(`${marker}:${part}`).digest('hex').slice(0, 24);
  // Keep recovery for announcements sent before the move away from embeds.
  const legacy = recent.find(message => message.author.id === delivery.botId
    && message.embeds?.some(embed => embed.footer?.text === marker));
  const image = recent.find(message => message.author.id === delivery.botId
    && (String(message.nonce || '') === nonce('image')
      || message.attachments?.some(attachment => [`${basename}.png`, `${basename}.jpg`].includes(attachment.name))));
  if (delivery.imageMessageId || image || legacy) return delivery.imageMessageId || image?.id || legacy.id;

  const chunks = delivery.textChunks?.length ? delivery.textChunks : splitAnnouncement(text);
  const startedAt = delivery.postingStartedAt || new Date(now());
  // Persist the exact text before posting. A retry after an edit must resume
  // the original announcement rather than mix two versions of its wording.
  await save({ textChunks: chunks, postingStartedAt: startedAt });
  const ids = [...(delivery.textMessageIds || [])];
  for (let i = 0; i < chunks.length; i++) {
    if (ids[i]) continue;
    const ownUnused = message => message.author.id === delivery.botId && !ids.includes(message.id);
    const recovered = recent.find(message => ownUnused(message) && String(message.nonce || '') === nonce(`text-${i}`))
      || recent.find(message => ownUnused(message) && message.content === chunks[i]
        && message.createdTimestamp >= new Date(startedAt).getTime());
    const sent = recovered || await target.send({
      content: chunks[i], allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds,
      nonce: nonce(`text-${i}`), enforceNonce: true,
    });
    ids[i] = sent.id;
    await save({ textMessageIds: [...ids] });
  }
  const sent = await target.send({
    files: [new AttachmentBuilder(bytes, { name: filename })],
    allowedMentions: { parse: [] }, nonce: nonce('image'), enforceNonce: true,
  });
  await save({ imageMessageId: sent.id });
  return sent.id;
}

module.exports = { splitAnnouncement, deliverAnnouncement };
