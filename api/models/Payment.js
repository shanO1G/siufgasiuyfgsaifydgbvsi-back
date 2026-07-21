const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  tier: {
    type: String,
    enum: ['silver', 'gold'],
    required: true
  },
  amount: {
    type: Number, // In INR (e.g., 39 or 49)
    required: true
  },
  amountPaise: {
    type: Number, // In paise (e.g., 3900 or 4900)
    required: true
  },
  currency: {
    type: String,
    default: 'INR'
  },
  razorpayOrderId: {
    type: String,
    sparse: true
  },
  razorpaySubscriptionId: {
    type: String,
    index: true
  },
  planId: {
    type: String
  },
  razorpayPaymentId: {
    type: String
  },
  razorpaySignature: {
    type: String
  },
  isAutopay: {
    type: Boolean,
    default: true
  },
  billingCycle: {
    type: Number,
    default: 1
  },
  status: {
    type: String,
    enum: ['created', 'active', 'paid', 'cancelled', 'halted', 'failed'],
    default: 'created',
    index: true
  },
  activatedAt: {
    type: Date
  },
  expiresAt: {
    type: Date
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Payment', paymentSchema);
