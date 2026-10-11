const mongoose = require('mongoose');

const EVENT_FORMATS = ['bingo', 'race', 'drop', 'custom'];
const EVENT_STATUSES = ['draft', 'upcoming', 'active', 'completed', 'archived'];
const PARTICIPATION_MODES = ['solo', 'team'];
const SCORING_MODES = ['task-points', 'points-per-unit', 'highest-value', 'first-to-target'];
const GOAL_KINDS = ['task', 'counter', 'drop', 'collection'];
const VERIFICATION_MODES = ['proof', 'droptracker', 'manual'];

const eventGoalSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: '', trim: true, maxlength: 500 },
  kind: { type: String, enum: GOAL_KINDS, default: 'task' },
  targetValue: { type: Number, default: 1, min: 0.000001 },
  unit: { type: String, default: '', trim: true, maxlength: 30 },
  points: { type: Number, default: 1, min: 0 },
  verification: { type: String, enum: VERIFICATION_MODES, default: 'proof' },
  criteria: { type: mongoose.Schema.Types.Mixed, default: {} },
  row: { type: Number, min: 1, max: 20, default: null },
  col: { type: Number, min: 1, max: 20, default: null },
}, { _id: true });

const eventTeamSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  color: { type: String, default: '#8ab4f8', match: /^#[0-9a-fA-F]{6}$/ },
}, { _id: true });

const eventParticipantSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, default: '' },
  teamId: { type: String, default: '' },
  joinedAt: { type: Date, default: Date.now },
}, { _id: false });

const osrsEventSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: '', trim: true, maxlength: 2000 },
  format: { type: String, required: true, enum: EVENT_FORMATS },
  status: { type: String, default: 'draft', enum: EVENT_STATUSES },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  participationMode: { type: String, default: 'solo', enum: PARTICIPATION_MODES },
  scoringMode: { type: String, default: 'task-points', enum: SCORING_MODES },
  scoringConfig: { type: mongoose.Schema.Types.Mixed, default: {} },
  goals: { type: [eventGoalSchema], default: [] },
  teams: { type: [eventTeamSchema], default: [] },
  participants: { type: [eventParticipantSchema], default: [] },
  createdBy: { type: String, default: '' },
}, { timestamps: true });
osrsEventSchema.index({ status: 1, startsAt: 1, endsAt: 1 });

const eventSubmissionSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'OsrsEvent', required: true, index: true },
  kind: { type: String, enum: ['goal', 'adjustment'], default: 'goal' },
  goalId: { type: String, default: '' },
  goalName: { type: String, default: '' },
  targetId: { type: String, required: true },
  targetType: { type: String, enum: ['solo', 'team'], required: true },
  submittedById: { type: String, default: '' },
  username: { type: String, default: '' },
  teamId: { type: String, default: '' },
  teamName: { type: String, default: '' },
  value: { type: Number, default: 1 },
  proofUrl: { type: String, default: '' },
  note: { type: String, default: '', maxlength: 1000 },
  status: { type: String, enum: ['pending', 'approved', 'verified', 'rejected'], default: 'pending' },
  source: { type: String, enum: ['discord', 'dashboard', 'droptracker'], default: 'discord' },
  externalId: { type: String, default: null },
  reviewedBy: { type: String, default: '' },
  reviewNote: { type: String, default: '', maxlength: 1000 },
  pointsAwarded: { type: Number, default: 0 },
}, { timestamps: true });
eventSubmissionSchema.index({ eventId: 1, status: 1, createdAt: -1 });
eventSubmissionSchema.index(
  { eventId: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } }
);

const OsrsEvent = mongoose.models.OsrsEvent || mongoose.model('OsrsEvent', osrsEventSchema);
const EventSubmission = mongoose.models.EventSubmission || mongoose.model('EventSubmission', eventSubmissionSchema);

