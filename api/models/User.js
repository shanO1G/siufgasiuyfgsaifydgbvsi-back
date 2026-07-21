const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: false
  },
  age: {
    type: Number,
    required: false
  },
  school: {
    type: String,
    index: true
  },
  course: {
    type: String,
    index: true
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other'],
    index: true
  },
  height: {
    type: Number // in cm
  },
  pictures: {
    type: [{
      url: { type: String, required: true },
      fileId: { type: String, required: true }
    }],
    validate: [val => val.length <= 4, 'User can have at most 4 pictures']
  },
  hobbies: {
    type: [String],
    default: []
  },
  skills: {
    type: [String],
    default: []
  },
  lookingFor: {
    type: String,
    enum: ['friends', 'dating']
  },
  bio: {
    type: String,
    default: ''
  },
  tags: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  sexualOrientation: {
    type: String
  },
  isPremium: {
    type: Boolean,
    default: false
  },
  badges: {
    type: [String],
    default: []
  },
  banned: {
    type: Boolean,
    default: false
  },
  banReason: {
    type: String
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  identityStatus: {
    type: String,
    enum: ['not_submitted', 'pending', 'verified', 'unverified'],
    default: 'not_submitted'
  },
  identityReviewReason: {
    type: String
  },
  identityReviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  identityReviewedAt: {
    type: Date
  },
  openFlagCount: {
    type: Number,
    default: 0
  },
  tier: {
    type: String,
    enum: ['free', 'silver', 'gold'],
    default: 'free',
    index: true
  },
  subscriptionExpiresAt: {
    type: Date
  },
  razorpayOrderId: {
    type: String
  },
  razorpayPaymentId: {
    type: String
  },
  razorpaySubscriptionId: {
    type: String
  },
  autopayStatus: {
    type: String,
    enum: ['active', 'cancelled', 'halted', 'none'],
    default: 'none'
  },
  resetPasswordToken: {
    type: String
  },
  resetPasswordExpires: {
    type: Date
  }
}, {
  timestamps: true
});

// Text index on bio, hobbies, and skills
userSchema.index({ bio: 'text', hobbies: 'text', skills: 'text' });

module.exports = mongoose.model('User', userSchema);
