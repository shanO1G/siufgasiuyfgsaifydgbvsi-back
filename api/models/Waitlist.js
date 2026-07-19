const mongoose = require('mongoose');

const waitlistSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  name: {
    type: String,
    trim: true
  },
  joinedAt: {
    type: Date,
    default: Date.now,
    required: true
  }
});

module.exports = mongoose.model('Waitlist', waitlistSchema);
