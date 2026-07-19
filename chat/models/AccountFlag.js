const mongoose = require('mongoose');

const accountFlagSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  flagType: {
    type: String,
    required: true
  },
  severity: {
    type: String,
    enum: ['low', 'medium', 'high'],
    required: true
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['open', 'reviewed', 'dismissed', 'actioned'],
    default: 'open',
    required: true
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  reviewedAt: {
    type: Date
  }
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

// Compound index on (status, severity, createdAt)
accountFlagSchema.index({ status: 1, severity: 1, createdAt: 1 });

module.exports = mongoose.model('AccountFlag', accountFlagSchema);
