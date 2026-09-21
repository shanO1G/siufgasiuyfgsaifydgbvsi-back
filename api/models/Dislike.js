const mongoose = require('mongoose');

const dislikeSchema = new mongoose.Schema({
  fromUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  toUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Ensure a user can only dislike another target user once
dislikeSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });

// Ensure efficient lookup of recent dislikes for the 5-day resurfacing rule
dislikeSchema.index({ fromUserId: 1, createdAt: -1 });

module.exports = mongoose.model('Dislike', dislikeSchema);
