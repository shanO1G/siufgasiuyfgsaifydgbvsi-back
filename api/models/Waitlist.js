const mongoose = require('mongoose');

const WaitlistIPSchema = new mongoose.Schema({
  ip: {
    type: String,
    required: true,
    unique: true,
  },
  email: { type: String },
  userAgent: { type: String },
  language: { type: String },
  platform: { type: String },
  screenResolution: { type: String },
  referrer: { type: String },
  country: { type: String },
  region: { type: String },
  city: { type: String },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.models.WaitlistIP || mongoose.model("WaitlistIP", WaitlistIPSchema);
