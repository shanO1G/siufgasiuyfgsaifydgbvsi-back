const mongoose = require('mongoose');

const identityVerificationRequestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  idCardImage: {
    url: { type: String, required: true },
    publicId: { type: String, required: true }
  },
  faceImage: {
    url: { type: String, required: true },
    publicId: { type: String, required: true }
  },
  idCardHash: {
    type: String,
    required: true,
    index: true
  },
  faceHash: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'verified', 'unverified'],
    default: 'pending',
    required: true
  },
  reason: {
    type: String
  },
  submittedAt: {
    type: Date,
    default: Date.now,
    required: true
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  reviewedAt: {
    type: Date
  }
});

// Compound index on status and submittedAt
identityVerificationRequestSchema.index({ status: 1, submittedAt: 1 });

module.exports = mongoose.model('IdentityVerificationRequest', identityVerificationRequestSchema);