function validEnum(value, values, label) {
  if (!values.includes(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function finiteNumber(value, label, { min = 0, max = 1_000_000_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizeDate(value, label) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${label} is required and must be a valid date.`);
  return date;
}

function normalizeGoal(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Each goal needs a name.');
  if (name.length > 100) throw new Error('Goal names must be 100 characters or fewer.');
  const criteria = input.criteria && typeof input.criteria === 'object' && !Array.isArray(input.criteria)
    ? {
        npcName: String(input.criteria.npcName || '').trim().slice(0, 100),
        itemName: String(input.criteria.itemName || '').trim().slice(0, 100),
        minValue: input.criteria.minValue === undefined || input.criteria.minValue === ''
          ? 0
          : finiteNumber(input.criteria.minValue, 'Drop value filter'),
      }
    : {};

  const row = input.row === '' || input.row === undefined || input.row === null ? null : finiteNumber(input.row, 'Goal row', { min: 1, max: 20 });
  const col = input.col === '' || input.col === undefined || input.col === null ? null : finiteNumber(input.col, 'Goal column', { min: 1, max: 20 });
  if ((row !== null && !Number.isInteger(row)) || (col !== null && !Number.isInteger(col))) {
    throw new Error('Bingo row and column must be whole numbers.');
  }

  return {
    name,
    description: String(input.description || '').trim().slice(0, 500),
    kind: validEnum(input.kind || 'task', GOAL_KINDS, 'goal type'),
    targetValue: finiteNumber(input.targetValue ?? 1, 'Goal target', { min: 0.000001 }),
    unit: String(input.unit || '').trim().slice(0, 30),
    points: finiteNumber(input.points ?? 1, 'Goal points'),
    verification: validEnum(input.verification || 'proof', VERIFICATION_MODES, 'verification method'),
    criteria,
    row,
    col,
  };
}

function normalizeScoringConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const config = {};
  for (const key of ['pointsPerUnit', 'firstPlaceBonus', 'lineBonus', 'gridSize']) {
    if (input[key] !== undefined && input[key] !== '') {
      config[key] = finiteNumber(input[key], key, {
        min: key === 'gridSize' ? 2 : 0,
        max: key === 'gridSize' ? 20 : 1_000_000_000,
      });
    }
  }
  return config;
}

function normalizeEventInput(input = {}, { partial = false } = {}) {
  const result = {};
  const assign = (key, normalize) => {
    if (input[key] !== undefined || !partial) result[key] = normalize(input[key]);
  };

  assign('name', value => {
    const name = String(value || '').trim();
    if (!name) throw new Error('Event name is required.');
    if (name.length > 100) throw new Error('Event names must be 100 characters or fewer.');
    return name;
  });
  assign('description', value => String(value || '').trim().slice(0, 2000));
  assign('format', value => validEnum(value || 'custom', EVENT_FORMATS, 'event format'));
  assign('status', value => validEnum(value || 'draft', EVENT_STATUSES, 'event status'));
  assign('participationMode', value => validEnum(value || 'solo', PARTICIPATION_MODES, 'participation mode'));
  assign('scoringMode', value => validEnum(value || 'task-points', SCORING_MODES, 'scoring mode'));
  assign('scoringConfig', normalizeScoringConfig);
  assign('startsAt', value => normalizeDate(value, 'Event start'));
  assign('endsAt', value => normalizeDate(value, 'Event end'));
  if (input.goals !== undefined || !partial) {
    const goals = input.goals === undefined ? [] : input.goals;
    if (!Array.isArray(goals)) throw new Error('Goals must be a list.');
    if (goals.length > 100) throw new Error('An event can have at most 100 goals.');
    result.goals = goals.map(normalizeGoal);
  }

  const startsAt = result.startsAt || input.startsAt;
  const endsAt = result.endsAt || input.endsAt;
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    throw new Error('Event end must be after its start.');
  }
  return result;
}

function goalById(event, goalId) {
  return event.goals.id(goalId) || event.goals.find(goal => String(goal._id) === String(goalId));
}

function leaderboardFor(event, submissions) {
  const targets = new Map();
  const goalsById = new Map(event.goals.map(goal => [String(goal._id), goal]));
  const teamsById = new Map(event.teams.map(team => [String(team._id), team]));

  for (const submission of submissions) {
    if (!['approved', 'verified'].includes(submission.status)) continue;
    const key = `${submission.targetType}:${submission.targetId}`;
    if (!targets.has(key)) {
      const team = submission.targetType === 'team' ? teamsById.get(String(submission.targetId)) : null;
      targets.set(key, {
        targetId: submission.targetId,
        targetType: submission.targetType,
        name: team?.name || submission.username || submission.targetId,
        color: team?.color || '',
        points: 0,
        completedGoals: 0,
        submissions: 0,
        goalIds: new Set(),
        bestByGoal: new Map(),
      });
    }
    const entry = targets.get(key);
    entry.submissions++;
    if (submission.kind === 'adjustment') {
      entry.points += Number(submission.pointsAwarded || 0);
      continue;
    }
    const goalKey = String(submission.goalId);
    const goal = goalsById.get(goalKey);
    if (goal) entry.goalIds.add(goalKey);
    const score = Number(submission.pointsAwarded || 0);
    if (event.scoringMode === 'highest-value') {
      entry.bestByGoal.set(goalKey, Math.max(entry.bestByGoal.get(goalKey) || 0, Number(submission.value || 0)));
    } else {
      entry.points += score;
    }
  }

  for (const entry of targets.values()) {
    if (event.scoringMode === 'highest-value') {
      entry.points += [...entry.bestByGoal.values()].reduce((sum, score) => sum + score, 0);
    }
    entry.completedGoals = entry.goalIds.size;

    if (event.format === 'bingo' && Number(event.scoringConfig?.lineBonus) > 0) {
      const size = Number(event.scoringConfig.gridSize) || 6;
      const occupied = new Set();
      for (const goalId of entry.goalIds) {
        const goal = goalsById.get(goalId);
        if (goal?.row && goal?.col) occupied.add(`${goal.row}:${goal.col}`);
      }
      let lines = 0;
      for (let row = 1; row <= size; row++) {
        if (Array.from({ length: size }, (_, i) => occupied.has(`${row}:${i + 1}`)).every(Boolean)) lines++;
      }
      for (let col = 1; col <= size; col++) {
        if (Array.from({ length: size }, (_, i) => occupied.has(`${i + 1}:${col}`)).every(Boolean)) lines++;
      }
      if (Array.from({ length: size }, (_, i) => occupied.has(`${i + 1}:${i + 1}`)).every(Boolean)) lines++;
      if (Array.from({ length: size }, (_, i) => occupied.has(`${i + 1}:${size - i}`)).every(Boolean)) lines++;
      entry.points += lines * Number(event.scoringConfig.lineBonus);
    }

    delete entry.goalIds;
    delete entry.bestByGoal;
  }

  const leaderboard = [...targets.values()].sort((a, b) =>
    b.points - a.points || b.completedGoals - a.completedGoals || a.name.localeCompare(b.name)
  );
  if (leaderboard.length && Number(event.scoringConfig?.firstPlaceBonus) > 0) {
    leaderboard[0].points += Number(event.scoringConfig.firstPlaceBonus);
  }
  return leaderboard;
}

module.exports = {
  OsrsEvent,
  EventSubmission,
  EVENT_FORMATS,
  EVENT_STATUSES,
  PARTICIPATION_MODES,
  SCORING_MODES,
  GOAL_KINDS,
  VERIFICATION_MODES,
  normalizeGoal,
  normalizeEventInput,
  normalizeScoringConfig,
  goalById,
  leaderboardFor,
};
