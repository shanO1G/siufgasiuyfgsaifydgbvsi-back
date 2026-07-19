const mongoose = require('mongoose');

const WaitlistIPSchema = new mongoose.Schema({
  ip: {
    type: String,
    required: true,
    unique: true,
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  userAgent: { type: String },
  language: { type: String },
  platform: { type: String },
  screenResolution: { type: String },
  timeZone: { type: String },
  cpuCores: { type: Number },
  deviceMemory: { type: Number },
  connectionType: { type: String },
  referrer: { type: String },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.models.WaitlistIP || mongoose.model("WaitlistIP", WaitlistIPSchema);
