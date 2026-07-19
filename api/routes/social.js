const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const Like = require('../models/Like');
const Match = require('../models/Match');
const Block = require('../models/Block');
const Report = require('../models/Report');
const AccountFlag = require('../models/AccountFlag');
const AnonymousPost = require('../models/AnonymousPost');
const Feedback = require('../models/Feedback');
const redis = require('../utils/redis');
const { authRequired } = require('../middleware/auth');

// Helper to calculate seconds until next UTC midnight
function getSecondsToUTCMidnight() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return Math.ceil((nextMidnight.getTime() - now.getTime()) / 1000);
}

// Input length validation helper
function validateStringLength(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength;
}

// ------------------------------------------------------------------
// 1. OWN PROFILE
// ------------------------------------------------------------------

// GET /api/users/me
router.get('/users/me', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

// PUT /api/users/me
router.put('/users/me', authRequired, async (req, res) => {
  try {
    const { username, name, age, bio, school, course, height, hobbies, skills, lookingFor, sexualOrientation, tags, pictures } = req.body;

    // Input validation
    if (username !== undefined) {
      if (!validateStringLength(username, 50)) return res.status(400).json({ error: 'Username too long (max 50 chars)' });
      const cleanUsername = username.toLowerCase().trim();
      const exists = await User.findOne({ username: cleanUsername, _id: { $ne: req.user.id } });
      if (exists) {
        return res.status(400).json({ error: 'Username already taken' });
      }
    }
    if (name !== undefined) {
      if (!validateStringLength(name, 100)) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
    }
    if (age !== undefined && age !== null && age !== '') {
      const finalAge = parseInt(age, 10);
      if (isNaN(finalAge) || finalAge < 18) {
        return res.status(400).json({ error: 'You must be at least 18 years old' });
      }
    }
    if (bio !== undefined) {
      if (!validateStringLength(bio, 500)) return res.status(400).json({ error: 'Bio too long (max 500 chars)' });
    }
    if (school !== undefined && !validateStringLength(school, 150)) {
      return res.status(400).json({ error: 'School name too long (max 150 chars)' });
    }
    if (course !== undefined && !validateStringLength(course, 150)) {
      return res.status(400).json({ error: 'Course name too long (max 150 chars)' });
    }
    if (hobbies !== undefined && (!Array.isArray(hobbies) || hobbies.length > 20)) {
      return res.status(400).json({ error: 'Hobbies must be an array with at most 20 items' });
    }
    if (skills !== undefined && (!Array.isArray(skills) || skills.length > 20)) {
      return res.status(400).json({ error: 'Skills must be an array with at most 20 items' });
    }
    if (pictures !== undefined) {
      if (!Array.isArray(pictures) || pictures.length > 4) {
        return res.status(400).json({ error: 'Pictures must be an array with at most 4 items' });
      }
      for (const pic of pictures) {
        if (!pic.url || !pic.fileId) {
          return res.status(400).json({ error: 'Each picture must have url and fileId fields' });
        }
      }
    }

    // Whitelist of updatable fields — never allow email, passwordHash, banned, etc.
    const allowedUpdates = {};
    if (username !== undefined) allowedUpdates.username = username.toLowerCase().trim();
    if (name !== undefined) allowedUpdates.name = name.trim();
    if (age !== undefined && age !== null && age !== '') allowedUpdates.age = parseInt(age, 10);
    if (bio !== undefined) allowedUpdates.bio = bio.trim();
    if (school !== undefined) allowedUpdates.school = school.trim();
    if (course !== undefined) allowedUpdates.course = course.trim();
    if (height !== undefined && typeof height === 'number') allowedUpdates.height = height;
    if (hobbies !== undefined) allowedUpdates.hobbies = hobbies.map(h => String(h).trim()).filter(Boolean);
    if (skills !== undefined) allowedUpdates.skills = skills.map(s => String(s).trim()).filter(Boolean);
    if (lookingFor !== undefined && ['friends', 'dating'].includes(lookingFor)) allowedUpdates.lookingFor = lookingFor;
    if (sexualOrientation !== undefined && validateStringLength(sexualOrientation, 50)) allowedUpdates.sexualOrientation = sexualOrientation;
    if (tags !== undefined && typeof tags === 'object' && !Array.isArray(tags)) allowedUpdates.tags = tags;
    if (pictures !== undefined) allowedUpdates.pictures = pictures;

    if (Object.keys(allowedUpdates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided to update' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: allowedUpdates },
      { new: true, runValidators: true }
    ).select('-passwordHash');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Invalidate discovery cache for this user
    await redis.del(`discover:${req.user.id}`);

    res.json({ message: 'Profile updated successfully', user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating profile' });
  }
});

// ------------------------------------------------------------------
// 2. DISCOVERY FEED
// ------------------------------------------------------------------
// GET /api/discover
router.get('/discover', authRequired, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    // A. Find all blocked users (both ways)
    const blocks = await Block.find({
      $or: [{ blockerId: userId }, { blockedId: userId }]
    });
    const blockedUserIds = blocks.map(b => b.blockerId.equals(userId) ? b.blockedId : b.blockerId);

    // B. Find existing likes sent by the user
    const sentLikes = await Like.find({ fromUserId: userId });
    const likedUserIds = sentLikes.map(l => l.toUserId);

    // C. Find existing matches
    const matches = await Match.find({
      $or: [{ userA: userId }, { userB: userId }]
    });
    const matchedUserIds = matches.map(m => m.userA.equals(userId) ? m.userB : m.userA);

    // D. Build exclusion list
    const excludedIds = [userId, ...blockedUserIds, ...likedUserIds, ...matchedUserIds];

    // E. Discovery query
    const query = {
      _id: { $nin: excludedIds },
      banned: false
    };

    // Basic gender preferences for dating mode
    if (user.lookingFor === 'dating') {
      if (user.gender === 'male') query.gender = 'female';
      else if (user.gender === 'female') query.gender = 'male';
    }

    const profiles = await User.find(query)
      .select('name age school course gender pictures bio hobbies skills lookingFor identityStatus badges')
      .skip(skip)
      .limit(limit);

    res.json({ profiles, page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during discovery fetch' });
  }
});

// ------------------------------------------------------------------
// 3. LIKES & SUPERLIKES
// ------------------------------------------------------------------
async function handleLikeAction(req, res, actionType) {
  try {
    const fromUserId = new mongoose.Types.ObjectId(req.user.id);
    const toUserId = new mongoose.Types.ObjectId(req.params.targetId);

    if (fromUserId.equals(toUserId)) {
      return res.status(400).json({ error: 'You cannot like yourself' });
    }

    // A. Check target exists and is not banned
    const target = await User.findById(toUserId);
    if (!target || target.banned) {
      return res.status(404).json({ error: 'Target user not found or is banned' });
    }

    const user = await User.findById(fromUserId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // B. Check block status (either direction)
    const isBlocked = await Block.findOne({
      $or: [
        { blockerId: fromUserId, blockedId: toUserId },
        { blockerId: toUserId, blockedId: fromUserId }
      ]
    });
    if (isBlocked) {
      return res.status(400).json({ error: 'Action blocked' });
    }

    // C. Quota enforcement via Redis
    const secondsToMidnight = getSecondsToUTCMidnight();
    const isInsider = user.emailVerified;
    const gender = user.gender;

    let likeLimit = 5;
    let superlikeLimit = 1;

    if (isInsider) {
      likeLimit = Infinity;
      superlikeLimit = 5;
    } else if (gender === 'female') {
      likeLimit = 5;
      superlikeLimit = 5;
    }
    // else: male outsider defaults (5 likes, 1 superlike)

    if (actionType === 'like') {
      if (likeLimit !== Infinity) {
        const likeKey = `user:${fromUserId}:likes`;
        const currentLikes = await redis.incr(likeKey);
        if (currentLikes === 1) {
          await redis.expire(likeKey, secondsToMidnight);
        }
        if (currentLikes > likeLimit) {
          return res.status(429).json({ error: 'Daily likes quota exceeded' });
        }
      }
    } else if (actionType === 'superlike') {
      const superlikeKey = `user:${fromUserId}:superlikes`;
      const currentSuperlikes = await redis.incr(superlikeKey);
      if (currentSuperlikes === 1) {
        await redis.expire(superlikeKey, secondsToMidnight);
      }
      if (currentSuperlikes > superlikeLimit) {
        return res.status(429).json({ error: 'Daily superlikes quota exceeded' });
      }
    }

    // D. Velocity Check (sorted set of timestamps — flag bot-like pacing)
    const nowMs = Date.now();
    const velocityKey = `user:${fromUserId}:like_velocity`;
    await redis.zAdd(velocityKey, nowMs, String(nowMs));
    await redis.zRemRangeByScore(velocityKey, 0, nowMs - 10000); // 10s window
    const recentLikesCount = await redis.zCount(velocityKey, nowMs - 10000, nowMs);

    if (recentLikesCount > 5) {
      const flag = new AccountFlag({
        userId: fromUserId,
        flagType: 'like_velocity_spike',
        severity: 'low',
        details: { count: recentLikesCount, action: actionType },
        status: 'open'
      });
      await flag.save();
      await User.findByIdAndUpdate(fromUserId, { $inc: { openFlagCount: 1 } });
    }

    // E. Save Like document (upsert — one like per pair)
    await Like.findOneAndUpdate(
      { fromUserId, toUserId },
      { type: actionType, createdAt: new Date() },
      { upsert: true }
    );

    // F. Mutual Match Detection
    const mutualLike = await Like.findOne({ fromUserId: toUserId, toUserId: fromUserId });
    let matchFormed = false;
    let conversationId = null;

    if (mutualLike) {
      matchFormed = true;
      conversationId = `conv_${[fromUserId.toString(), toUserId.toString()].sort().join('_')}`;

      // Create match document (pre-save middleware sorts userA/userB)
      try {
        const match = new Match({ userA: fromUserId, userB: toUserId, conversationId });
        await match.save();
      } catch (e) {
        if (e.code !== 11000) throw e; // ignore duplicate match
      }
    }

    res.json({ success: true, matchFormed, conversationId });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ success: true, matchFormed: false, note: 'Already liked' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error during like action' });
  }
}

// POST /api/like/:targetId
router.post('/like/:targetId', authRequired, (req, res) => handleLikeAction(req, res, 'like'));

// POST /api/superlike/:targetId
router.post('/superlike/:targetId', authRequired, (req, res) => handleLikeAction(req, res, 'superlike'));

// ------------------------------------------------------------------
// 4. MATCHES LIST
// ------------------------------------------------------------------
// GET /api/matches
router.get('/matches', authRequired, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    // Get all block relationships for this user
    const blocks = await Block.find({
      $or: [{ blockerId: userId }, { blockedId: userId }]
    });
    const blockedSet = new Set(blocks.map(b =>
      b.blockerId.equals(userId) ? b.blockedId.toString() : b.blockerId.toString()
    ));

    const matches = await Match.find({
      $or: [{ userA: userId }, { userB: userId }]
    }).sort({ matchedAt: -1 });

    const populatedMatches = await Promise.all(matches.map(async (m) => {
      const partnerId = m.userA.equals(userId) ? m.userB : m.userA;

      // M-5 fix: skip matches where a post-match block exists
      if (blockedSet.has(partnerId.toString())) return null;

      const partner = await User.findById(partnerId)
        .select('name age school course gender pictures bio badges identityStatus');
      if (!partner) return null;

      // Fetch presence online status from Redis
      const isOnline = await redis.get(`presence:${partnerId.toString()}`);

      return {
        id: m._id,
        matchedAt: m.matchedAt,
        conversationId: m.conversationId,
        partner: {
          ...partner.toObject(),
          isOnline: !!isOnline
        }
      };
    }));

    res.json({ matches: populatedMatches.filter(Boolean) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching matches' });
  }
});

// ------------------------------------------------------------------
// 5. BLOCKING
// ------------------------------------------------------------------
// POST /api/block/:targetId
router.post('/block/:targetId', authRequired, async (req, res) => {
  try {
    const blockerId = new mongoose.Types.ObjectId(req.user.id);
    const blockedId = new mongoose.Types.ObjectId(req.params.targetId);

    if (blockerId.equals(blockedId)) {
      return res.status(400).json({ error: 'You cannot block yourself' });
    }

    await Block.findOneAndUpdate(
      { blockerId, blockedId },
      { createdAt: new Date() },
      { upsert: true }
    );

    // Mass Block Target Flagging (medium severity)
    const blockCountKey = `block_count:${blockedId}`;
    const recentBlocks = await redis.incr(blockCountKey);
    if (recentBlocks === 1) {
      await redis.expire(blockCountKey, 3600); // 1 hour window
    }

    if (recentBlocks > 10) {
      const flag = new AccountFlag({
        userId: blockedId,
        flagType: 'mass_block_target',
        severity: 'medium',
        details: { blockCount: recentBlocks },
        status: 'open'
      });
      await flag.save();
      await User.findByIdAndUpdate(blockedId, { $inc: { openFlagCount: 1 } });
    }

    res.json({ message: 'User blocked successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during block' });
  }
});

// DELETE /api/block/:targetId
router.delete('/block/:targetId', authRequired, async (req, res) => {
  try {
    const blockerId = new mongoose.Types.ObjectId(req.user.id);
    const blockedId = new mongoose.Types.ObjectId(req.params.targetId);

    await Block.deleteOne({ blockerId, blockedId });
    res.json({ message: 'User unblocked successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during unblock' });
  }
});

// ------------------------------------------------------------------
// 6. REPORTING
// ------------------------------------------------------------------
// POST /api/report
router.post('/report', authRequired, async (req, res) => {
  try {
    const reporterId = new mongoose.Types.ObjectId(req.user.id);
    const { targetUserId, targetPostId, reason } = req.body;

    if (!reason || !validateStringLength(reason, 1000)) {
      return res.status(400).json({ error: 'Reason is required (max 1000 chars)' });
    }

    if (!targetUserId && !targetPostId) {
      return res.status(400).json({ error: 'Either targetUserId or targetPostId is required' });
    }

    const report = new Report({
      reporterId,
      targetUserId: targetUserId ? new mongoose.Types.ObjectId(targetUserId) : undefined,
      targetPostId: targetPostId ? new mongoose.Types.ObjectId(targetPostId) : undefined,
      reason: reason.trim(),
      status: 'open'
    });
    await report.save();

    // Mass Report Target Flagging (high severity)
    if (targetUserId) {
      const reportCountKey = `report_count:${targetUserId}`;
      const recentReports = await redis.incr(reportCountKey);
      if (recentReports === 1) {
        await redis.expire(reportCountKey, 3600); // 1 hour window
      }

      if (recentReports > 5) {
        const flag = new AccountFlag({
          userId: new mongoose.Types.ObjectId(targetUserId),
          flagType: 'mass_report_target',
          severity: 'high',
          details: { reportCount: recentReports },
          status: 'open'
        });
        await flag.save();
        await User.findByIdAndUpdate(targetUserId, { $inc: { openFlagCount: 1 } });
      }
    }

    res.status(201).json({ message: 'Report submitted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error submitting report' });
  }
});

// ------------------------------------------------------------------
// 7. ANONYMOUS POSTS
// ------------------------------------------------------------------
const POST_SPAM_THRESHOLD = 5;
const POST_SPAM_WINDOW_SECONDS = 3600; // 1 hour
const POST_MAX_CONTENT_LENGTH = 1000;

// POST /api/posts
router.post('/posts', authRequired, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'Post content is required' });
    }
    if (!validateStringLength(content, POST_MAX_CONTENT_LENGTH)) {
      return res.status(400).json({ error: `Post content too long (max ${POST_MAX_CONTENT_LENGTH} chars)` });
    }

    const post = new AnonymousPost({ content: content.trim() });
    await post.save();

    // Post spam flagging
    const spamKey = `post_spam:${req.user.id}`;
    const postCount = await redis.incr(spamKey);
    if (postCount === 1) {
      await redis.expire(spamKey, POST_SPAM_WINDOW_SECONDS);
    }
    if (postCount > POST_SPAM_THRESHOLD) {
      const flag = new AccountFlag({
        userId: new mongoose.Types.ObjectId(req.user.id),
        flagType: 'post_spam',
        severity: 'low',
        details: { postCount, windowSeconds: POST_SPAM_WINDOW_SECONDS },
        status: 'open'
      });
      await flag.save();
      await User.findByIdAndUpdate(req.user.id, { $inc: { openFlagCount: 1 } });
    }

    res.status(201).json({ message: 'Post created successfully', post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating post' });
  }
});

// GET /api/posts
router.get('/posts', authRequired, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const posts = await AnonymousPost.find()
      .sort({ postedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await AnonymousPost.countDocuments();

    res.json({ posts, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching posts' });
  }
});

// ------------------------------------------------------------------
// 8. FEEDBACK
// ------------------------------------------------------------------
// POST /api/feedback
router.post('/feedback', authRequired, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !validateStringLength(content, 2000)) {
      return res.status(400).json({ error: 'Feedback content is required (max 2000 chars)' });
    }

    const feedback = new Feedback({
      userId: new mongoose.Types.ObjectId(req.user.id),
      content: content.trim()
    });
    await feedback.save();

    res.status(201).json({ message: 'Feedback submitted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error submitting feedback' });
  }
});

// GET /api/conversations/:conversationId/messages (Chat History)
router.get('/conversations/:conversationId/messages', authRequired, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    // Security check: ensure requesting user is part of this match
    const match = await Match.findOne({ conversationId });
    if (!match) {
      return res.status(404).json({ error: 'Conversation not found or not matched' });
    }

    if (match.userA.toString() !== userId && match.userB.toString() !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const Message = require('../models/Message');
    const [messages, total] = await Promise.all([
      Message.find({ conversationId })
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit),
      Message.countDocuments({ conversationId })
    ]);

    res.json({ messages, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching messages' });
  }
});

// GET /api/announcements (Announcements list for regular users)
router.get('/announcements', authRequired, async (req, res) => {
  try {
    const Announcement = require('../models/Announcement');
    const announcements = await Announcement.find({})
      .sort({ createdAt: -1 })
      .limit(10);
    res.json({ announcements });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching announcements' });
  }
});

// POST /api/waitlist (Public waitlist sign-up)
router.post('/waitlist', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (name && !validateStringLength(name, 100)) {
      return res.status(400).json({ error: 'Name is too long (max 100 chars)' });
    }

    const cleanEmail = email.trim().toLowerCase();

    const Waitlist = require('../models/Waitlist');
    const existing = await Waitlist.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(400).json({ error: 'Email is already on the waitlist' });
    }

    const entry = new Waitlist({
      email: cleanEmail,
      name: name ? name.trim() : undefined
    });
    await entry.save();

    res.status(201).json({ message: 'Successfully joined the waitlist!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error joining waitlist' });
  }
});

module.exports = router;
