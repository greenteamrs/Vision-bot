const crypto = require('crypto');
const { AttachmentBuilder } = require('discord.js');
const models = require('./advent-models');
const { TEST_CHANNEL_ID, clock, challengeText, settingsInput, actionUpdate, assertAccepting } = require('./advent-domain');
const { renderCalendar } = require('./advent-calendar');
const { imageDay, normalizePng, readImageBody, createAdventImageStore } = require('./advent-images');

function createAdventService({
  client, readBody, sendJson, dashboardEditBlocked,
  AdventTest = models.AdventTest,
  AdventSubmission = models.AdventSubmission,
  AdventAnnouncement = models.AdventAnnouncement,
  now = Date.now,
  imageStore = createAdventImageStore(),
}) {
  // One queue covers actions, submissions and announcements: an advance cannot
  // switch days halfway through accepting proof or building the daily image.
  let queue = Promise.resolve();
  function serial(work) {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  }

  async function getConfig() {
    try {
      return await AdventTest.findOneAndUpdate({ _id: 'test' },
        { $setOnInsert: { _id: 'test' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      return AdventTest.findById('test').lean();
    }
  }

  async function update(config, values) {
    const saved = await AdventTest.findOneAndUpdate(
      { _id: 'test', revision: config.revision },
      { $set: values, $inc: { revision: 1 } },
      { new: true, runValidators: true },
    ).lean();
    if (!saved) throw new Error('The test changed in another session. Refresh and try again.');
    return saved;
  }

  async function channel() {
    const target = await client.channels.fetch(TEST_CHANNEL_ID);
    if (!target?.isTextBased() || !target.guildId || typeof target.send !== 'function') {
      throw new Error('The advent test channel is unavailable or is not a server text channel.');
    }
    return target;
  }

  async function calendarImage(config, run) {
    const day = Math.min(25, run.opened);
    const custom = (config.calendarImages || []).find(image => image.day === day);
    return custom ? imageStore.get(custom.fileId) : renderCalendar(config, run);
  }

  async function removeUnusedImage(fileId) {
    if (!fileId) return;
    try { await imageStore.remove(fileId); } catch (error) {
      console.error('[Advent] Could not clean up unused calendar image:', error.message);
    }
  }

  async function freshProof(submission) {
    // Discord signs attachment links. Refresh expired links from their source
    // message instead of persisting image bytes or depending on a permanent URL.
    try {
      const expiry = new URL(submission.proofUrl).searchParams.get('ex');
      if (!expiry || parseInt(expiry, 16) * 1000 > now() + 60000) return;
      const original = await (await channel()).messages.fetch(submission.messageId);
      const attachment = original.attachments.get(submission.attachmentId);
      if (attachment) {
        submission.proofUrl = attachment.url;
        await AdventSubmission.updateOne({ _id: submission._id }, { $set: { proofUrl: attachment.url } });
      }
    } catch (_) {
      // Keep the source link visible; the dashboard can still show the error
      // placeholder and reviewers can inspect the original Discord message.
      submission.proofUnavailable = true;
    }
  }

  async function snapshot() {
    const config = await getConfig();
    const [submissions, announcements] = await Promise.all([
      AdventSubmission.find({ runId: config.runId }).sort({ createdAt: -1 }).lean(),
      AdventAnnouncement.find({ runId: config.runId }).sort({ day: 1 }).lean(),
    ]);
    // Limit concurrent Discord requests while refreshing old attachment links.
    for (let i = 0; i < submissions.length; i += 5) {
      await Promise.all(submissions.slice(i, i + 5).map(freshProof));
    }
    return {
      config: {
        year: config.year, challenges: config.challenges,
        dayDurationSeconds: config.dayDurationSeconds, channelId: TEST_CHANNEL_ID,
        calendarImages: (config.calendarImages || []).map(({ day, size, updatedAt }) => ({ day, size, updatedAt })),
      },
      run: clock(config, now()), submissions, announcements,
    };
  }

  async function announce(config) {
    const run = clock(config, now());
    if (run.state === 'idle' || run.state === 'paused' || run.day < 1) return;
    const key = { runId: config.runId, day: run.day };
    const marker = `advent-test:${config.runId}:${run.day}`;
    let delivery;
    try {
      delivery = await AdventAnnouncement.findOneAndUpdate({
        ...key,
        $or: [{ status: 'failed' }, { status: 'sending', leaseUntil: { $lte: new Date(now()) } }],
      }, {
        $set: { status: 'sending', leaseUntil: new Date(now() + 120000), error: '' },
      }, { upsert: true, new: true }).lean();
    } catch (error) {
      if (error.code === 11000) return; // Sent already, or another process owns the lease.
      throw error;
    }
    try {
      const target = await channel();
      // Recovery after a restart between Discord delivery and saving messageId.
      // Snowflake nonce also guards Discord's recent-message retry window.
      const recent = await target.messages.fetch({ limit: 100 });
      let sent = recent.find(message => message.author.id === client.user.id
        && message.embeds?.some(embed => embed.footer?.text === marker));
      if (!sent) {
        const completed = run.day > 25;
        const description = completed
          ? 'The test calendar is complete. Picture submissions are closed. Staff can still review submissions in the dashboard.'
          : `**${config.challenges[run.day - 1]}**\n\nComplete this challenge during the current test day. Attach a screenshot to \`!advent submit\` in this channel. Staff will review it.\nCloses <t:${Math.floor(new Date(run.dayEndsAt).getTime() / 1000)}:F>.\n${config.dayDurationSeconds !== 86400 ? `Accelerated test: one day lasts ${config.dayDurationSeconds} seconds.` : 'The test clock simulates a December day; advance it from the dashboard.'}`;
        const nonce = crypto.createHash('sha256').update(marker).digest('hex').slice(0, 24);
        sent = await target.send({
          content: `**TEST ONLY — ${completed ? 'Advent calendar complete' : `December ${run.day} advent challenge`}**`,
          embeds: [{
            title: completed ? 'All 25 doors are open' : `Vision Advent • December ${run.day}`,
            description,
            color: 0xdabe81,
            image: { url: 'attachment://advent-calendar.png' },
            footer: { text: marker },
          }],
          files: [new AttachmentBuilder(await calendarImage(config, run), { name: 'advent-calendar.png' })],
          allowedMentions: { parse: [] },
          nonce, enforceNonce: true,
        });
      }
      await AdventAnnouncement.updateOne({ _id: delivery._id }, {
        $set: { status: 'sent', messageId: sent.id, leaseUntil: null, error: '' },
      });
    } catch (error) {
      await AdventAnnouncement.updateOne({ _id: delivery._id }, {
        $set: { status: 'failed', leaseUntil: null, error: String(error.message).slice(0, 500) },
      });
      console.error('[Advent] Test announcement failed:', error.message);
      // Recorded in the dashboard and retried by the next scheduler tick.
    }
  }

  async function run() {
    return serial(async () => {
      const config = await getConfig();
      await announce(config);
    });
  }

  async function handleMessage(message) {
    if (message.author.bot || !message.guildId || !/^!advent(?:\s|$)/i.test(message.content || '')) return false;
    // Test mode must not announce or reply in live channels.
    if (message.channelId !== TEST_CHANNEL_ID) return false;
    await serial(async () => {
      try {
        if (!/^!advent\s+submit(?:\s|$)/i.test(message.content)) {
          throw new Error('Attach your screenshot and send `!advent submit` for the current day’s challenge.');
        }
        const config = await getConfig();
        const current = assertAccepting(config, { channelId: message.channelId, now: now() });
        const image = message.attachments.find(item => item.contentType?.startsWith('image/')
          || (!item.contentType && /\.(png|jpe?g|gif|webp)$/i.test(item.name || '')));
        if (!image) throw new Error('Attach a screenshot image (PNG, JPG, GIF or WebP). Links alone are not picture submissions.');
        const key = { runId: config.runId, day: current.day, userId: message.author.id };
        const values = {
          challenge: config.challenges[current.day - 1],
          username: message.author.username,
          proofUrl: image.url, messageId: message.id, attachmentId: image.id,
          note: message.content.replace(/^!advent\s+submit\s*/i, '').slice(0, 1000),
          status: 'pending', reviewNote: '', reviewedBy: '',
        };
        try {
          await AdventSubmission.findOneAndUpdate({ ...key, status: 'rejected' },
            { $set: values }, { upsert: true, new: true, runValidators: true });
        } catch (error) {
          if (error.code === 11000) throw new Error('You already have a pending or approved picture for today. Rejected pictures can be resubmitted.');
          throw error;
        }
        await message.reply({
          content: `TEST: your December ${current.day} picture was submitted for staff review.`,
          allowedMentions: { repliedUser: false },
        });
      } catch (error) {
        await message.reply({ content: error.message, allowedMentions: { parse: [], repliedUser: false } });
      }
    });
    return true;
  }

  async function handleApi(req, res, pathname, _params, authUser) {
    if (!pathname.startsWith('/api/advent/')) return false;
    const base = '/api/advent/test';
    try {
      if (req.method === 'GET' && pathname === base) {
        sendJson(res, 200, await snapshot());
        return true;
      }
      if (req.method === 'GET' && pathname === `${base}/calendar.png`) {
        const config = await getConfig();
        const run = _params?.has('day')
          ? { day: imageDay(_params.get('day')), opened: imageDay(_params.get('day')) }
          : clock(config, now());
        const bytes = await calendarImage(config, run);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(bytes);
        return true;
      }
      if (!['admin', 'mod'].includes(authUser?.role)) {
        sendJson(res, 403, { error: 'Staff access required.' });
        return true;
      }
      const imageSlot = pathname.match(/^\/api\/advent\/test\/images\/(\d+)$/);
      if (imageSlot && ['POST', 'DELETE'].includes(req.method)) {
        const day = imageDay(imageSlot[1]);
        if (await dashboardEditBlocked(authUser, res, [`advent.test.image.${day}`])) {
          req.resume?.();
          return true;
        }
        const bytes = req.method === 'POST' ? await normalizePng(await readImageBody(req)) : null;
        await serial(async () => {
          const config = await getConfig();
          const previous = (config.calendarImages || []).find(image => image.day === day);
          const calendarImages = (config.calendarImages || []).filter(image => image.day !== day);
          let newId;
          try {
            if (bytes) {
              newId = await imageStore.put(bytes, day);
              calendarImages.push({ day, fileId: newId, size: bytes.length, updatedAt: new Date(now()) });
            }
            await update(config, { calendarImages });
          } catch (error) {
            await removeUnusedImage(newId);
            throw error;
          }
          await removeUnusedImage(previous?.fileId);
          sendJson(res, 200, await snapshot());
        });
        return true;
      }
      const challenge = pathname.match(/^\/api\/advent\/test\/challenges\/(\d+)$/);
      const review = pathname.match(/^\/api\/advent\/test\/submissions\/([a-f\d]{24})\/review$/i);
      if ((req.method === 'PATCH' && (pathname === base || challenge))
        || (req.method === 'POST' && (pathname === `${base}/actions` || review))) {
        const body = await readBody(req);
        await serial(async () => {
          let config = await getConfig();
          if (challenge) {
            const day = Number(challenge[1]);
            if (day < 1 || day > 25) throw new Error('Choose a day between 1 and 25.');
            const text = challengeText(body.text);
            if (await dashboardEditBlocked(authUser, res, [`advent.test.challenge.${day}`])) return;
            const challenges = [...config.challenges];
            challenges[day - 1] = text;
            await update(config, { challenges });
          } else if (review) {
            if (!['approved', 'rejected'].includes(body.status)) throw new Error('Choose approve or reject.');
            if (await dashboardEditBlocked(authUser, res, [`advent.test.submission.${review[1]}.review`])) return;
            const submission = await AdventSubmission.findOneAndUpdate({
              _id: review[1], runId: config.runId, status: 'pending',
            }, { $set: {
              status: body.status, reviewNote: String(body.note || '').trim().slice(0, 1000),
              reviewedBy: authUser.sub,
            } }, { new: true }).lean();
            if (!submission) throw new Error('Submission not found or it has already been reviewed.');
          } else if (req.method === 'PATCH') {
            const changes = settingsInput(body, config);
            if (await dashboardEditBlocked(authUser, res,
              Object.keys(changes).map(key => `advent.test.${key}`))) return;
            await update(config, changes);
          } else {
            const action = body.action;
            if (!['start', 'pause', 'resume', 'advance', 'reset', 'announce'].includes(action)) throw new Error('Unknown test action.');
            if (await dashboardEditBlocked(authUser, res, [`advent.test.${action}`])) return;
            if (action === 'reset') {
              if (body.confirmation !== 'RESET TEST') throw new Error('Confirm the reset with RESET TEST. Existing submissions will be archived, not deleted.');
              config = await update(config, {
                runId: crypto.randomUUID(), state: 'idle', startDay: 0, startedAt: null, pausedElapsedMs: 0,
              });
            } else if (action !== 'announce') {
              config = await update(config, actionUpdate(config, action, now()));
            }
            if (['start', 'advance', 'resume', 'announce'].includes(action)) await announce(config);
          }
          sendJson(res, 200, await snapshot());
        });
        return true;
      }
      sendJson(res, 404, { error: 'Advent route not found. Only test mode is available.' });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  async function init() {
    await Promise.all([AdventTest.init(), AdventSubmission.init(), AdventAnnouncement.init()]);
    await getConfig();
    await run();
  }

  return { init, run, handleApi, handleMessage, snapshot };
}

module.exports = { createAdventService };
