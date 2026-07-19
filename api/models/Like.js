const mongoose = require('mongoose');

const likeSchema = new mongoose.Schema({
  fromUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  toUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['like', 'superlike'],
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    required: true
  }
});

// Unique compound index on fromUserId and toUserId
likeSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });

module.exports = mongoose.model('Like', likeSchema);
