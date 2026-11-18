const crypto = require('crypto');
const { AttachmentBuilder } = require('discord.js');
const models = require('./advent-models');
const { TEST_CHANNEL_ID, clock, challengeText, settingsInput, actionUpdate, assertAccepting,
  defaultAnnouncement, renderAnnouncement, announcementText } = require('./advent-domain');
const { renderCalendar } = require('./advent-calendar');
const { imageDay, normalizeCalendarImage, readImageBody, createAdventImageStore } = require('./advent-images');
const { deliverAnnouncement } = require('./advent-delivery');

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

  async function calendarAsset(config, run) {
    const day = Math.min(25, run.opened);
    const custom = (config.calendarImages || []).find(image => image.day === day);
    return {
      bytes:custom ? await imageStore.get(custom.fileId) : renderCalendar(config, run),
      contentType:custom?.contentType || 'image/png',
      extension:custom?.contentType === 'image/jpeg' ? 'jpg' : 'png',
    };
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
        announcementMessages: Array.from({ length: 26 }, (_, i) =>
          config.announcementMessages?.[i] || defaultAnnouncement(i + 1)),
        dayDurationSeconds: config.dayDurationSeconds, channelId: TEST_CHANNEL_ID,
        calendarImages: (config.calendarImages || []).map(({ day, size, updatedAt, contentType }) =>
          ({ day, size, updatedAt, contentType:contentType || 'image/png' })),
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
      const template = config.announcementMessages?.[run.day - 1] || defaultAnnouncement(run.day);
      const text = renderAnnouncement(template, config, run.day,
        run.dayEndsAt ? `<t:${Math.floor(new Date(run.dayEndsAt).getTime() / 1000)}:F>` : '');
      const messageId = await deliverAnnouncement({
        target, recent, marker, delivery: { ...delivery, botId: client.user.id }, text,
        ...await calendarAsset(config, run), now,
        save: values => AdventAnnouncement.updateOne({ _id: delivery._id }, { $set: values }),
      });
      await AdventAnnouncement.updateOne({ _id: delivery._id }, {
        $set: { status: 'sent', messageId, leaseUntil: null, error: '' },
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

  async function handleCommand(interaction) {
    if (!interaction.guildId || interaction.channelId !== TEST_CHANNEL_ID) {
      await interaction.reply({
        content: `Advent is test-only. Use /adventsubmit in <#${TEST_CHANNEL_ID}>.`,
        ephemeral: true, allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.deferReply();
    await serial(async () => {
      try {
        const config = await getConfig();
        const current = assertAccepting(config, { channelId: interaction.channelId, now: now() });
        const image = interaction.options.getAttachment('screenshot');
        if (!image || !(image.contentType?.startsWith('image/')
          || (!image.contentType && /\.(png|jpe?g|gif|webp)$/i.test(image.name || '')))) {
          throw new Error('Attach a screenshot image (PNG, JPG, GIF or WebP).');
        }
        const key = { runId: config.runId, day: current.day, userId: interaction.user.id };
        const existing = await AdventSubmission.find(key).sort({ createdAt: -1 }).lean();
        if (existing.some(item => ['pending', 'approved'].includes(item.status))) {
          throw new Error('You already have a pending or approved picture for today. Rejected pictures can be resubmitted.');
        }
        // Copy slash-command attachments onto the bot's channel reply. Their
        // original interaction URL expires and cannot be refreshed as a normal
        // channel message. This retained copy works with freshProof after expiry.
        const source = await interaction.editReply({
          content: 'Saving your advent screenshot…',
          files: [new AttachmentBuilder(image.url, { name: String(image.name || 'advent-proof.png').replace(/[^\w.-]/g, '_') })],
          allowedMentions: { parse: [] },
        });
        const proof = source.attachments.first();
        if (!proof) throw new Error('Could not retain the screenshot. Please try /adventsubmit again.');
        const values = {
          challenge: config.challenges[current.day - 1],
          username: interaction.user.username,
          proofUrl: proof.url, messageId: source.id, attachmentId: proof.id,
          note: String(interaction.options.getString('note') || '').trim().slice(0, 1000),
          status: 'pending', reviewNote: '', reviewedBy: '',
        };
        try {
          await AdventSubmission.findOneAndUpdate({ ...key, status: 'rejected' },
            { $set: values }, { upsert: true, new: true, runValidators: true });
        } catch (error) {
          if (error.code === 11000) throw new Error('You already have a pending or approved picture for today. Rejected pictures can be resubmitted.');
          throw error;
        }
        await interaction.editReply({
          content: `TEST: your December ${current.day} picture was submitted for staff review.`,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        await interaction.editReply({ content: error.message, attachments: [], files: [], allowedMentions: { parse: [] } });
      }
    });
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
        const asset = await calendarAsset(config, run);
        res.writeHead(200, { 'Content-Type': asset.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options':'nosniff' });
        res.end(asset.bytes);
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
        const asset = req.method === 'POST' ? await normalizeCalendarImage(await readImageBody(req)) : null;
        await serial(async () => {
          const config = await getConfig();
          const previous = (config.calendarImages || []).find(image => image.day === day);
          const calendarImages = (config.calendarImages || []).filter(image => image.day !== day);
          let newId;
          try {
            if (asset) {
              newId = await imageStore.put(asset.bytes, day, asset.contentType);
              calendarImages.push({ day, fileId: newId, size: asset.bytes.length, contentType:asset.contentType, updatedAt: new Date(now()) });
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
      const announcement = pathname.match(/^\/api\/advent\/test\/messages\/(\d+)$/);
      const challenge = pathname.match(/^\/api\/advent\/test\/challenges\/(\d+)$/);
      const review = pathname.match(/^\/api\/advent\/test\/submissions\/([a-f\d]{24})\/review$/i);
      if ((req.method === 'PATCH' && (pathname === base || challenge || announcement))
        || (req.method === 'POST' && (pathname === `${base}/actions` || review))) {
        const body = await readBody(req);
        await serial(async () => {
          let config = await getConfig();
          if (announcement) {
            const day = Number(announcement[1]);
            if (day < 1 || day > 26) throw new Error('Choose a message from day 1 to 25 or the closing message (26).');
            if (await dashboardEditBlocked(authUser, res, [`advent.test.message.${day}`])) return;
            const messages = Array.from({ length:26 }, (_, i) => config.announcementMessages?.[i] || '');
            messages[day - 1] = announcementText(body.text, config, day);
            await update(config, { announcementMessages: messages });
          } else if (challenge) {
            const day = Number(challenge[1]);
            if (day < 1 || day > 25) throw new Error('Choose a day between 1 and 25.');
            const text = challengeText(body.text);
            if (await dashboardEditBlocked(authUser, res, [`advent.test.challenge.${day}`])) return;
            const challenges = [...config.challenges];
            challenges[day - 1] = text;
            renderAnnouncement(config.announcementMessages?.[day - 1] || defaultAnnouncement(day),
              { ...config, challenges }, day);
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

  async function approveSubmission(id, reviewer) {
    return serial(async () => {
      const config = await getConfig();
      const submission = await AdventSubmission.findOneAndUpdate({
        _id: id, runId: config.runId, status: 'pending',
      }, { $set: { status: 'approved', reviewedBy: reviewer, reviewNote: '' } }, { new: true }).lean();
      if (!submission) throw new Error('Picture not found, already reviewed, or belongs to an old advent test.');
      return submission;
    });
  }

  return { init, run, handleApi, handleCommand, snapshot, approveSubmission, freshProof };
}

module.exports = { createAdventService };
