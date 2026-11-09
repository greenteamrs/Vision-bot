const mongoose = require('mongoose');

const API = 'https://prices.runescape.wiki/api/v1/osrs';
const USER_AGENT = 'VisionaryBot price alerts - OSRS clan Discord bot';
const MAPPING_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_DM_MS = 30 * 60 * 1000;
const MAX_ALERTS_PER_USER = 25;
const MAX_PRICE = 100_000_000_000;

const priceAlertSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  itemId: { type: Number, required: true },
  itemName: { type: String, required: true },
  direction: { type: String, enum: ['below', 'above'], required: true },
  priceType: { type: String, enum: ['buy', 'sell'], default: 'buy' },
  targetPrice: { type: Number, required: true },
  // True after a DM was sent; re-arms when the price moves back across the target.
  triggered: { type: Boolean, default: false },
  nextAttemptAt: { type: Date, default: null },
  lastPrice: { type: Number, default: null },
  lastNotifiedAt: { type: Date, default: null },
}, { timestamps: true });
priceAlertSchema.index({ userId: 1, itemId: 1, direction: 1, priceType: 1, targetPrice: 1 }, { unique: true });
const PriceAlert = mongoose.model('PriceAlert', priceAlertSchema);

// Accepts 1500000, 1.5m, 250k, 2,5m and 2.1b.
function parsePrice(input) {
  const match = String(input ?? '').trim().toLowerCase().replace(/\s/g, '')
    .match(/^(\d+(?:[.,]\d+)?|[.,]\d+)([kmb])?$/);
  if (!match) return null;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[match[2]] || 1;
  const value = Math.round(Number(match[1].replace(',', '.')) * multiplier);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_PRICE ? value : null;
}

const fmt = value => new Intl.NumberFormat('en-US').format(value).replace(/,/g, '');

function currentPrice(entry, priceType) {
  const value = priceType === 'sell' ? entry?.low : entry?.high;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isReached(alert, price) {
  return alert.direction === 'below' ? price <= alert.targetPrice : price >= alert.targetPrice;
}

function alertMessage(alert, price) {
  const wiki = `https://prices.runescape.wiki/osrs/item/${alert.itemId}`;
  return `Price alert: ${alert.itemName}\n` +
    `The ${alert.priceType === 'sell' ? 'sell (instant-sell)' : 'buy (instant-buy)'} price is now ${fmt(price)} gp, ` +
    `${alert.direction === 'below' ? 'at or below' : 'at or above'} your target of ${fmt(alert.targetPrice)} gp.\n${wiki}`;
}

function createPriceAlertService({
  Alert = PriceAlert, client, fetchJson, now = () => new Date(), logger = console,
} = {}) {
  let items = null;
  let itemsFetchedAt = 0;
  let running = false;

  const get = fetchJson || (async path => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${API}${path}`, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
      if (!res.ok) throw new Error(`Price API returned HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timeout); }
  });

  async function loadItems() {
    if (items && now().getTime() - itemsFetchedAt < MAPPING_TTL_MS) return items;
    try {
      const mapping = await get('/mapping');
      if (!Array.isArray(mapping) || !mapping.length) throw new Error('Invalid item list.');
      items = mapping.filter(item => Number.isInteger(item.id) && item.name);
      itemsFetchedAt = now().getTime();
    } catch (error) {
      // Keep using the older list when the wiki is briefly unavailable.
      if (!items) throw error;
      logger.warn(`[Price alerts] Could not refresh item list: ${error.message}`);
    }
    return items;
  }

  async function searchItems(query) {
    const list = await loadItems();
    const text = String(query || '').trim().toLowerCase();
    const matches = text
      ? list.filter(item => item.name.toLowerCase().includes(text))
          .sort((a, b) => Number(b.name.toLowerCase().startsWith(text)) - Number(a.name.toLowerCase().startsWith(text)) || a.name.localeCompare(b.name))
      : list.slice(0, 25);
    return matches.slice(0, 25);
  }

  async function add({ userId, itemId, direction, priceType = 'buy', targetPrice }) {
    const fail = message => { throw Object.assign(new Error(message), { userFacing: true }); };
    const item = (await loadItems()).find(entry => String(entry.id) === String(itemId));
    if (!item) fail('Choose an item from the suggestions list.');
    if (!['below', 'above'].includes(direction) || !['buy', 'sell'].includes(priceType)) fail('Invalid alert type.');
    const price = parsePrice(targetPrice);
    if (!price) fail('Enter a valid price, for example 1500000, 1.5m or 250k.');
    if (await Alert.countDocuments({ userId }) >= MAX_ALERTS_PER_USER) fail(`You can have at most ${MAX_ALERTS_PER_USER} price alerts.`);
    try {
      const alert = await Alert.create({ userId, itemId: item.id, itemName: item.name, direction, priceType, targetPrice: price });
      return alert.toObject ? alert.toObject() : alert;
    } catch (error) {
      if (error.code === 11000) fail('You already have that exact alert.');
      throw error;
    }
  }

  const list = userId => Alert.find({ userId }).sort({ itemName: 1, targetPrice: 1 }).lean();

  async function remove(userId, id) {
    if (!/^[a-f\d]{24}$/i.test(String(id))) return false;
    const result = await Alert.deleteOne({ _id: id, userId });
    return result.deletedCount === 1;
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      const alerts = await Alert.find({}).lean();
      if (!alerts.length) return;
      const prices = (await get('/latest')).data || {};
      for (const alert of alerts) {
        const price = currentPrice(prices[String(alert.itemId)], alert.priceType);
        if (price === null) continue;
        const reached = isReached(alert, price);
        if (!reached) {
          // Re-arm once the price has moved back across the target.
          if (alert.triggered) await Alert.updateOne({ _id: alert._id }, { $set: { triggered: false, lastPrice: price, nextAttemptAt: null } });
          else if (alert.lastPrice !== price) await Alert.updateOne({ _id: alert._id }, { $set: { lastPrice: price } });
          continue;
        }
        if (alert.triggered) continue;
        const time = now();
        if (alert.nextAttemptAt && new Date(alert.nextAttemptAt) > time) continue;
        // Claim before sending so overlapping runs cannot send the same DM twice.
        const claim = await Alert.updateOne(
          { _id: alert._id, triggered: false, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: time } }] },
          { $set: { nextAttemptAt: new Date(time.getTime() + RETRY_DM_MS), lastPrice: price } });
        if (!claim.modifiedCount && !claim.nModified) continue;
        try {
          const user = await client.users.fetch(alert.userId);
          await user.send({ content: alertMessage(alert, price), allowedMentions: { parse: [] } });
          await Alert.updateOne({ _id: alert._id }, { $set: { triggered: true, lastNotifiedAt: now(), nextAttemptAt: null } });
        } catch (error) {
          logger.warn(`[Price alerts] DM to ${alert.userId} failed (${error.code || error.message}); retrying later.`);
        }
      }
    } catch (error) {
      logger.error('[Price alerts] Check failed:', error.message);
    } finally {
      running = false;
    }
  }

  return { searchItems, add, list, remove, run };
}

module.exports = {
  PriceAlert, parsePrice, alertMessage, createPriceAlertService, MAX_ALERTS_PER_USER, fmt,
};
