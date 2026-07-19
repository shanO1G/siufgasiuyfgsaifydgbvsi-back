const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  userA: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userB: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  matchedAt: {
    type: Date,
    default: Date.now,
    required: true
  },
  conversationId: {
    type: String,
    required: true
  }
});

// Unique index on userA and userB
matchSchema.index({ userA: 1, userB: 1 }, { unique: true });

// Pre-save middleware to guarantee userA is lexicographically smaller than userB
matchSchema.pre('save', function (next) {
  if (this.userA.toString() > this.userB.toString()) {
    const temp = this.userA;
    this.userA = this.userB;
    this.userB = temp;
  }
  next();
});

module.exports = mongoose.model('Match', matchSchema);
