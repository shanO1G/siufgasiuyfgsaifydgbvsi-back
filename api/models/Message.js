const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  conversationId: {
    type: String,
    required: true
  },
  clientMessageId: {
    type: String,
    required: false
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  ciphertext: {
    type: String,
    required: true
  },
  iv: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now,
    required: true
  },
  delivered: {
    type: Boolean,
    default: false
  }
});

// Compound index on conversationId and timestamp
messageSchema.index({ conversationId: 1, timestamp: 1 });

// Idempotency: senderId + clientMessageId must be unique, ignoring nulls
messageSchema.index(
  { senderId: 1, clientMessageId: 1 }, 
  { unique: true, partialFilterExpression: { clientMessageId: { $exists: true, $type: "string" } } }
);

module.exports = mongoose.model('Message', messageSchema);
