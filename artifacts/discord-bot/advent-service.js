const crypto = require('crypto');
const { AttachmentBuilder } = require('discord.js');
const models = require('./advent-models');
const { TEST_CHANNEL_ID, clock, liveClock, liveDayDueAt, validateLiveStart,
  challengeText, settingsInput, actionUpdate, assertAccepting,
  defaultAnnouncement, renderAnnouncement, announcementText } = require('./advent-domain');
const { renderCalendar } = require('./advent-calendar');
const { imageDay, normalizeCalendarImage, readImageBody, createAdventImageStore } = require('./advent-images');
const { deliverAnnouncement } = require('./advent-delivery');

function createAdventService({
  client, readBody, sendJson, dashboardEditBlocked, canAdminSubmit = () => false,
  AdventTest = models.AdventTest,
  AdventSubmission = models.AdventSubmission,
  AdventAnnouncement = models.AdventAnnouncement,
  now = Date.now,
  imageStore = createAdventImageStore(),
  listChannels,
}) {
  let channelListCache = null;
  let channelListCacheAt = 0;
  async function availableChannels() {
    const sanitize = channels => (Array.isArray(channels) ? channels : [])
      .filter(item => item && typeof item.id === 'string' && typeof item.name === 'string')
      .map(({ id, name, type }) => ({ id, name, type }));
    if (listChannels) return sanitize(await listChannels());
    if (channelListCache && now() - channelListCacheAt < 60000) return channelListCache;
    const anchor = await client.channels.fetch(TEST_CHANNEL_ID);
    const guild = anchor?.guild;
    if (!guild?.channels?.fetch) throw new Error('Could not load channels from the Advent test server.');
    const channels = await guild.channels.fetch();
    channelListCache = [...channels.values()].filter(item => {
      if (!item || item.guildId !== guild.id || ![0, 5].includes(item.type) || typeof item.send !== 'function') return false;
      const permissions = item.permissionsFor?.(client.user);
      return Boolean(permissions?.has('ViewChannel') && permissions.has('SendMessages'));
    }).map(item => ({ id: item.id, name: item.name, type: item.type }));
    channelListCacheAt = now();
    return channelListCache;
  }
  function dailyTemplate(config) {
    return config.announcementTemplate
      || config.announcementMessages?.slice(0, 25).find(message => typeof message === 'string' && message.trim())
      || defaultAnnouncement(1);
  }
  function closingMessage(config) {
    return config.announcementClosingMessage
      || config.announcementMessages?.[25]
      || defaultAnnouncement(26);
  }
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

  async function channel(channelId = TEST_CHANNEL_ID) {
    const target = await client.channels.fetch(channelId);
    if (!target || !target.isTextBased() || !target.guildId || typeof target.send !== 'function') {
      throw new Error('The advent test channel is unavailable or is not a server text channel.');
    }
    return target;
  }

  async function validateBroadcastChannel(channelId) {
    if (!/^\d{17,20}$/.test(String(channelId || ''))) throw new Error('Choose a valid Discord channel.');
    const anchor = await client.channels.fetch(TEST_CHANNEL_ID);
    const target = await client.channels.fetch(channelId);
    if (!anchor?.guildId) throw new Error('Could not access the Advent test server.');
    if (!target || target.guildId !== anchor.guildId || ![0, 5].includes(target.type)
      || typeof target.send !== 'function') {
      throw new Error('Choose a text or announcement channel in the Advent test server.');
    }
    const permissions = target.permissionsFor?.(client.user);
    if (!permissions?.has('ViewChannel') || !permissions.has('SendMessages')) {
      throw new Error('The bot needs View Channel and Send Messages permissions there.');
    }
    return target;
  }

  function assertCalendarEditable(config) {
    if (['converting', 'running', 'completed'].includes(config.liveStatus || 'off')) {
      throw new Error('Calendar settings are locked after the live event starts.');
    }
  }

  function submissionContext(config, channelId, allowLate = false) {
    if (String(channelId) !== String(config.channelId || TEST_CHANNEL_ID)) {
      throw new Error(`Advent submissions are restricted to the selected channel (<#${config.channelId || TEST_CHANNEL_ID}>).`);
    }
    if (['scheduled', 'converting'].includes(config.liveStatus)) {
      throw new Error('Advent submissions are paused while the live launch is scheduled.');
    }
    if (config.liveStatus === 'running' || (allowLate && config.liveStatus === 'completed')) {
      const current = liveClock(config, now());
      const opened = Math.min(current?.opened || 0, Number(config.liveNextDay || 1) - 1);
      const run = current ? { ...current, opened } : null;
      if (!run || run.opened < 1 || (!allowLate && (run.state !== 'running' || run.day > 25 || run.day > opened))) {
        throw new Error('The live Advent calendar is not accepting pictures right now.');
      }
      return { day:run.day, runId:config.runId, run, mode:'live' };
    }
    if (config.liveStatus && config.liveStatus !== 'off') {
      throw new Error('The live Advent calendar is not accepting pictures right now.');
    }
    if (allowLate) {
      const run = clock(config, now());
      return { day:run.day, runId:config.runId, run, mode:'test' };
    }
    const run = assertAccepting(config, { channelId, now:now() });
    return { day:run.day, runId:config.runId, run, mode:'test' };
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
      const original = await (await channel(submission.sourceChannelId || TEST_CHANNEL_ID)).messages.fetch(submission.messageId);
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
    const live = liveClock(config, now());
    const liveActive = ['running', 'closing', 'completed'].includes(live?.state);
    const run = liveActive ? live : clock(config, now());
    const [submissions, announcements] = await Promise.all([
      AdventSubmission.find({ runId: config.runId }).sort({ createdAt: -1 }).lean(),
      AdventAnnouncement.find({ runId: config.runId }).sort({ day: 1 }).lean(),
    ]);
    // Limit concurrent Discord requests while refreshing old attachment links.
    for (let i = 0; i < submissions.length; i += 5) {
      await Promise.all(submissions.slice(i, i + 5).map(freshProof));
    }
    let channels = [];
    let channelListError = '';
    try {
      channels = await availableChannels();
    } catch (error) {
      channelListError = 'Discord channels could not be loaded. Advent settings are still available.';
      console.error('[Advent] Could not load broadcast-channel choices:', error.message);
    }
    return {
      config: {
        year: config.year, challenges: config.challenges, channelId: config.channelId || TEST_CHANNEL_ID,
        liveStatus: config.liveStatus || 'off',
        liveFirstPostAt: config.liveFirstPostAt || null,
        liveRunId: config.liveRunId || '',
        announcementTemplate: dailyTemplate(config),
        announcementClosingMessage: closingMessage(config),
        dayDurationSeconds: config.dayDurationSeconds,
        calendarImages: (config.calendarImages || []).map(({ day, size, updatedAt, contentType }) =>
          ({ day, size, updatedAt, contentType:contentType || 'image/png' })),
      },
      channels, channelListError, run,
      live: {
        status: config.liveStatus || 'off',
        firstPostAt: config.liveFirstPostAt || null,
        nextDay: config.liveNextDay || 1,
      },
      submissions, announcements,
    };
  }

  async function deliverDay(config, run, mode, runId = config.runId) {
    if (run.day < 1) return false;
    const key = { runId, day: run.day };
    const marker = `advent-${mode}:${runId}:${run.day}`;
    let delivery;
    try {
      delivery = await AdventAnnouncement.findOneAndUpdate({
        ...key,
        $or: [{ status: 'failed' }, { status: 'sending', leaseUntil: { $lte: new Date(now()) } }],
      }, {
        $set: { status: 'sending', leaseUntil: new Date(now() + 120000), error: '' },
      }, { upsert: true, new: true }).lean();
    } catch (error) {
      if (error.code === 11000) {
        const existing = await AdventAnnouncement.findOne(key).lean();
        return existing?.status === 'sent';
      }
      throw error;
    }
    try {
      const target = await channel(config.channelId || TEST_CHANNEL_ID);
      // Recovery after a restart between Discord delivery and saving messageId.
      // Snowflake nonce also guards Discord's recent-message retry window.
      const recent = await target.messages.fetch({ limit: 100 });
      const template = run.day === 26 ? closingMessage(config) : dailyTemplate(config);
      const duration = mode === 'live' && run.dayEndsAt
        ? Math.max(1, Math.floor((new Date(run.dayEndsAt).getTime()
          - new Date(liveDayDueAt(config.liveFirstPostAt, run.day)).getTime()) / 1000))
        : config.dayDurationSeconds;
      const text = renderAnnouncement(template, config, run.day,
        run.dayEndsAt ? `<t:${Math.floor(new Date(run.dayEndsAt).getTime() / 1000)}:F>` : '',
        mode === 'live' ? duration : config.dayDurationSeconds);
      const messageId = await deliverAnnouncement({
        target, recent, marker, delivery: { ...delivery, botId: client.user.id }, text,
        ...await calendarAsset(config, run), now,
        save: values => AdventAnnouncement.updateOne({ _id: delivery._id }, { $set: values }),
      });
      await AdventAnnouncement.updateOne({ _id: delivery._id }, {
        $set: { status: 'sent', messageId, channelId: target.id, leaseUntil: null, error: '' },
      });
      console.info(`[Advent] ${mode} day ${run.day} posted in channel ${target.id}`);
      return true;
    } catch (error) {
      await AdventAnnouncement.updateOne({ _id: delivery._id }, {
        $set: { status: 'failed', leaseUntil: null, error: String(error.message).slice(0, 500) },
      });
      console.error(`[Advent] ${mode} announcement failed:`, error.message);
      // Recorded in the dashboard and retried by the next scheduler tick.
      return false;
    }
  }

  async function announce(config) {
    const run = clock(config, now());
    if (run.state === 'idle' || run.state === 'paused' || run.day < 1) return;
    await deliverDay(config, run, 'test');
  }

  async function announceLive(config) {
    let nextDay = Number(config.liveNextDay || 1);
    while (nextDay <= 26 && now() >= liveDayDueAt(config.liveFirstPostAt, nextDay).getTime()) {
      const run = {
        id: config.runId,
        state: nextDay === 26 ? 'closing' : 'running',
        day: nextDay,
        opened: Math.min(25, nextDay),
        dayEndsAt: nextDay <= 25
          ? liveDayDueAt(config.liveFirstPostAt, nextDay + 1).toISOString()
          : null,
      };
      if (!await deliverDay(config, run, 'live')) return;
      const changes = { liveNextDay: nextDay + 1 };
      if (nextDay === 26) changes.liveStatus = 'completed';
      config = await update(config, changes);
      nextDay += 1;
    }
  }

  async function run() {
    return serial(async () => {
      let config = await getConfig();
      if (config.liveStatus === 'scheduled'
        && new Date(config.liveFirstPostAt).getTime() <= now()) {
        config = await update(config, { liveStatus: 'converting' });
      }
      if (config.liveStatus === 'converting') {
        // This is intentionally idempotent: a restart during conversion repeats
        // the delete before the fresh live run is activated.
        await AdventSubmission.deleteMany({});
        config = await getConfig();
        if (config.liveStatus === 'converting') {
          config = await update(config, {
            runId: config.liveRunId,
            liveStatus: 'running',
            liveStartedAt: new Date(config.liveFirstPostAt),
            liveNextDay: 1,
          });
        }
      }
      if (config.liveStatus === 'running') {
        await announceLive(config);
        return;
      }
      if (config.liveStatus !== 'off') return;
      await announce(config);
    });
  }

  async function handleCommand(interaction) {
    const adminSubmission = interaction.commandName === 'adventsubmitadmin';
    if (adminSubmission && (!interaction.guildId || !await canAdminSubmit(interaction))) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true, allowedMentions: { parse: [] } });
      return;
    }
    if (!interaction.guildId) {
      await interaction.reply({
        content: `Advent is test-only. Use /adventsubmit in the dashboard-selected channel.`,
        ephemeral: true, allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.deferReply();
    await serial(async () => {
      try {
        const config = await getConfig();
        const active = submissionContext(config, interaction.channelId, adminSubmission);
        let user = interaction.user;
        let day = active.day;
        if (adminSubmission) {
          day = interaction.options.getInteger('day');
          if (!Number.isInteger(day) || day < 1 || day > 25 || day > active.run.opened) {
            throw new Error(`Choose an already opened day (1–25) in the current ${active.mode} run.`);
          }
          user = interaction.options.getUser('member');
          if (!user || user.bot) throw new Error('Choose a member of this server, not a bot.');
          const target = await client.channels.fetch(config.channelId || TEST_CHANNEL_ID);
          if (!target || target.guildId !== interaction.guildId) throw new Error('Use this command in the advent test server.');
          const member = await interaction.guild.members.fetch(user.id).catch(() => null);
          if (!member) throw new Error('That member is not in this server.');
        }
        const image = interaction.options.getAttachment('screenshot');
        if (!image || !(image.contentType?.startsWith('image/')
          || (!image.contentType && /\.(png|jpe?g|gif|webp)$/i.test(image.name || '')))) {
          throw new Error('Attach a screenshot image (PNG, JPG, GIF or WebP).');
        }
        const key = { runId: active.runId, day, userId: user.id };
        const duplicateMessage = adminSubmission
          ? `This member already has a pending or approved picture for day ${day}. No picture was replaced.`
          : 'You already have a pending or approved picture for today. Rejected pictures can be resubmitted.';
        const existing = await AdventSubmission.find(key).sort({ createdAt: -1 }).lean();
        if (existing.some(item => ['pending', 'approved'].includes(item.status))) {
          throw new Error(duplicateMessage);
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
          challenge: config.challenges[day - 1],
          username: user.username,
          submittedByAdmin: adminSubmission ? interaction.user.id : '',
          sourceChannelId: interaction.channelId,
          proofUrl: proof.url, messageId: source.id, attachmentId: proof.id,
          note: String(interaction.options.getString('note') || '').trim().slice(0, 1000),
          status: 'pending', reviewNote: '', reviewedBy: '',
        };
        try {
          await AdventSubmission.findOneAndUpdate({ ...key, status: 'rejected' },
            { $set: values }, { upsert: true, new: true, runValidators: true });
        } catch (error) {
          if (error.code === 11000) throw new Error(duplicateMessage);
          throw error;
        }
        await interaction.editReply({
          content: adminSubmission
            ? `${active.mode === 'test' ? 'TEST: ' : ''}December ${day} picture for ${user.username} was submitted by an admin for staff review. Other days are unaffected.`
            : `${active.mode === 'test' ? 'TEST: ' : ''}your December ${day} picture was submitted for staff review.`,
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
        const live = liveClock(config, now());
        const run = _params?.has('day')
          ? { day: imageDay(_params.get('day')), opened: imageDay(_params.get('day')) }
          : (['running', 'closing', 'completed'].includes(live?.state) ? live : clock(config, now()));
        const asset = await calendarAsset(config, run);
        res.writeHead(200, { 'Content-Type': asset.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options':'nosniff' });
        res.end(asset.bytes);
        return true;
      }
      if (!['admin', 'mod'].includes(authUser?.role)) {
        sendJson(res, 403, { error: 'Staff access required.' });
        return true;
      }
      if (req.method === 'POST' && pathname === `${base}/live/schedule`) {
        if (authUser.role !== 'admin') {
          sendJson(res, 403, { error: 'Only an admin can schedule the live Advent calendar.' });
          return true;
        }
        const body = await readBody(req);
        await serial(async () => {
          const config = await getConfig();
          if (body.confirmation !== 'PROMOTE LIVE CALENDAR') {
            throw new Error('Confirm with PROMOTE LIVE CALENDAR. All Advent test submissions will be permanently deleted when the live event starts.');
          }
          if (!['off', 'scheduled'].includes(config.liveStatus || 'off')) {
            throw new Error('The live calendar can only be scheduled before conversion begins.');
          }
          if (clock(config, now()).state !== 'idle') {
            throw new Error('Reset the Advent test to idle before scheduling the live event.');
          }
          if (await dashboardEditBlocked(authUser, res, ['advent.live.schedule'])) return;
          const firstPostAt = validateLiveStart(body.firstPostAt, now());
          await validateBroadcastChannel(config.channelId || TEST_CHANNEL_ID);
          const values = {
            liveStatus: 'scheduled',
            liveFirstPostAt: firstPostAt,
            liveRunId: config.liveStatus === 'scheduled' && config.liveRunId
              ? config.liveRunId : crypto.randomUUID(),
            liveNextDay: 1,
          };
          await update(config, values);
          sendJson(res, 200, await snapshot());
        });
        return true;
      }
      if (req.method === 'POST' && pathname === `${base}/live/cancel`) {
        if (authUser.role !== 'admin') {
          sendJson(res, 403, { error: 'Only an admin can cancel the live schedule.' });
          return true;
        }
        await serial(async () => {
          const config = await getConfig();
          if (config.liveStatus !== 'scheduled'
            || new Date(config.liveFirstPostAt).getTime() <= now()) {
            throw new Error('The live schedule can no longer be canceled after its start time.');
          }
          if (await dashboardEditBlocked(authUser, res, ['advent.live.cancel'])) return;
          await update(config, {
            liveStatus: 'off', liveFirstPostAt: null, liveRunId: '', liveNextDay: 1,
          });
          sendJson(res, 200, await snapshot());
        });
        return true;
      }
      const imageSlot = pathname.match(/^\/api\/advent\/test\/images\/(\d+)$/);
      if (req.method === 'PATCH' && pathname === `${base}/channel`) {
        await serial(async () => {
          const config = await getConfig();
          assertCalendarEditable(config);
          if (clock(config, now()).state !== 'idle') throw new Error('Reset the test before changing its broadcast channel.');
          if (await dashboardEditBlocked(authUser, res, ['advent.test.channelId'])) return;
          const channelId = String((await readBody(req)).channelId || '');
          await validateBroadcastChannel(channelId);
          await update(config, { channelId });
          sendJson(res, 200, await snapshot());
        });
        return true;
      }
      if (imageSlot && ['POST', 'DELETE'].includes(req.method)) {
        const day = imageDay(imageSlot[1]);
        if (await dashboardEditBlocked(authUser, res, [`advent.test.image.${day}`])) {
          req.resume?.();
          return true;
        }
        const asset = req.method === 'POST' ? await normalizeCalendarImage(await readImageBody(req)) : null;
        await serial(async () => {
          const config = await getConfig();
          assertCalendarEditable(config);
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
      const announcement = pathname.match(/^\/api\/advent\/test\/messages\/(daily|closing)$/);
      const challenge = pathname.match(/^\/api\/advent\/test\/challenges\/(\d+)$/);
      const review = pathname.match(/^\/api\/advent\/test\/submissions\/([a-f\d]{24})\/review$/i);
      if ((req.method === 'PATCH' && (pathname === base || challenge || announcement))
        || (req.method === 'POST' && (pathname === `${base}/actions` || review))) {
        const body = await readBody(req);
        await serial(async () => {
          let config = await getConfig();
          if (!review) assertCalendarEditable(config);
          if (announcement) {
            const isDaily = announcement[1] === 'daily';
            const lockKey = isDaily ? 'advent.test.message.template' : 'advent.test.message.closing';
            if (await dashboardEditBlocked(authUser, res, [lockKey])) return;
            if (isDaily) {
              for (let day = 1; day <= 25; day++) announcementText(body.text, config, day);
              await update(config, { announcementTemplate: body.text });
            } else {
              announcementText(body.text, config, 26);
              await update(config, { announcementClosingMessage: body.text });
            }
          } else if (challenge) {
            const day = Number(challenge[1]);
            if (day < 1 || day > 25) throw new Error('Choose a day between 1 and 25.');
            const text = challengeText(body.text);
            if (await dashboardEditBlocked(authUser, res, [`advent.test.challenge.${day}`])) return;
            const challenges = [...config.challenges];
            challenges[day - 1] = text;
            renderAnnouncement(dailyTemplate(config),
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
            if ((config.liveStatus || 'off') !== 'off') {
              throw new Error('Test controls are paused while a live calendar is scheduled or active.');
            }
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
      sendJson(res, 404, { error: 'Advent route not found.' });
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
