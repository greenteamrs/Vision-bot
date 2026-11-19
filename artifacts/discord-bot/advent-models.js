const mongoose = require('mongoose');
const crypto = require('crypto');
const { DEFAULT_CHALLENGES } = require('./advent-domain');

const configSchema = new mongoose.Schema({
  _id: { type: String, default: 'test' },
  runId: { type: String, default: () => crypto.randomUUID() },
  year: { type: Number, default: () => Math.max(2026, new Date().getUTCFullYear()) },
  channelId: { type: String, default: '1572351838823653397' },
  liveStatus: { type: String, enum: ['off', 'scheduled', 'converting', 'running', 'completed'], default: 'off' },
  liveFirstPostAt: { type: Date, default: null },
  liveRunId: { type: String, default: '' },
  liveNextDay: { type: Number, min: 1, max: 27, default: 1 },
  liveStartedAt: { type: Date, default: null },
  challenges: { type: [String], default: () => [...DEFAULT_CHALLENGES] },
  announcementTemplate: { type: String, default: '' },
  announcementClosingMessage: { type: String, default: '' },
  announcementMessages: { type: [String], default: [] },
  calendarImages: { type: [{
    _id: false,
    day: { type: Number, min: 0, max: 25, required: true },
    fileId: { type: String, required: true },
    contentType: { type: String, enum:['image/png', 'image/jpeg'], default:'image/png' },
    size: { type: Number, required: true },
    updatedAt: { type: Date, required: true },
  }], default: [] },
  dayDurationSeconds: { type: Number, default: 86400 },
  state: { type: String, enum: ['idle', 'running', 'paused', 'completed'], default: 'idle' },
  startDay: { type: Number, default: 0 },
  startedAt: { type: Date, default: null },
  pausedElapsedMs: { type: Number, default: 0 },
  revision: { type: Number, default: 0 },
}, { timestamps: true });

const submissionSchema = new mongoose.Schema({
  runId: { type: String, required: true },
  day: { type: Number, required: true, min: 1, max: 25 },
  challenge: { type: String, required: true },
  userId: { type: String, required: true },
  username: { type: String, required: true },
  proofUrl: { type: String, required: true },
  messageId: { type: String, required: true },
  attachmentId: { type: String, required: true },
  note: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  reviewNote: { type: String, default: '' },
  reviewedBy: { type: String, default: '' },
  submittedByAdmin: { type: String, default: '' },
  sourceChannelId: { type: String, default: '' },
}, { timestamps: true });
submissionSchema.index({ runId: 1, day: 1, userId: 1 }, { unique: true });

const announcementSchema = new mongoose.Schema({
  runId: { type: String, required: true },
  day: { type: Number, required: true },
  status: { type: String, enum: ['sending', 'sent', 'failed'], required: true },
  leaseUntil: Date,
  messageId: { type: String, default: '' },
  channelId: { type: String, default: '' },
  imageMessageId: { type: String, default: '' },
  textMessageIds: { type: [String], default: [] },
  textChunks: { type: [String], default: [] },
  postingStartedAt: { type: Date, default: null },
  error: { type: String, default: '' },
}, { timestamps: true });
announcementSchema.index({ runId: 1, day: 1 }, { unique: true });

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);
module.exports = {
  AdventTest: model('AdventTest', configSchema),
  AdventSubmission: model('AdventSubmission', submissionSchema),
  AdventAnnouncement: model('AdventAnnouncement', announcementSchema),
};
