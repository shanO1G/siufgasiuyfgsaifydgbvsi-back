const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  reporterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  targetUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  targetPostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AnonymousPost'
  },
  reason: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['open', 'reviewed', 'dismissed', 'actioned'],
    default: 'open',
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    required: true,
    index: true
  }
});

// Compound index on status and createdAt
reportSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('Report', reportSchema);
