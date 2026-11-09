const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const { randomUUID } = require('node:crypto');

function normalizeEventLink(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > 1000) throw new Error('Event link must be 1000 characters or fewer.');
  let url;
  try { url = new URL(text); } catch { throw new Error('Enter a valid http or https event link.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter a valid http or https event link without login credentials.');
  }
  return url.href;
}

function reminderMessage(event) {
  const timestamp = Math.floor(new Date(event.start).getTime() / 1000);
  return `Event reminder: ${event.name.slice(0, 150)}\nStarts: <t:${timestamp}:F> (<t:${timestamp}:R>)\nPlease make a post in the event channel for this event.${event.link ? `\nEvent / tracker link: ${event.link}` : ''}`;
}

function createEventReminderService({ CalendarEvent, OsrsEvent, Delivery, client, isMod, isAdmin, now = () => new Date(), logger = console }) {
  let running = false;
  async function getRecipients() {
    const recipients = new Map();
    for (const guild of client.guilds.cache.values()) {
      await guild.roles.fetch();
      const members = await guild.members.fetch();
      for (const member of members.values()) {
        if (!member.user.bot && (isMod(member) || isAdmin(member))) recipients.set(member.id, member);
      }
    }
    return recipients;
  }

  async function resend(kind, id) {
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    if (!client.isReady()) fail(503, 'The Discord bot is offline. Notifications can only be sent by the running bot on Render.');
    if (!['calendar', 'event'].includes(kind) || !/^[a-f\d]{24}$/i.test(id)) fail(400, 'Invalid event.');
    const record = await (kind === 'calendar' ? CalendarEvent : OsrsEvent).findById(id).lean();
    if (!record) fail(404, 'Event not found.');
    const start = kind === 'calendar' ? record.start : record.startsAt;
    if (new Date(start) <= now() ||
        (kind === 'event' && !['upcoming', 'active'].includes(record.status))) {
      fail(400, 'Only scheduled events that have not started can send a notification.');
    }
    const event = { id: `${kind}:${id}`, name: record.title || record.name, start, link: record.link };
    const recipients = await getRecipients();
    if (!recipients.size) fail(400, 'No Discord moderators or administrators were found.');
    const key = `resend:${event.id}`;
    try {
      // Persistent cooldown also protects against other dashboard sessions.
      await Delivery.findOneAndUpdate({
        key, nextAttemptAt: { $lte: now() },
      }, {
        $set: { nextAttemptAt: new Date(now().getTime() + 60 * 1000), status: 'manual' },
        $setOnInsert: { key },
        $inc: { attempts: 1 },
      }, { upsert: true, new: true });
    } catch (error) {
      if (error.code === 11000) fail(429, 'A notification was just requested. Please wait one minute before resending.');
      throw error;
    }
    const batch = randomUUID();
    const result = { sent: 0, blocked: 0, failed: 0, total: recipients.size };
    for (const [userId, member] of recipients) {
      let status = 'sent';
      let lastError = '';
      try {
        await member.send({ content: reminderMessage(event), allowedMentions: { parse: [] } });
      } catch (error) {
        status = [50007, 50013].includes(Number(error.code)) ? 'blocked' : 'failed';
        lastError = String(error.code || 'DM delivery failed');
        logger.warn(`[Event reminders] Manual ${event.id}: DM to ${userId} ${status} (${lastError})`);
      }
      result[status]++;
      await Delivery.updateOne({ key: `manual:${event.id}:${batch}:${userId}` }, { $set: {
        status, attempts: 1, sentAt: status === 'sent' ? now() : null, lastError,
      } }, { upsert: true });
    }
    return result;
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      const time = now();
      const window = { $gt: time, $lte: new Date(time.getTime() + WEEK_MS) };
      const [calendar, managed] = await Promise.all([
        CalendarEvent.find({ start: window }).lean(),
        OsrsEvent.find({ startsAt: window, status: { $in: ['upcoming', 'active'] } }).lean(),
      ]);
      const events = [
        ...calendar.map(e => ({ id: `calendar:${e._id}`, name: e.title, start: e.start, link: e.link })),
        ...managed.map(e => ({ id: `event:${e._id}`, name: e.name, start: e.startsAt, link: e.link })),
      ];
      if (!events.length) return;
      const recipients = await getRecipients();
      for (const event of events) {
        for (const [userId, member] of recipients) {
          const key = `${event.id}:${new Date(event.start).toISOString()}:${userId}`;
          let claim;
          try {
            // Unique key plus a lease prevents simultaneous runs/restarts from
            // sending the same reminder. Successful sends are never re-claimed.
            claim = await Delivery.findOneAndUpdate({
              key, status: { $nin: ['sent', 'blocked', 'failed'] },
              nextAttemptAt: { $lte: time },
            }, {
              $set: { nextAttemptAt: new Date(time.getTime() + 15 * 60 * 1000) },
              $setOnInsert: { key, status: 'pending' },
              $inc: { attempts: 1 },
            }, { upsert: true, new: true });
          } catch (error) {
            if (error.code === 11000) continue; // Already sent or leased.
            throw error;
          }
          let result;
          try {
            await member.send({ content: reminderMessage(event), allowedMentions: { parse: [] } });
            result = { status: 'sent', sentAt: now(), lastError: '' };
          } catch (error) {
            const blocked = [50007, 50013].includes(Number(error.code));
            result = {
              status: blocked ? 'blocked' : claim.attempts >= 3 ? 'failed' : 'pending',
              lastError: String(error.code || 'DM delivery failed'),
            };
            logger.warn(`[Event reminders] ${event.id}: DM to ${userId} ${result.status} (${result.lastError})`);
          }
          // Do not treat a persistence error after sending as a Discord failure.
          await Delivery.updateOne({ key }, { $set: result });
        }
      }
    } catch (error) {
      logger.error('[Event reminders] Check failed:', error.message);
    } finally {
      running = false;
    }
  }
  return { run, resend };
}

module.exports = { WEEK_MS, normalizeEventLink, reminderMessage, createEventReminderService };
