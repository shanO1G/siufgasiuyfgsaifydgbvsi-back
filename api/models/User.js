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
  interests: {
    type: [{
      segmentId: { type: String },
      interestId: { type: String, required: true },
      label: { type: String, required: true },
      emoji: { type: String, default: '' }
    }],
    default: []
  },
  prompts: {
    type: [{
      promptId: { type: String, required: true },
      sectionId: { type: String },
      question: { type: String, required: true },
      answer: { type: String, required: true }
    }],
    default: []
  },
  sexualOrientation: {
    type: String
  },
  religion: {
    type: String,
    trim: true,
    default: ''
  },
  beliefs: {
    type: String,
    trim: true,
    default: ''
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
  // ── Google Play Billing fields (new subscribers) ──────────────────────────
  playPurchaseToken: {
    type: String,
    index: true
  },
  playProductId: {
    type: String // 'frnd_silver_pass' | 'frnd_gold_pass'
  },
  playSubscriptionState: {
    type: String,
    enum: ['active', 'canceled', 'expired', 'on_hold', 'none'],
    default: 'none'
  },
  customDesignId: {
    type: String,
    trim: true,
    default: null
  },
  resetPasswordToken: {
    type: String
  },
  resetPasswordExpires: {
    type: Date
  },
  passwordChangedAt: {
    type: Date
  },
  fcmTokens: {
    type: [String],
    default: []
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Text index on bio, hobbies, and skills
userSchema.index({ bio: 'text', hobbies: 'text', skills: 'text' });

// Compound index for Feed Discovery queries (gender, banned, identityStatus, createdAt)
userSchema.index({ gender: 1, banned: 1, identityStatus: 1, createdAt: -1 });

// Index for Tier filtering & Subscriptions
userSchema.index({ tier: 1, autopayStatus: 1 });

// Virtual property to calculate exact profile completion percentage (0 - 100%)
userSchema.virtual('profileCompletionPercentage').get(function() {
  let score = 0;

  // 1. Profile Pictures: 5% per picture (up to 20% max for 4 pictures)
  if (Array.isArray(this.pictures) && this.pictures.length > 0) {
    score += Math.min(20, this.pictures.length * 5);
  }

  // 2. Full Name: 10%
  if (this.name && this.name.trim().length > 0) {
    score += 10;
  }

  // 3. Bio: 10%
  if (this.bio && this.bio.trim().length > 0) {
    score += 10;
  }

  // 4. Age: 5%
  if (this.age && typeof this.age === 'number' && this.age >= 18) {
    score += 5;
  }

  // 5. Gender: 5%
  if (this.gender) {
    score += 5;
  }

  // 6. Height: 5%
  if (this.height && typeof this.height === 'number') {
    score += 5;
  }

  // 7. School & Course: 10% (5% each)
  if (this.school && this.school.trim().length > 0) score += 5;
  if (this.course && this.course.trim().length > 0) score += 5;

  // 8. Hobbies: 5%
  if (Array.isArray(this.hobbies) && this.hobbies.length > 0) {
    score += 5;
  }

  // 9. Skills: 5%
  if (Array.isArray(this.skills) && this.skills.length > 0) {
    score += 5;
  }

  // 10. Looking For (dating/friends): 5%
  if (this.lookingFor) {
    score += 5;
  }

  // 11. Sexual Orientation: 5%
  if (this.sexualOrientation) {
    score += 5;
  }

  // 12. Onboarding Selected Interests: 10%
  if (Array.isArray(this.interests) && this.interests.length > 0) {
    score += 10;
  }

  // 13. Onboarding Prompt Answers: 10%
  if (Array.isArray(this.prompts) && this.prompts.length > 0) {
    score += 10;
  }

  // Total max = 20 + 10 + 10 + 5 + 5 + 5 + 10 + 5 + 5 + 5 + 5 + 10 + 10 = 100%
  return Math.min(100, score);
});

module.exports = mongoose.model('User', userSchema);
