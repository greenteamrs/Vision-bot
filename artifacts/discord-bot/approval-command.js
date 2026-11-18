const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

const validId = value => /^[a-f\d]{24}$/i.test(String(value));
const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const short = value => String(value || '').slice(0, 100);

function createApprovalCommand({
  client, isAllowed, BingoSubmission, BingoTeam, BingoTileConfig, BingoProgress, BingoCompletion,
  BINGO_TILES, OsrsEvent, EventSubmission, AdventTest, AdventSubmission, eventService, adventService,
  now = Date.now,
}) {
  const sessions = new Map();
  let queue = Promise.resolve();
  const serial = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  function prune() {
    for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
  }
  async function autocomplete(interaction) {
    if (!isAllowed(interaction)) return interaction.respond([]);
    try {
      const focused = interaction.options.getFocused(true);
      const search = String(focused.value || '').trim().slice(0, 100);
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (focused.name === 'tile') return interaction.respond(BINGO_TILES.filter(tile => regex.test(tile.name))
        .slice(0, 25).map(tile => ({ name: short(tile.name), value: tile.id })));
      if (focused.name === 'team') {
        const teams = await BingoTeam.find({ name: regex }).sort({ name: 1 }).limit(25).lean();
        return interaction.respond(teams.map(team => ({ name: short(team.name), value: String(team._id) })));
      }
      const config = await AdventTest.findById('test').lean();
      const events = await OsrsEvent.find({}).select('name').lean();
      const eventNames = new Map(events.map(event => [String(event._id), event.name]));
      const metadata = ['_id', 'createdAt'].map(name => ({ $expr: {
        $regexMatch: { input: { $toString: `$${name}` }, regex },
      } }));
      const fields = names => ({ $or: [...names.map(name => ({ [name]: regex })), ...metadata] });
      const [bingo, advent, general] = await Promise.all([
        BingoSubmission.find({ status: 'pending', imageUrl: /^https?:\/\//i,
          ...(/bingo/i.test(search) ? {} : fields(['submittedBy', 'note', 'tileId'])) }).sort({ createdAt: -1 }).limit(25).lean(),
        config ? AdventSubmission.find({ status: 'pending', runId: config.runId, proofUrl: /^https?:\/\//i,
          ...(/advent/i.test(search) ? {} : fields(['username', 'challenge', 'note'])) })
          .sort({ createdAt: -1 }).limit(25).lean() : [],
        EventSubmission.find({ status: 'pending', kind: 'goal', proofUrl: /^https?:\/\//i, $or: [
          ...['username', 'goalName', 'teamName', 'note'].map(name => ({ [name]: regex })),
          { eventId: { $in: events.filter(event => regex.test(event.name)).map(event => event._id) } },
          ...metadata,
        ] }).sort({ createdAt: -1 }).limit(25).lean(),
      ]);
      // Round-robin leaves room for all event systems in Discord's 25 choices.
      const groups = [
        bingo.map(sub => choice('bingo', sub, `Bingo · ${sub.submittedBy} · ${sub.note || sub.tileId}`)),
        advent.map(sub => choice('advent', sub, `Advent test · ${sub.username} · Day ${sub.day} · ${sub.challenge}`)),
        general.filter(sub => eventNames.has(String(sub.eventId))).map(sub =>
          choice('event', sub, `${eventNames.get(String(sub.eventId))} · ${sub.username || sub.teamName} · ${sub.goalName}`)),
      ];
      const choices = [];
      while (groups.some(group => group.length) && choices.length < 25) {
        for (const group of groups) if (group.length && choices.length < 25) choices.push(group.shift());
      }
      return interaction.respond(choices);
    } catch (error) {
      console.error('[Approve] Could not search pending pictures:', error.message);
      return interaction.respond([]).catch(() => {});
    }
  }
  function choice(type, sub, label) {
    // ID suffix distinguishes same-member, same-challenge submissions.
    const date = new Date(sub.createdAt);
    const when = Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16);
    return { name: `${label.slice(0, 65)} · ${when} · ${String(sub._id).slice(-6)}`.slice(0, 100), value: `${type}:${sub._id}` };
  }
  async function load(type, id) {
    let submission, label, url, userId;
    if (type === 'bingo') {
      submission = await BingoSubmission.findOne({ _id: id, status: 'pending' }).lean();
      label = `Bingo · ${submission?.submittedBy || ''}`;
      url = submission?.imageUrl; userId = submission?.submittedById;
    } else if (type === 'advent') {
      const config = await AdventTest.findById('test').lean();
      submission = config && await AdventSubmission.findOne({ _id: id, runId: config.runId, status: 'pending' }).lean();
      if (submission) await adventService.freshProof(submission);
      label = `Advent test · Day ${submission?.day} · ${submission?.username || ''}`;
      url = submission?.proofUrl; userId = submission?.userId;
    } else if (type === 'event') {
      submission = await EventSubmission.findOne({ _id: id, status: 'pending', kind: 'goal' }).lean();
      const event = submission && await OsrsEvent.findById(submission.eventId).lean();
      if (!event) throw new Error('The event no longer exists.');
      label = `${event.name} · ${submission.username || submission.teamName || ''} · ${submission.goalName}`;
      url = submission.proofUrl; userId = submission.submittedById;
    }
    if (!submission || !safeUrl(url)) throw new Error('Pending picture not found, already reviewed, or belongs to an old test.');
    return { submission, label, url: safeUrl(url), userId };
  }
  async function command(interaction) {
    if (!isAllowed(interaction)) return interaction.reply({ content: 'Moderators only. Use this command in the clan server.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const [type, id, extra] = String(interaction.options.getString('picture') || '').split(':');
      if (!['bingo', 'advent', 'event'].includes(type) || !validId(id) || extra) throw new Error('Select a pending picture from the autocomplete list.');
      const picture = await load(type, id);
      const session = {
        type, id, userId: interaction.user.id, guildId: interaction.guildId,
        expires: now() + 10 * 60000, steps: [], stepNames: [],
      };
      if (type === 'bingo') {
        session.tileId = interaction.options.getString('tile') || picture.submission.tileId;
        session.teamId = interaction.options.getString('team') || String(picture.submission.teamId);
        const tile = BINGO_TILES.find(item => item.id === session.tileId);
        const team = validId(session.teamId) && await BingoTeam.findById(session.teamId).lean();
        if (!tile || !team) throw new Error('For this bingo picture, choose its team and tile using the /approve team and tile options.');
        session.stepNames = (await BingoTileConfig.findOne({ tileId: tile.id }).lean())?.steps || [];
        if (session.stepNames.length > 25) throw new Error('This tile has more than 25 steps; review it in the dashboard.');
        picture.label += ` · ${team.name} · ${tile.name}`;
      }
      prune();
      if (sessions.size >= 1000) throw new Error('Too many approval previews are open. Try again shortly.');
      const token = crypto.randomBytes(12).toString('hex');
      sessions.set(token, session);
      const description = [picture.submission.challenge, picture.submission.note,
        `Submitted: ${new Date(picture.submission.createdAt).toISOString()}`,
        session.stepNames.length ? 'Select the completed step(s), then confirm approval.' : 'Check the picture, then confirm approval.']
        .filter(Boolean).join('\n\n').slice(0, 4096);
      await interaction.editReply({
        content: 'Review this picture before approving it.',
        embeds: [{ title: picture.label.slice(0, 256), description, image: { url: picture.url } }],
        components: components(token, session), allowedMentions: { parse: [] },
      });
    } catch (error) { await interaction.editReply({ content: error.message, components: [], embeds: [] }); }
  }
  function components(token, session) {
    const rows = [];
    if (session.stepNames.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`approve:steps:${token}`).setPlaceholder('Choose the completed bingo steps')
      .setMinValues(1).setMaxValues(session.stepNames.length)
      .addOptions(session.stepNames.map((name,index) => ({ label: short(name), value: String(index), default: session.steps.includes(index) })))));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve:confirm:${token}`).setLabel('Approve picture').setStyle(ButtonStyle.Success)
        .setDisabled(Boolean(session.stepNames.length && !session.steps.length)),
      new ButtonBuilder().setCustomId(`approve:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)));
    return rows;
  }
  async function component(interaction) {
    if (!isAllowed(interaction)) return interaction.reply({ content: 'Moderators only.', ephemeral: true });
    const [, action, token] = interaction.customId.split(':');
    prune();
    const session = sessions.get(token);
    if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId) {
      return interaction.reply({ content: 'This approval preview expired or belongs to another moderator. Run /approve again.', ephemeral: true });
    }
    await interaction.deferUpdate();
    return serial(async () => {
      try {
        if (sessions.get(token) !== session) throw new Error('This preview has already been used.');
        if (action === 'cancel') {
          sessions.delete(token);
          return interaction.editReply({ content: 'Approval cancelled. The picture was not changed.', components: [], embeds: [] });
        }
        if (action === 'steps') {
          const selected = interaction.values.map(Number);
          if (!selected.length || selected.some(index => !Number.isInteger(index) || !session.stepNames[index])) throw new Error('Choose valid bingo steps.');
          session.steps = [...new Set(selected)];
          return interaction.editReply({ components: components(token, session) });
        }
        if (action !== 'confirm') throw new Error('Unknown approval action.');
        const picture = await load(session.type, session.id); // Recheck status/run after preview.
        const reviewer = interaction.user.tag || interaction.user.username;
        if (session.type === 'event') await eventService.approveSubmission(session.id, reviewer);
        if (session.type === 'advent') {
          await adventService.approveSubmission(session.id, reviewer);
          await notify(picture.userId, `Your advent picture for day ${picture.submission.day} was approved.`);
        }
        if (session.type === 'bingo') await approveBingo(session, picture, reviewer);
        sessions.delete(token);
        return interaction.editReply({ content: `Approved: ${picture.label}.`, components: [], allowedMentions: { parse: [] } });
      } catch (error) {
        sessions.delete(token);
        return interaction.editReply({ content: `Could not approve: ${error.message}`, components: [], allowedMentions: { parse: [] } });
      }
    });
  }
  async function approveBingo(session, picture, reviewer) {
    const team = await BingoTeam.findById(session.teamId).lean();
    const tile = BINGO_TILES.find(item => item.id === session.tileId);
    const steps = (await BingoTileConfig.findOne({ tileId: session.tileId }).lean())?.steps || [];
    if (!team || !tile || JSON.stringify(steps) !== JSON.stringify(session.stepNames)) throw new Error('Bingo settings changed. Run /approve again.');
    if (steps.length && !session.steps.length) throw new Error('Choose the completed steps first.');
    let complete = !steps.length;
    if (steps.length) {
      const progress = await BingoProgress.findOneAndUpdate({ tileId: tile.id, teamId: team._id },
        { $addToSet: { completedSteps: { $each: session.steps.map(index => steps[index]) } } }, { upsert: true, new: true }).lean();
      complete = steps.every(step => progress.completedSteps.includes(step));
    }
    if (complete) await BingoCompletion.findOneAndUpdate({ tileId: tile.id, teamId: team._id },
      { $setOnInsert: { completedBy: picture.submission.submittedBy } }, { upsert: true, new: true });
    const saved = await BingoSubmission.findOneAndUpdate({ _id: session.id, status: 'pending' },
      { $set: { status: 'approved', tileId: tile.id, teamId: team._id, reviewedBy: reviewer } }, { new: true });
    if (!saved) throw new Error('This picture has already been reviewed.');
    await notify(picture.userId, `Your bingo picture was approved! ${complete ? 'Tile completed' : 'Selected steps recorded'}: **${tile.name}** for **${team.name}**.`);
  }
  async function notify(id, content) {
    if (!id) return;
    try { await (await client.users.fetch(id)).send({ content, allowedMentions: { parse: [] } }); }
    catch (error) { console.warn('[Approve] Approval saved, but the member could not be notified:', error.message); }
  }
  return { autocomplete, command, component };
}
module.exports = { createApprovalCommand };
