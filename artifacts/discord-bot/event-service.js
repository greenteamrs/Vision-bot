const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  OsrsEvent,
  EventSubmission,
  EVENT_STATUSES,
  SCORING_MODES,
  PARTICIPATION_MODES,
  normalizeEventInput,
  normalizeGoal,
  goalById,
  leaderboardFor,
} = require('./events-domain');

const NAME_KEY = value => String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
const MAX_RESULT_VALUE = 1_000_000_000;

function eventIsInWindow(event, now = new Date()) {
  return event.status === 'active'
    && new Date(event.startsAt) <= now
    && new Date(event.endsAt) >= now;
}

function safeHttpUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

function nameAlreadyUsed(list, name, exceptId = '') {
  return list.some(item => String(item._id) !== String(exceptId)
    && item.name.trim().toLowerCase() === name.trim().toLowerCase());
}

function serializeEvent(event) {
  const value = event.toObject ? event.toObject() : event;
  value.goals = (value.goals || []).map(goal => ({ ...goal, column: goal.col }));
  return value;
}

function createEventService({ client, User, getDroptrackerDrops, readBody, sendJson }) {
  async function refreshAwards(event) {
    const accepted = await EventSubmission.find({
      eventId: event._id,
      kind: 'goal',
      status: { $in: ['approved', 'verified'] },
    }).sort({ createdAt: 1, _id: 1 });
    const goals = new Map(event.goals.map(goal => [String(goal._id), goal]));
    const updates = [];
    const targetProgress = new Map();
    const awardedTaskGoals = new Set();
    const firstToTargetWinner = new Set();

    for (const submission of accepted) {
      const goal = goals.get(String(submission.goalId));
      if (!goal) {
        if (submission.pointsAwarded !== 0) {
          updates.push({ updateOne: { filter: { _id: submission._id }, update: { $set: { pointsAwarded: 0 } } } });
        }
        continue;
      }
      let pointsAwarded = 0;
      const targetKey = `${submission.targetType}:${submission.targetId}`;
      const progressKey = `${goal._id}:${targetKey}`;
      const targetTotal = targetProgress.get(progressKey) || 0;
      const submittedValue = Math.max(0, Number(submission.value || 0));

      if (event.scoringMode === 'task-points') {
        const taskKey = `${goal._id}:${targetKey}`;
        if (!awardedTaskGoals.has(taskKey)) {
          pointsAwarded = Number(goal.points || 0);
          awardedTaskGoals.add(taskKey);
        }
      } else if (event.scoringMode === 'points-per-unit') {
        const unitPoints = event.scoringConfig?.pointsPerUnit ?? goal.points ?? 1;
        pointsAwarded = submittedValue * Number(unitPoints);
      } else if (event.scoringMode === 'first-to-target') {
        const cumulative = targetTotal + submittedValue;
        if (cumulative >= Number(goal.targetValue || 1) && !firstToTargetWinner.has(String(goal._id))) {
          pointsAwarded = Number(goal.points || 0);
          firstToTargetWinner.add(String(goal._id));
        }
        targetProgress.set(progressKey, cumulative);
      }

      if (submission.pointsAwarded !== pointsAwarded) {
        updates.push({ updateOne: { filter: { _id: submission._id }, update: { $set: { pointsAwarded } } } });
      }
    }
    if (updates.length) await EventSubmission.bulkWrite(updates);
  }

  async function eventDetail(event) {
    const submissions = await EventSubmission.find({ eventId: event._id })
      .sort({ createdAt: -1 }).limit(5000).lean();
    return {
      event: serializeEvent(event),
      submissions,
      leaderboard: leaderboardFor(event, submissions),
    };
  }

  function routeError(res, error, status = 400) {
    sendJson(res, status, { error: error?.message || 'Event request failed.' });
  }

  async function handleApi(req, res, pathname, params) {
    if (pathname === '/api/events' && req.method === 'GET') {
      try {
        const events = await OsrsEvent.find().sort({ startsAt: 1, createdAt: -1 }).lean();
        sendJson(res, 200, { events: events.map(serializeEvent) });
      } catch (error) { routeError(res, error, 500); }
      return true;
    }

    if (pathname === '/api/events' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const normalized = normalizeEventInput(body);
        const event = await OsrsEvent.create(normalized);
        sendJson(res, 201, { event: serializeEvent(event) });
      } catch (error) { routeError(res, error); }
      return true;
    }

    const match = pathname.match(/^\/api\/events\/([a-f\d]{24})(?:\/(.*))?$/i);
    if (!match) return false;
    const [, eventId, suffix = ''] = match;
    const event = await OsrsEvent.findById(eventId).catch(() => null);
    if (!event && suffix !== '') {
      sendJson(res, 404, { error: 'Event not found.' });
      return true;
    }

    if (suffix === '' && req.method === 'GET') {
      if (!event) sendJson(res, 404, { error: 'Event not found.' });
      else sendJson(res, 200, await eventDetail(event));
      return true;
    }

    if (suffix === '' && req.method === 'PATCH') {
      if (!event) { sendJson(res, 404, { error: 'Event not found.' }); return true; }
      try {
        const update = normalizeEventInput(await readBody(req), { partial: true });
        Object.assign(event, update);
        await event.save();
        await refreshAwards(event);
        sendJson(res, 200, { event: serializeEvent(event) });
      } catch (error) { routeError(res, error); }
      return true;
    }

    if (suffix === '' && req.method === 'DELETE') {
      if (!event) { sendJson(res, 404, { error: 'Event not found.' }); return true; }
      await EventSubmission.deleteMany({ eventId: event._id });
      await event.deleteOne();
      sendJson(res, 200, { success: true });
      return true;
    }

    if (!event) return true;

    if (suffix === 'goals' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (event.goals.length >= 100) throw new Error('An event can have at most 100 goals.');
        event.goals.push(normalizeGoal(body));
        await event.save();
        sendJson(res, 201, { event: serializeEvent(event), goal: event.goals[event.goals.length - 1] });
      } catch (error) { routeError(res, error); }
      return true;
    }

    const goalMatch = suffix.match(/^goals\/([a-f\d]{24})$/i);
    if (goalMatch && req.method === 'PATCH') {
      try {
        const goal = goalById(event, goalMatch[1]);
        if (!goal) { sendJson(res, 404, { error: 'Goal not found.' }); return true; }
        const body = await readBody(req);
        const normalized = normalizeGoal({
          ...goal.toObject(),
          ...body,
          col: body.col ?? body.column ?? goal.col,
        });
        Object.assign(goal, normalized);
        await event.save();
        await refreshAwards(event);
        sendJson(res, 200, { goal });
      } catch (error) { routeError(res, error); }
      return true;
    }
    if (goalMatch && req.method === 'DELETE') {
      const goal = goalById(event, goalMatch[1]);
      if (!goal) { sendJson(res, 404, { error: 'Goal not found.' }); return true; }
      const submissions = await EventSubmission.countDocuments({ eventId: event._id, goalId: goalMatch[1] });
      if (submissions) {
        sendJson(res, 409, { error: 'This goal already has result history. Keep it for the event record instead of deleting it.' });
        return true;
      }
      event.goals.pull({ _id: goalMatch[1] });
      await event.save();
      sendJson(res, 200, { success: true });
      return true;
    }

    if (suffix === 'teams' && req.method === 'POST') {
      try {
        if (event.participationMode !== 'team') throw new Error('Switch the event to team participation before adding teams.');
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name || name.length > 80) throw new Error('Team name is required and must be 80 characters or fewer.');
        if (nameAlreadyUsed(event.teams, name)) throw new Error('Team names must be unique within an event.');
        const color = /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : '#8ab4f8';
        event.teams.push({ name, color });
        await event.save();
        sendJson(res, 201, { team: event.teams[event.teams.length - 1] });
      } catch (error) { routeError(res, error); }
      return true;
    }

    const teamMatch = suffix.match(/^teams\/([a-f\d]{24})$/i);
    if (teamMatch && req.method === 'PATCH') {
      try {
        const team = event.teams.id(teamMatch[1]);
        if (!team) { sendJson(res, 404, { error: 'Team not found.' }); return true; }
        const body = await readBody(req);
        if (body.name !== undefined) {
          const name = String(body.name || '').trim();
          if (!name || name.length > 80) throw new Error('Team name is required and must be 80 characters or fewer.');
          if (nameAlreadyUsed(event.teams, name, team._id)) throw new Error('Team names must be unique within an event.');
          team.name = name;
        }
        if (body.color !== undefined) {
          if (!/^#[0-9a-fA-F]{6}$/.test(body.color)) throw new Error('Team color must be a six-digit hex color.');
          team.color = body.color;
        }
        await event.save();
        await EventSubmission.updateMany({ eventId: event._id, teamId: String(team._id) }, { $set: { teamName: team.name } });
        sendJson(res, 200, { team });
      } catch (error) { routeError(res, error); }
      return true;
    }
    if (teamMatch && req.method === 'DELETE') {
      const team = event.teams.id(teamMatch[1]);
      if (!team) { sendJson(res, 404, { error: 'Team not found.' }); return true; }
      const assigned = event.participants.some(participant => participant.teamId === String(team._id));
      const submitted = await EventSubmission.exists({ eventId: event._id, teamId: String(team._id) });
      if (assigned || submitted) {
        sendJson(res, 409, { error: 'This team has members or result history. Reassign members and preserve the event record before deleting it.' });
        return true;
      }
      event.teams.pull({ _id: team._id });
      await event.save();
      sendJson(res, 200, { success: true });
      return true;
    }

    const participantMatch = suffix.match(/^participants\/(\d{5,25})$/);
    if (participantMatch && req.method === 'PATCH') {
      try {
        if (event.participationMode !== 'team') throw new Error('This event uses solo participation.');
        const participant = event.participants.find(item => item.userId === participantMatch[1]);
        if (!participant) { sendJson(res, 404, { error: 'Participant not found.' }); return true; }
        const body = await readBody(req);
        if (body.teamId == null || body.teamId === '') {
          participant.teamId = '';
        } else {
          const team = event.teams.id(String(body.teamId));
          if (!team) throw new Error('Select a team belonging to this event.');
          participant.teamId = String(team._id);
        }
        await event.save();
        await EventSubmission.updateMany(
          { eventId: event._id, submittedById: participant.userId, kind: 'goal' },
          { $set: { teamId: participant.teamId, teamName: event.teams.id(participant.teamId)?.name || '' } }
        );
        await refreshAwards(event);
        sendJson(res, 200, { participant });
      } catch (error) { routeError(res, error); }
      return true;
    }

    const reviewMatch = suffix.match(/^submissions\/([a-f\d]{24})\/review$/i);
    if (reviewMatch && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const decision = body.decision;
        if (!['approve', 'reject'].includes(decision)) throw new Error('Decision must be approve or reject.');
        const submission = await EventSubmission.findOne({ _id: reviewMatch[1], eventId: event._id });
        if (!submission || submission.status !== 'pending') {
          sendJson(res, 404, { error: 'Pending result not found.' });
          return true;
        }
        if (decision === 'reject') {
          submission.status = 'rejected';
          submission.reviewedBy = 'Dashboard moderator';
          submission.reviewNote = String(body.note || '').trim().slice(0, 1000);
          await submission.save();
          notifySubmitter(submission, `Your result for **${submission.goalName || 'the event'}** was rejected.${submission.reviewNote ? ` Note: ${submission.reviewNote}` : ''}`);
          sendJson(res, 200, { submission });
          return true;
        }

        const goal = goalById(event, submission.goalId);
        if (!goal) throw new Error('The goal for this result no longer exists.');
        if (event.scoringMode === 'task-points') {
          const duplicate = await EventSubmission.exists({
            eventId: event._id,
            goalId: submission.goalId,
            targetId: submission.targetId,
            status: { $in: ['approved', 'verified'] },
            _id: { $ne: submission._id },
          });
          if (duplicate) throw new Error('This goal already has an approved result for that participant or team.');
        }
        submission.status = 'approved';
        submission.reviewedBy = 'Dashboard moderator';
        submission.reviewNote = String(body.note || '').trim().slice(0, 1000);
        await submission.save();
        await refreshAwards(event);
        const refreshed = await EventSubmission.findById(submission._id).lean();
        notifySubmitter(submission, `Your result for **${submission.goalName || 'the event'}** was approved. It is now included in the standings.`);
        sendJson(res, 200, { submission: refreshed });
      } catch (error) {
        const conflict = /already has an approved result/.test(error.message);
        routeError(res, error, conflict ? 409 : 400);
      }
      return true;
    }

    if (suffix === 'score-adjustments' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const targetType = body.targetType;
        if (!['solo', 'team'].includes(targetType)) throw new Error('Target type must be solo or team.');
        if (targetType !== (event.participationMode === 'team' ? 'team' : 'solo')) {
          throw new Error('Score target type must match this event’s participation mode.');
        }
        const targetId = String(body.targetId || '');
        let username = '';
        let teamId = '';
        let teamName = '';
        if (targetType === 'team') {
          const team = event.teams.id(targetId);
          if (!team) throw new Error('Select a team in this event.');
          teamId = String(team._id);
          teamName = team.name;
          username = team.name;
        } else {
          const participant = event.participants.find(item => item.userId === targetId);
          if (!participant) throw new Error('Select an enrolled participant.');
          username = participant.username;
        }
        const points = Number(body.points);
        if (!Number.isFinite(points) || points === 0 || Math.abs(points) > MAX_RESULT_VALUE) {
          throw new Error('Enter a non-zero adjustment of up to 1,000,000,000 points.');
        }
        const reason = String(body.reason || '').trim();
        if (!reason || reason.length > 300) throw new Error('A reason of up to 300 characters is required.');
        const submission = await EventSubmission.create({
          eventId: event._id,
          kind: 'adjustment',
          targetId,
          targetType,
          submittedById: '',
          username,
          teamId,
          teamName,
          value: points,
          note: reason,
          status: 'approved',
          source: 'dashboard',
          reviewedBy: 'Dashboard moderator',
          reviewNote: reason,
          pointsAwarded: points,
        });
        sendJson(res, 201, { submission });
      } catch (error) { routeError(res, error); }
      return true;
    }

    const syncMatch = suffix.match(/^droptracker-sync$/);
    if (syncMatch && req.method === 'POST') {
      try {
        const result = await syncDroptrackerEvent(event);
        sendJson(res, result.error ? 503 : 200, result);
      } catch (error) { routeError(res, error, 500); }
      return true;
    }

    return false;
  }

  function notifySubmitter(submission, message) {
    if (!submission.submittedById) return;
    client.users.fetch(submission.submittedById)
      .then(user => user.send(message))
      .catch(() => {});
  }

  function makeTarget(event, participant) {
    if (event.participationMode === 'team') {
      const team = event.teams.id(participant.teamId);
      if (!team) return null;
      return { targetId: String(team._id), targetType: 'team', teamId: String(team._id), teamName: team.name };
    }
    return { targetId: participant.userId, targetType: 'solo', teamId: '', teamName: '' };
  }

  async function handleCommand(interaction) {
    const { options, user } = interaction;
    const subcommand = options.getSubcommand();
    await interaction.deferReply();

    try {
      if (subcommand === 'list') {
        const now = new Date();
        const events = await OsrsEvent.find({
          status: { $in: ['upcoming', 'active'] },
          endsAt: { $gte: now },
        }).sort({ startsAt: 1 }).limit(15).lean();
        if (!events.length) return interaction.editReply('There are no upcoming or active events right now.');
        const lines = events.map(event => {
          const participants = event.participants?.length || 0;
          return `• **${event.name}** — ${event.format}, ${event.status}, ${new Date(event.startsAt).toLocaleString()} to ${new Date(event.endsAt).toLocaleString()} · ${participants} joined`;
        });
        return interaction.editReply(`**Clan events**\n${lines.join('\n')}\n\nJoin with \`/event join\`; submit results with \`/event submit\`.`);
      }

      const eventId = options.getString('event');
      const event = await OsrsEvent.findById(eventId).catch(() => null);
      if (!event) return interaction.editReply('That event could not be found. Check `/event list` for available events.');

      if (subcommand === 'join') {
        if (!['upcoming', 'active'].includes(event.status) || new Date(event.endsAt) < new Date()) {
          return interaction.editReply('This event is not accepting new participants.');
        }
        const teamId = options.getString('team');
        if (event.participationMode === 'team') {
          if (!event.teams.length) return interaction.editReply('No teams have been set up for this event yet. Ask a moderator.');
          if (!teamId) return interaction.editReply(`Choose a team from the \`team\` option and run \`/event join\` again.\n${event.teams.map(team => `• ${team.name}`).join('\n')}`);
          const team = event.teams.id(teamId);
          if (!team) return interaction.editReply('That team does not belong to this event. Choose one from the team option.');
        }
        let participant = event.participants.find(person => person.userId === user.id);
        if (participant) {
          if (event.participationMode === 'team' && teamId) participant.teamId = teamId;
          participant.username = user.username;
          await event.save();
          const team = participant.teamId ? event.teams.id(participant.teamId) : null;
          return interaction.editReply(`You are already enrolled in **${event.name}**${team ? ` with **${team.name}**` : ''}.`);
        }
        event.participants.push({
          userId: user.id,
          username: user.username,
          teamId: event.participationMode === 'team' ? teamId : '',
        });
        await event.save();
        const team = event.participationMode === 'team' ? event.teams.id(teamId) : null;
        return interaction.editReply(`You joined **${event.name}**${team ? ` with **${team.name}**` : ''}.`);
      }

      const participant = event.participants.find(person => person.userId === user.id);
      if (!participant) return interaction.editReply(`Join **${event.name}** with \`/event join\` before using this event command.`);
      const target = makeTarget(event, participant);
      if (!target) return interaction.editReply('Your event team assignment is missing. Ask a moderator to assign you to a team.');

      if (subcommand === 'leaderboard') {
        const submissions = await EventSubmission.find({ eventId: event._id }).sort({ createdAt: -1 }).limit(5000).lean();
        const leaderboard = leaderboardFor(event, submissions);
        if (!leaderboard.length) return interaction.editReply(`**${event.name}** has no approved scores yet.`);
        const lines = leaderboard.slice(0, 20).map((entry, index) =>
          `${index + 1}. **${entry.name}** — ${entry.points} pts · ${entry.completedGoals} goals`
        );
        return interaction.editReply(`**${event.name} leaderboard**\n${lines.join('\n')}`);
      }

      if (subcommand === 'progress') {
        const [submissions, team] = await Promise.all([
          EventSubmission.find({ eventId: event._id, targetId: target.targetId }).sort({ createdAt: -1 }).limit(100).lean(),
          target.teamId ? event.teams.id(target.teamId) : null,
        ]);
        const approved = submissions.filter(item => ['approved', 'verified'].includes(item.status));
        const pending = submissions.filter(item => item.status === 'pending').length;
        const score = leaderboardFor(event, submissions).find(item => item.targetId === target.targetId)?.points || 0;
        return interaction.editReply(`**${event.name} progress — ${team?.name || user.username}**\n${score} points · ${approved.length} verified result(s) · ${pending} awaiting review\n${event.goals.map(goal => `• ${goal.name} — ${approved.some(item => item.goalId === String(goal._id)) ? 'complete' : 'not completed'}`).join('\n') || 'No goals have been configured yet.'}`);
      }

      if (subcommand === 'submit') {
        if (!eventIsInWindow(event)) return interaction.editReply('This event is not active now, so new results are closed.');
        const goal = goalById(event, options.getString('goal'));
        if (!goal) return interaction.editReply('That goal could not be found in this event.');
        if (goal.verification === 'manual') return interaction.editReply('This goal is entered by moderators. Ask a moderator to record your result.');
        const proof = safeHttpUrl(options.getString('proof')) || safeHttpUrl(options.getAttachment('evidence')?.url);
        if (goal.verification === 'proof' && !proof) {
          return interaction.editReply('This goal requires evidence. Attach a screenshot or provide a proof URL.');
        }
        if (goal.verification === 'droptracker' && !proof) {
          return interaction.editReply('Droptracker will check this result automatically when it can match it. If it does not appear, submit again with a screenshot or proof link for manual review.');
        }
        const value = Number(options.getNumber('value') ?? 1);
        if (!Number.isFinite(value) || value <= 0 || value > MAX_RESULT_VALUE) {
          return interaction.editReply('The result value must be greater than 0 and no more than 1,000,000,000.');
        }
        const duplicate = await EventSubmission.exists({
          eventId: event._id,
          goalId: String(goal._id),
          targetId: target.targetId,
          status: { $in: ['pending', 'approved', 'verified'] },
        });
        if (duplicate && event.scoringMode === 'task-points') {
          return interaction.editReply('A result for this goal is already submitted or approved for you or your team.');
        }
        const submission = await EventSubmission.create({
          eventId: event._id,
          goalId: String(goal._id),
          goalName: goal.name,
          targetId: target.targetId,
          targetType: target.targetType,
          submittedById: user.id,
          username: user.username,
          teamId: target.teamId,
          teamName: target.teamName,
          value,
          proofUrl: proof,
          note: String(options.getString('note') || '').trim().slice(0, 1000),
          status: 'pending',
          source: 'discord',
        });
        return interaction.editReply(`Result submitted for **${goal.name}** in **${event.name}**. It is awaiting moderator review.`);
      }
      return interaction.editReply('Unknown event action.');
    } catch (error) {
      console.error('/event command failed:', error);
      return interaction.editReply(`Event command failed: ${error.message || 'unexpected error'}`);
    }
  }

  async function handleAutocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const subcommand = interaction.options.getSubcommand();
    try {
      if (focused.name === 'event') {
        const events = await OsrsEvent.find({
          status: { $in: ['upcoming', 'active'] },
          endsAt: { $gte: new Date() },
        }).sort({ startsAt: 1 }).limit(100).lean();
        const needle = String(focused.value || '').toLowerCase();
        return interaction.respond(events
          .filter(event => `${event.name} ${event.status} ${event.format}`.toLowerCase().includes(needle))
          .slice(0, 25)
          .map(event => ({
            name: `${event.name} · ${event.status}`.slice(0, 100),
            value: String(event._id),
          })));
      }
      const eventId = interaction.options.getString('event');
      if (!eventId) return interaction.respond([]);
      const event = await OsrsEvent.findById(eventId).catch(() => null);
      if (!event) return interaction.respond([]);
      const needle = String(focused.value || '').toLowerCase();
      if (subcommand === 'join' && focused.name === 'team') {
        return interaction.respond(event.teams
          .filter(team => team.name.toLowerCase().includes(needle))
          .slice(0, 25)
          .map(team => ({ name: team.name.slice(0, 100), value: String(team._id) })));
      }
      if (subcommand === 'submit' && focused.name === 'goal') {
        return interaction.respond(event.goals
          .filter(goal => goal.name.toLowerCase().includes(needle))
          .slice(0, 25)
          .map(goal => ({ name: goal.name.slice(0, 100), value: String(goal._id) })));
      }
      return interaction.respond([]);
    } catch (error) {
      console.error('Event autocomplete failed:', error.message);
      return interaction.respond([]);
    }
  }

  async function syncDroptrackerEvent(event) {
    if (!process.env.DROPTRACKER_API_KEY) {
      return { error: 'Droptracker is not configured. Result submissions can still use proof review.' };
    }
    const now = new Date();
    if (event && !eventIsInWindow(event, now)) {
      return { synced: 0, message: 'Only active events inside their scheduled window are checked.' };
    }
    const events = event ? [event] : await OsrsEvent.find({
      status: 'active',
      startsAt: { $lte: now },
      endsAt: { $gte: now },
      'goals.verification': 'droptracker',
    });
    let synced = 0;
    for (const currentEvent of events) {
      const participants = currentEvent.participants || [];
      const users = await User.find({ userId: { $in: participants.map(person => person.userId) } })
        .select('userId rsName rsNames').lean();
      const linkedNames = new Map(users.map(user => [user.userId, [user.rsName, ...(user.rsNames || [])].filter(Boolean)]));
      for (const goal of currentEvent.goals.filter(item => item.verification === 'droptracker' && item.kind === 'drop')) {
        const result = await getDroptrackerDrops(goal.criteria?.npcName || null, 100);
        if (result.error) continue;
        const body = result.data;
        const drops = Array.isArray(body) ? body : (body?.drops || body?.items || []);
        for (const drop of drops) {
          const timestamp = drop.created_at || drop.timestamp || drop.time;
          const droppedAt = timestamp ? new Date(timestamp) : null;
          if (!droppedAt || Number.isNaN(droppedAt.getTime())) continue;
          if (droppedAt < currentEvent.startsAt || droppedAt > currentEvent.endsAt) continue;
          const npcName = String(drop.npc_name || '').trim();
          const itemName = String(drop.item_name || drop.name || '').trim();
          if (goal.criteria?.npcName && npcName.toLowerCase() !== goal.criteria.npcName.toLowerCase()) continue;
          if (goal.criteria?.itemName && itemName.toLowerCase() !== goal.criteria.itemName.toLowerCase()) continue;
          const value = Number(drop.value ?? drop.item_value ?? 0);
          if (!Number.isFinite(value) || value < Number(goal.criteria?.minValue || 0)) continue;
          const playerName = drop.player_name || drop.player || drop.username;
          const participant = participants.find(person =>
            (linkedNames.get(person.userId) || []).some(name => NAME_KEY(name) === NAME_KEY(playerName))
          );
          if (!participant) continue;
          const target = currentEvent.participationMode === 'team'
            ? (() => {
                const team = currentEvent.teams.id(participant.teamId);
                return team ? { targetId: String(team._id), targetType: 'team', teamId: String(team._id), teamName: team.name } : null;
              })()
            : { targetId: participant.userId, targetType: 'solo', teamId: '', teamName: '' };
          if (!target) continue;
          const externalId = String(drop.id || drop.drop_id || crypto.createHash('sha256').update([
            currentEvent._id, goal._id, playerName, itemName, npcName, timestamp, value,
          ].join('|')).digest('hex'));
          try {
            await EventSubmission.create({
              eventId: currentEvent._id,
              goalId: String(goal._id),
              goalName: goal.name,
              targetId: target.targetId,
              targetType: target.targetType,
              submittedById: participant.userId,
              username: participant.username,
              teamId: target.teamId,
              teamName: target.teamName,
              value,
              proofUrl: '',
              note: `Droptracker verified ${itemName || 'a drop'} at ${npcName || 'a tracked activity'}.`,
              status: 'verified',
              source: 'droptracker',
              externalId,
              reviewedBy: 'Droptracker',
            });
            synced++;
          } catch (error) {
            if (error.code !== 11000) console.error('Droptracker event result error:', error.message);
          }
        }
      }
      if (synced) await refreshAwards(currentEvent);
    }
    return { synced };
  }

  return { handleApi, handleCommand, handleAutocomplete, syncDroptrackerEvent };
}

module.exports = { createEventService };
