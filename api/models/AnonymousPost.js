const mongoose = require('mongoose');

const anonymousPostSchema = new mongoose.Schema({
  content: {
    type: String,
    required: true,
    trim: true
  },
  postedAt: {
    type: Date,
    default: Date.now,
    required: true,
    index: true
  }
});

module.exports = mongoose.model('AnonymousPost', anonymousPostSchema);
