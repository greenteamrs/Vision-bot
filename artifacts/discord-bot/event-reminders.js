const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
      const recipients = new Map();
      for (const guild of client.guilds.cache.values()) {
        // Fetch fresh members/roles so moderator changes are respected.
        await guild.roles.fetch();
        const members = await guild.members.fetch();
        for (const member of members.values()) {
          if (!member.user.bot && (isMod(member) || isAdmin(member))) recipients.set(member.id, member);
        }
      }
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
  return { run };
}

module.exports = { WEEK_MS, normalizeEventLink, reminderMessage, createEventReminderService };
