const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const User = require('../models/User');
const Like = require('../models/Like');
const Dislike = require('../models/Dislike');
const Match = require('../models/Match');
const Block = require('../models/Block');
const Report = require('../models/Report');
const AccountFlag = require('../models/AccountFlag');
const AnonymousPost = require('../models/AnonymousPost');
const Feedback = require('../models/Feedback');
const redis = require('../utils/redis');
const { authRequired } = require('../middleware/auth');
const { getOrInitOnboardingConfig, formatUserInterests, formatUserPrompts } = require('../utils/onboardingConfig');
const emailService = require('../utils/emailService');
const admin = require('../utils/firebase');

// Pre-load dynamic ESM file-type module at startup scope to avoid per-request resolution overhead
const fileTypePromise = import('file-type').then(m => m.default || m).catch(() => null);

// GET /api/config/onboarding (Fetch onboarding interests segments and prompt sections for frontend UI)
router.get('/config/onboarding', async (req, res) => {
  try {
    const config = await getOrInitOnboardingConfig();
    res.json({
      segments: config.segments,
      sections: config.sections
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching onboarding options' });
  }
});

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

const multer = require('multer');
const { uploadProfilePicture } = require('../utils/uploader');

// Memory storage for multer profile picture upload — with strict MIME type validation (2MB max to preserve RAM)
const uploadPicture = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, WEBP, and GIF images are allowed.'));
    }
  }
});

// Multer error handler middleware helper
function handleMulterError(err, req, res, next) {
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
}

// ------------------------------------------------------------------
// 1. OWN PROFILE
// ------------------------------------------------------------------

// POST /api/upload/picture (Upload normal profile picture, returns url and fileId)
router.post('/upload/picture', authRequired, uploadPicture.single('picture'), handleMulterError, async (req, res) => {
  try {
    const file = req.file || (req.files && req.files[0]);
    if (!file) {
      return res.status(400).json({ error: 'Please select an image file to upload (field name: "picture" or "file")' });
    }

    // Magic-byte validation: verify actual file content matches claimed MIME type
    // Prevents MIME spoofing (uploading .exe/.php with Content-Type: image/jpeg)
    const ft = await fileTypePromise;
    const detected = ft ? await ft.fromBuffer(file.buffer) : null;
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!detected || !allowedMimeTypes.includes(detected.mime)) {
      return res.status(400).json({ error: 'Invalid file content. Only real JPEG, PNG, WEBP, or GIF images are allowed.' });
    }

    const picture = await uploadProfilePicture(file);

    // Optional: auto-append to user profile pictures array if requested
    if (req.body && (req.body.autoSave === 'true' || req.body.autoSave === true)) {
      const user = await User.findById(req.user.id);
      if (user) {
        if (user.pictures.length >= 4) {
          return res.status(400).json({ error: 'User already has maximum 4 pictures. Update profile array directly.', picture });
        }
        user.pictures.push(picture);
        await user.save();
        await redis.del(`discover:${req.user.id}`, `user:profile:${req.user.id}`).catch(() => {});
      }
    }

    res.status(201).json({
      message: 'Picture uploaded successfully',
      picture: {
        url: picture.url,
        fileId: picture.fileId
      }
    });
  } catch (err) {
    console.error('[PICTURE UPLOAD ERROR]:', err);
    res.status(500).json({ error: 'Server error uploading profile picture' });
  }
});

// GET /api/users/me
router.get('/users/me', authRequired, async (req, res) => {
  try {
    const cacheKey = `user:profile:${req.user.id}`;
    const cachedProfile = await redis.get(cacheKey).catch(() => null);
    if (cachedProfile) {
      try {
        const parsed = typeof cachedProfile === 'string' ? JSON.parse(cachedProfile) : cachedProfile;
        return res.json({ user: parsed });
      } catch (e) {
        // Fallback to DB fetch if parse fails
      }
    }

    const user = await User.findById(req.user.id).select('-passwordHash').lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await redis.set(cacheKey, JSON.stringify(user), { EX: 300 }).catch(() => {});
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

// PUT /api/users/me
router.put('/users/me', authRequired, async (req, res) => {
  try {
    const { username, name, age, bio, school, course, height, hobbies, skills, lookingFor, sexualOrientation, tags, pictures, interests, prompts, religion, beliefs, customDesignId } = req.body;

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
    if (religion !== undefined && !validateStringLength(religion, 100)) {
      return res.status(400).json({ error: 'Religion too long (max 100 chars)' });
    }
    if (beliefs !== undefined && !validateStringLength(beliefs, 200)) {
      return res.status(400).json({ error: 'Beliefs too long (max 200 chars)' });
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
    if (interests !== undefined && !Array.isArray(interests)) {
      return res.status(400).json({ error: 'Interests must be an array' });
    }
    if (prompts !== undefined && !Array.isArray(prompts)) {
      return res.status(400).json({ error: 'Prompts must be an array' });
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
    if (religion !== undefined) allowedUpdates.religion = religion.trim();
    if (beliefs !== undefined) allowedUpdates.beliefs = beliefs.trim();
    if (school !== undefined) allowedUpdates.school = school.trim();
    if (course !== undefined) allowedUpdates.course = course.trim();
    if (height !== undefined && typeof height === 'number') allowedUpdates.height = height;
    if (hobbies !== undefined) allowedUpdates.hobbies = hobbies.map(h => String(h).trim()).filter(Boolean);
    if (skills !== undefined) allowedUpdates.skills = skills.map(s => String(s).trim()).filter(Boolean);
    if (lookingFor !== undefined && ['friends', 'dating'].includes(lookingFor)) allowedUpdates.lookingFor = lookingFor;
    if (sexualOrientation !== undefined && validateStringLength(sexualOrientation, 50)) allowedUpdates.sexualOrientation = sexualOrientation;
    if (tags !== undefined && typeof tags === 'object' && !Array.isArray(tags)) allowedUpdates.tags = tags;
    if (pictures !== undefined) allowedUpdates.pictures = pictures;

    if (customDesignId !== undefined) {
      const existingUser = await User.findById(req.user.id).lean();
      const now = new Date();
      const isGoldActive = existingUser && existingUser.tier === 'gold' && (!existingUser.subscriptionExpiresAt || new Date(existingUser.subscriptionExpiresAt) > now);

      if (customDesignId !== null && customDesignId !== '') {
        if (!isGoldActive) {
          return res.status(403).json({ error: 'Custom profile designs are exclusive to active Gold Pass subscribers' });
        }
        allowedUpdates.customDesignId = String(customDesignId).trim();
      } else {
        allowedUpdates.customDesignId = null;
      }
    }

    if (interests !== undefined || prompts !== undefined) {
      const config = await getOrInitOnboardingConfig();
      if (interests !== undefined) {
        allowedUpdates.interests = formatUserInterests(interests, config);
      }
      if (prompts !== undefined) {
        allowedUpdates.prompts = formatUserPrompts(prompts, config);
      }
    }

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

    // Invalidate discovery & profile caches for this user
    await redis.del(`discover:${req.user.id}`, `user:profile:${req.user.id}`).catch(() => {});

    res.json({ message: 'Profile updated successfully', user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating profile' });
  }
});

// PUT /api/users/me/design (Claim or set custom profile design theme ID — Gold Pass Exclusive)
router.put('/users/me/design', authRequired, async (req, res) => {
  try {
    const { customDesignId } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const now = new Date();
    const isGoldActive = user.tier === 'gold' && (!user.subscriptionExpiresAt || new Date(user.subscriptionExpiresAt) > now);

    if (customDesignId !== null && customDesignId !== '' && customDesignId !== undefined) {
      if (!isGoldActive) {
        return res.status(403).json({ error: 'Custom profile designs are exclusive to active Gold Pass subscribers' });
      }
      if (typeof customDesignId !== 'string' || customDesignId.trim().length > 100) {
        return res.status(400).json({ error: 'customDesignId must be a valid string (max 100 chars)' });
      }
      user.customDesignId = customDesignId.trim();
    } else {
      user.customDesignId = null;
    }

    await user.save();
    await redis.del(`discover:${req.user.id}`, `user:profile:${req.user.id}`).catch(() => {});

    res.json({
      message: user.customDesignId ? 'Custom profile design set successfully' : 'Custom design reset to default',
      customDesignId: user.customDesignId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating custom design' });
  }
});

// ------------------------------------------------------------------
// 2. DISCOVERY FEED
// ------------------------------------------------------------------
const DISCOVER_CACHE_TTL = 300; // 5 minutes — balances freshness vs DB load

// GET /api/discover
router.get('/discover', authRequired, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    // --- Cache read: try to serve ranked candidates from Redis before DB ---
    const cacheKey = `discover:${req.user.id}`;
    let scoredProfiles = null;

    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        scoredProfiles = JSON.parse(cached);
      } catch (_) {
        scoredProfiles = null; // corrupt cache — fall through to DB
      }
    }

    if (!scoredProfiles) {
      // A-C: Fetch blocks, likes/dislikes (capped to recent 500), matches in parallel — 1 round-trip instead of 4
      const [blocks, sentLikes, sentDislikes, matches] = await Promise.all([
        Block.find({ $or: [{ blockerId: userId }, { blockedId: userId }] }).lean(),
        Like.find({ fromUserId: userId }).select('toUserId').sort({ _id: -1 }).limit(500).lean(),
        Dislike.find({ fromUserId: userId }).select('toUserId').sort({ _id: -1 }).limit(500).lean(),
        Match.find({ $or: [{ userA: userId }, { userB: userId }] }).lean()
      ]);

      const blockedUserIds = blocks.map(b => String(b.blockerId) === String(userId) ? b.blockedId : b.blockerId);
      const likedUserIds = sentLikes.map(l => l.toUserId);
      const dislikedUserIds = sentDislikes.map(d => d.toUserId);
      const matchedUserIds = matches.map(m => String(m.userA) === String(userId) ? m.userB : m.userA);

      // D. Build complete exclusion list (Self, Blocked, recent Liked/Disliked up to 1000, Matched)
      const excludedIds = [
        userId,
        ...blockedUserIds,
        ...likedUserIds.slice(-1000),
        ...dislikedUserIds.slice(-1000),
        ...matchedUserIds
      ];

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

      // .lean() = plain JS objects, ~70% less RAM than Mongoose docs
      // .limit(200) = safety cap: with 700 users we never need to load all into RAM
      const candidateProfiles = await User.find(query)
        .select('name age height school course gender pictures bio hobbies skills lookingFor sexualOrientation identityStatus badges tier subscriptionExpiresAt religion beliefs customDesignId')
        .sort({ _id: -1 })
        .limit(200)
        .lean();

      // F. Probability-based Feed Algorithm with 6x/3x/1x Profile Boost
      const now = new Date();
      scoredProfiles = candidateProfiles.map(p => {
        const isSubActive = p.tier && p.tier !== 'free' && (!p.subscriptionExpiresAt || new Date(p.subscriptionExpiresAt) > now);
        const activeTier = isSubActive ? p.tier : 'free';

        // Boost multiplier: Gold = 6x, Silver = 3x, Free = 1x
        const boostMultiplier = activeTier === 'gold' ? 6 : (activeTier === 'silver' ? 3 : 1);
        const weightedScore = (boostMultiplier * 1000) + Math.floor(Math.random() * 500);

        const doc = { ...p };
        doc.customDesignId = activeTier === 'gold' ? (p.customDesignId || null) : null;
        delete doc.subscriptionExpiresAt;
        return { profile: doc, score: weightedScore };
      });

      // Sort by weighted rank score descending
      scoredProfiles.sort((a, b) => b.score - a.score);

      // --- Cache write: store sorted list for 5 minutes ---
      await redis.set(cacheKey, JSON.stringify(scoredProfiles), { EX: DISCOVER_CACHE_TTL });
    }

    // Apply pagination slice
    const paginatedProfiles = scoredProfiles.slice(skip, skip + limit).map(item => item.profile);

    res.json({ profiles: paginatedProfiles, page, limit, total: scoredProfiles.length });
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
    if (!mongoose.Types.ObjectId.isValid(req.params.targetId)) {
      return res.status(400).json({ error: 'Invalid target user ID format' });
    }

    const fromUserId = new mongoose.Types.ObjectId(req.user.id);
    const toUserId = new mongoose.Types.ObjectId(req.params.targetId);

    if (fromUserId.equals(toUserId)) {
      return res.status(400).json({ error: 'You cannot like yourself' });
    }

    // A. Fetch both users in parallel — saves one DB round-trip on the hottest path
    const [target, user] = await Promise.all([
      User.findById(toUserId),
      User.findById(fromUserId)
    ]);

    if (!target || target.banned) {
      return res.status(404).json({ error: 'Target user not found or is banned' });
    }
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

    // C. Quota enforcement via Tier Subscription & Redis
    const secondsToMidnight = getSecondsToUTCMidnight();
    const now = new Date();
    
    // Determine active subscription tier
    const isSubActive = user.tier && user.tier !== 'free' && (!user.subscriptionExpiresAt || new Date(user.subscriptionExpiresAt) > now);
    const activeTier = isSubActive ? user.tier : 'free';

    let likeLimit = 15;
    let superlikeLimit = 3;

    if (activeTier === 'gold') {
      likeLimit = 50;
      superlikeLimit = 12;
    } else if (activeTier === 'silver') {
      likeLimit = 25;
      superlikeLimit = 6;
    } else {
      likeLimit = 15;
      superlikeLimit = 3;
    }

    if (actionType === 'like') {
      const likeKey = `user:${fromUserId}:likes`;
      const currentLikes = await redis.incr(likeKey);
      if (currentLikes === 1) {
        await redis.expire(likeKey, secondsToMidnight);
      }
      if (currentLikes > likeLimit) {
        return res.status(429).json({ error: `Daily likes quota exceeded for ${activeTier.toUpperCase()} tier (${likeLimit} likes/day max). Upgrade to get more!` });
      }
    } else if (actionType === 'superlike') {
      const superlikeKey = `user:${fromUserId}:superlikes`;
      const currentSuperlikes = await redis.incr(superlikeKey);
      if (currentSuperlikes === 1) {
        await redis.expire(superlikeKey, secondsToMidnight);
      }
      if (currentSuperlikes > superlikeLimit) {
        return res.status(429).json({ error: `Daily superlikes quota exceeded for ${activeTier.toUpperCase()} tier (${superlikeLimit} superlikes/day max). Upgrade to get more!` });
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

    // E. Save/upsert own Like document first
    await Like.findOneAndUpdate(
      { fromUserId, toUserId },
      { type: actionType, createdAt: new Date() },
      { upsert: true, setDefaultsOnInsert: true }
    );

    // F. Check for mutual like AFTER upserting own like
    // Ensures concurrent right-swipes from both users reliably detect the mutual match
    const mutualLike = await Like.findOne({ fromUserId: toUserId, toUserId: fromUserId }).lean();

    // G. Mutual Match Formation
    let matchFormed = false;
    let conversationId = null;

    if (mutualLike) {
      matchFormed = true;
      const uAStr = fromUserId.toString();
      const uBStr = toUserId.toString();
      const normUserA = uAStr < uBStr ? fromUserId : toUserId;
      const normUserB = uAStr < uBStr ? toUserId : fromUserId;

      // conversationId is deterministic — always the same regardless of who liked first
      conversationId = `conv_${[uAStr, uBStr].sort().join('_')}`;

      // Upsert match (idempotent — safe to call even if match already exists)
      const existingOrNewMatch = await Match.findOneAndUpdate(
        { userA: normUserA, userB: normUserB },
        {
          $setOnInsert: {
            userA: normUserA,
            userB: normUserB,
            conversationId,
            matchedAt: new Date()
          }
        },
        { upsert: true, new: true }
      );

      // Use the stored conversationId in case match already existed with a different one
      if (existingOrNewMatch && existingOrNewMatch.conversationId) {
        conversationId = existingOrNewMatch.conversationId;
      }

      // Invalidate both users' discovery caches — they should no longer see each other
      await Promise.all([
        redis.del(`discover:${fromUserId.toString()}`),
        redis.del(`discover:${toUserId.toString()}`)
      ]);

      console.log(`[MATCH] Mutual match formed: ${fromUserId} <-> ${toUserId} | conversation: ${conversationId}`);
    }

    // H. Broadcast real-time WebSocket notification events via Chat Service
    try {
      const chatUrl = process.env.CHAT_SERVICE_URL || 'http://localhost:5001';
      const payload = matchFormed
        ? { event: 'new_match', userA: fromUserId.toString(), userB: toUserId.toString(), conversationId, timestamp: new Date() }
        : { event: 'new_like', toUserId: toUserId.toString(), fromUserId: fromUserId.toString(), type: actionType, timestamp: new Date() };

      const targetUrl = new URL(`${chatUrl}/internal/notify`);
      const transport = targetUrl.protocol === 'https:' ? https : http;
      const dataString = JSON.stringify(payload);

      const notifReq = transport.request(targetUrl, {
        method: 'POST',
        timeout: 1500,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataString),
          'x-internal-secret': process.env.INTERNAL_NOTIFY_SECRET || 'internal-secret-change-in-production'
        }
      });
      notifReq.setTimeout(1500, () => {
        notifReq.destroy();
      });
      notifReq.on('error', (e) => console.warn('[SOCKET NOTIF DISPATCH WARN]:', e.message || e.code || 'Chat service offline/timeout'));
      notifReq.write(dataString);
      notifReq.end();

      await redis.publish('events:notifications', payload).catch(() => {});
    } catch (pubErr) {
      console.error('[NOTIF PUB ERROR]:', pubErr.message);
    }

    // I. Send Push Notification via Firebase
    if (admin.apps.length > 0) {
      try {
        if (matchFormed) {
          // Send to both users
          const tokens = [];
          if (user.fcmTokens && user.fcmTokens.length > 0) tokens.push(...user.fcmTokens);
          if (target.fcmTokens && target.fcmTokens.length > 0) tokens.push(...target.fcmTokens);
          
          if (tokens.length > 0) {
            await admin.messaging().sendEachForMulticast({
              tokens,
              notification: {
                title: 'New Match! 🎉',
                body: `You have a new match! Say hi.`
              },
              data: {
                type: 'chat',
                chatId: conversationId
              }
            });
          }
        } else {
          // Send to target only
          if (target.fcmTokens && target.fcmTokens.length > 0) {
            await admin.messaging().sendEachForMulticast({
              tokens: target.fcmTokens,
              notification: {
                title: actionType === 'superlike' ? 'New Superlike! ⭐' : 'New Like! ❤️',
                body: actionType === 'superlike' ? 'Someone Superliked you! You stand out.' : 'Someone new liked you! Swipe to find out who.'
              },
              data: {
                type: 'like'
              }
            });
          }
        }
      } catch (fcmErr) {
        console.error('[FCM ERROR]:', fcmErr);
      }
    }

    res.json({ success: true, matchFormed, conversationId });
  } catch (err) {
    // E11000 here means user submitted a duplicate like request (re-liked same profile).
    // The mutual match check was already done BEFORE the Like upsert, so this can't
    // suppress a match that should have formed — it's safe to return 'Already liked'.
    if (err.code === 11000) {
      return res.json({ success: true, matchFormed: false, note: 'Already liked' });
    }
    console.error('[LIKE ACTION ERROR]:', err);
    res.status(500).json({ error: 'Server error during like action' });
  }
}

// POST /api/dislike/:targetId & POST /api/pass/:targetId (Left swipe / pass profile)
async function handleDislikeAction(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.targetId)) {
      return res.status(400).json({ error: 'Invalid target user ID format' });
    }

    const fromUserId = new mongoose.Types.ObjectId(req.user.id);
    const toUserId = new mongoose.Types.ObjectId(req.params.targetId);

    if (fromUserId.equals(toUserId)) {
      return res.status(400).json({ error: 'You cannot pass yourself' });
    }

    // Save dislike record (upsert)
    await Dislike.findOneAndUpdate(
      { fromUserId, toUserId },
      { createdAt: new Date() },
      { upsert: true }
    );

    // Invalidate cached discovery feed
    await redis.del(`discover:${req.user.id}`);

    res.json({ success: true, message: 'Profile passed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error processing pass/dislike' });
  }
}

// GET /api/likes/received & GET /api/likes/incoming
// Returns incoming likes that other users have sent to the authenticated user.
// - Free users: returns total like count only (`hasAccess: false`, `isLocked: true`, `likers: []`).
// - Silver / Gold subscription users: returns total count AND full profiles of likers (`hasAccess: true`, `isLocked: false`, `likers: [...]`).
async function getReceivedLikes(req, res) {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    // Determine active subscription status
    const now = new Date();
    const isSubActive = user.tier && user.tier !== 'free' && (!user.subscriptionExpiresAt || new Date(user.subscriptionExpiresAt) > now);

    // 1. Get blocked user IDs (both directions)
    const blocks = await Block.find({
      $or: [{ blockerId: userId }, { blockedId: userId }]
    }).lean();
    const blockedUserIds = blocks.map(b => String(b.blockerId) === String(userId) ? b.blockedId : b.blockerId);

    // 2. Get existing matches (already matched users)
    const matches = await Match.find({
      $or: [{ userA: userId }, { userB: userId }]
    }).lean();
    const matchedUserIds = matches.map(m => String(m.userA) === String(userId) ? m.userB : m.userA);

    // Exclude blocked & already matched users
    const excludedIds = [...blockedUserIds, ...matchedUserIds];

    const filter = {
      toUserId: userId,
      fromUserId: { $nin: excludedIds }
    };

    const totalLikesCount = await Like.countDocuments(filter);

    // If free tier, return total count only — keep profiles hidden/locked
    if (!isSubActive) {
      return res.json({
        totalLikesCount,
        hasAccess: false,
        isLocked: true,
        tier: user.tier || 'free',
        message: 'Upgrade to Silver or Gold Pass to unlock and see full profiles of users who liked you!',
        likers: [],
        page,
        limit
      });
    }

    // 3. Find incoming likes sent TO this user with pagination
    const incomingLikes = await Like.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Batch-fetch all liker profiles in ONE query
    const likerIds = incomingLikes.map(l => l.fromUserId);
    const likerUsers = await User.find({ _id: { $in: likerIds }, banned: false })
      .select('name age height school course gender pictures bio hobbies skills lookingFor sexualOrientation identityStatus badges tier subscriptionExpiresAt religion beliefs customDesignId')
      .lean();
    const likerMap = Object.fromEntries(likerUsers.map(u => [u._id.toString(), u]));

    const validLikers = incomingLikes
      .map(l => {
        const profile = likerMap[l.fromUserId.toString()];
        if (!profile) return null;
        const isLikerGold = profile.tier === 'gold' && (!profile.subscriptionExpiresAt || new Date(profile.subscriptionExpiresAt) > now);
        const formattedProfile = {
          ...profile,
          customDesignId: isLikerGold ? (profile.customDesignId || null) : null
        };
        delete formattedProfile.subscriptionExpiresAt;
        return { likeId: l._id, type: l.type || 'like', likedAt: l.createdAt, profile: formattedProfile };
      })
      .filter(Boolean);

    res.json({
      totalLikesCount,
      hasAccess: true,
      isLocked: false,
      tier: user.tier,
      likers: validLikers,
      page,
      limit
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching received likes' });
  }
}

router.post('/like/:targetId', authRequired, (req, res) => handleLikeAction(req, res, 'like'));
router.post('/superlike/:targetId', authRequired, (req, res) => handleLikeAction(req, res, 'superlike'));
router.post('/dislike/:targetId', authRequired, handleDislikeAction);
router.post('/pass/:targetId', authRequired, handleDislikeAction);
router.get('/likes/received', authRequired, getReceivedLikes);
router.get('/likes/incoming', authRequired, getReceivedLikes);

// GET /api/likes/given & GET /api/likes/sent
// Returns history of all accounts liked/superliked in the past by the authenticated user.
async function getGivenLikes(req, res) {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    // 1. Get blocked user IDs (both directions)
    const blocks = await Block.find({
      $or: [{ blockerId: userId }, { blockedId: userId }]
    }).lean();
    const blockedUserIds = blocks.map(b => String(b.blockerId) === String(userId) ? b.blockedId : b.blockerId);

    // 2. Query sent likes
    const filter = {
      fromUserId: userId,
      toUserId: { $nin: blockedUserIds }
    };

    const [sentLikes, total] = await Promise.all([
      Like.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Like.countDocuments(filter)
    ]);

    // 3. Batch-fetch all target profiles in ONE query instead of N queries
    const targetIds = sentLikes.map(l => l.toUserId);
    const targetUsers = await User.find({ _id: { $in: targetIds }, banned: false })
      .select('name age height school course gender pictures bio hobbies skills lookingFor sexualOrientation identityStatus badges tier subscriptionExpiresAt religion beliefs customDesignId')
      .lean();
    const targetMap = Object.fromEntries(targetUsers.map(u => [u._id.toString(), u]));

    const now = new Date();
    const validLikes = sentLikes
      .map(l => {
        const profile = targetMap[l.toUserId.toString()];
        if (!profile) return null;
        const isTargetGold = profile.tier === 'gold' && (!profile.subscriptionExpiresAt || new Date(profile.subscriptionExpiresAt) > now);
        const formattedProfile = {
          ...profile,
          customDesignId: isTargetGold ? (profile.customDesignId || null) : null
        };
        delete formattedProfile.subscriptionExpiresAt;
        return { likeId: l._id, type: l.type || 'like', likedAt: l.createdAt, profile: formattedProfile };
      })
      .filter(Boolean);

    res.json({
      totalCount: total,
      page,
      limit,
      likes: validLikes
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching sent likes history' });
  }
}

router.get('/likes/given', authRequired, getGivenLikes);
router.get('/likes/sent', authRequired, getGivenLikes);

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
    }).lean();
    const blockedSet = new Set(blocks.map(b =>
      String(b.blockerId) === String(userId) ? b.blockedId.toString() : b.blockerId.toString()
    ));

    const matches = await Match.find({
      $or: [{ userA: userId }, { userB: userId }]
    }).sort({ matchedAt: -1 }).lean();

    // Filter out blocked partners early
    const visibleMatches = matches.filter(m => {
      const partnerId = m.userA.toString() === req.user.id ? m.userB : m.userA;
      return !blockedSet.has(partnerId.toString());
    });

    // Batch-fetch all partner profiles in ONE query
    const partnerIds = visibleMatches.map(m =>
      m.userA.toString() === req.user.id ? m.userB : m.userA
    );
    const partnerUsers = await User.find({ _id: { $in: partnerIds } })
      .select('name age school course gender pictures bio badges identityStatus tier subscriptionExpiresAt customDesignId')
      .lean();
    const partnerMap = Object.fromEntries(partnerUsers.map(u => [u._id.toString(), u]));

    // Batch-fetch all presence keys in 1 round-trip via redis.mget
    let presenceResults = [];
    if (partnerIds.length > 0) {
      const presenceKeys = partnerIds.map(id => `presence:${id.toString()}`);
      presenceResults = await redis.mget(...presenceKeys).catch(() => []);
    }
    const presenceMap = Object.fromEntries(
      partnerIds.map((id, i) => [id.toString(), !!presenceResults[i]])
    );

    const now = new Date();
    const populatedMatches = visibleMatches
      .map(m => {
        const partnerId = m.userA.toString() === req.user.id ? m.userB : m.userA;
        const partner = partnerMap[partnerId.toString()];
        if (!partner) return null;
        const isPartnerGold = partner.tier === 'gold' && (!partner.subscriptionExpiresAt || new Date(partner.subscriptionExpiresAt) > now);
        const formattedPartner = {
          ...partner,
          customDesignId: isPartnerGold ? (partner.customDesignId || null) : null
        };
        delete formattedPartner.subscriptionExpiresAt;
        return {
          id: m._id,
          matchedAt: m.matchedAt,
          conversationId: m.conversationId,
          partner: { ...formattedPartner, isOnline: presenceMap[partnerId.toString()] || false }
        };
      })
      .filter(Boolean);

    res.json({ matches: populatedMatches });
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
    if (!mongoose.Types.ObjectId.isValid(req.params.targetId)) {
      return res.status(400).json({ error: 'Invalid target user ID format' });
    }

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
    if (!mongoose.Types.ObjectId.isValid(req.params.targetId)) {
      return res.status(400).json({ error: 'Invalid target user ID format' });
    }

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
    const { targetUserId, targetPostId, reason } = req.body || {};

    if (!reason || !validateStringLength(reason, 1000)) {
      return res.status(400).json({ error: 'Reason is required (max 1000 chars)' });
    }

    if (!targetUserId && !targetPostId) {
      return res.status(400).json({ error: 'Either targetUserId or targetPostId is required' });
    }

    if (targetUserId && !mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ error: 'Invalid targetUserId format' });
    }

    if (targetPostId && !mongoose.Types.ObjectId.isValid(targetPostId)) {
      return res.status(400).json({ error: 'Invalid targetPostId format' });
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
// 7. ANONYMOUS POSTS & FEED (with Tier Limits, Anonymity Toggle, Upvotes/Downvotes)
// ------------------------------------------------------------------
const POST_SPAM_THRESHOLD = 5;
const POST_SPAM_WINDOW_SECONDS = 60;
const TIER_ANONYMOUS_POST_LIMITS = { free: 1, silver: 3, gold: 6 };
const TIER_POST_WORD_LIMITS = { free: 250, silver: 400, gold: 900 };

function countWords(str) {
  if (!str || typeof str !== 'string') return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

// POST /api/posts (Publish message with tier quota, word limit check, and anonymity toggle)
router.post('/posts', authRequired, async (req, res) => {
  const lockKey = `post_lock:${req.user.id}`;
  let lockAcquired = false;
  try {
    const lockResult = await redis.set(lockKey, '1', { EX: 5, NX: true });
    if (!lockResult) {
      return res.status(429).json({ error: 'A post creation is already in progress. Please try again in a moment.' });
    }
    lockAcquired = true;

    const userId = new mongoose.Types.ObjectId(req.user.id);
    const user = await User.findById(userId).lean();
    if (!user || user.banned) {
      return res.status(403).json({ error: 'Account suspended or not found' });
    }

    // 1. Calculate active tier (Free = 1 post/24h, Silver = 3 posts/24h, Gold = 6 posts/24h)
    const now = new Date();
    const isSubActive = user.tier && user.tier !== 'free' && (!user.subscriptionExpiresAt || new Date(user.subscriptionExpiresAt) > now);
    const activeTier = isSubActive ? user.tier : 'free';
    const dailyLimit = TIER_ANONYMOUS_POST_LIMITS[activeTier] || 1;
    const wordLimit = TIER_POST_WORD_LIMITS[activeTier] || 250;

    // 2. Check posts published in rolling 24-hour window
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentPostsCount = await AnonymousPost.countDocuments({
      userId,
      createdAt: { $gte: twentyFourHoursAgo }
    });

    if (recentPostsCount >= dailyLimit) {
      return res.status(429).json({
        error: `Daily limit reached (${dailyLimit} post${dailyLimit > 1 ? 's' : ''}/24h for ${activeTier.toUpperCase()} tier). Upgrade your plan or try again in 24 hours.`,
        tier: activeTier,
        dailyLimit,
        used: recentPostsCount
      });
    }

    // 3. Input validation & Tier Word Limit check
    const { content, isAnonymous } = req.body;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'Post content is required' });
    }

    const words = countWords(content);
    if (words > wordLimit) {
      return res.status(400).json({
        error: `Post exceeds the ${wordLimit}-word limit for your ${activeTier.toUpperCase()} tier (your post has ${words} words).`,
        tier: activeTier,
        wordLimit,
        wordCount: words
      });
    }

    const postIsAnonymous = isAnonymous === false || isAnonymous === 'false' ? false : true;

    // 4. Save post
    const post = new AnonymousPost({
      userId,
      content: content.trim(),
      isAnonymous: postIsAnonymous,
      upvotes: [],
      downvotes: [],
      upvotesCount: 0,
      downvotesCount: 0,
      createdAt: new Date()
    });
    await post.save();

    // 5. Post spam flagging
    const spamKey = `post_spam:${req.user.id}`;
    const postCount = await redis.incr(spamKey);
    if (postCount === 1) {
      await redis.expire(spamKey, POST_SPAM_WINDOW_SECONDS);
    }
    if (postCount > POST_SPAM_THRESHOLD) {
      const flag = new AccountFlag({
        userId,
        flagType: 'post_spam',
        severity: 'low',
        details: { postCount, windowSeconds: POST_SPAM_WINDOW_SECONDS },
        status: 'open'
      });
      await flag.save();
      await User.findByIdAndUpdate(userId, { $inc: { openFlagCount: 1 } });
    }

    res.status(201).json({
      message: 'Post published successfully',
      post: {
        id: post._id,
        content: post.content,
        isAnonymous: post.isAnonymous,
        author: post.isAnonymous ? null : {
          id: user._id,
          name: user.name,
          username: user.username,
          pictures: user.pictures,
          tier: user.tier,
          customDesignId: activeTier === 'gold' ? (user.customDesignId || null) : null
        },
        upvotesCount: 0,
        downvotesCount: 0,
        createdAt: post.createdAt
      },
      tier: activeTier,
      remainingPosts: dailyLimit - (recentPostsCount + 1),
      wordCount: words,
      wordLimit
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating post' });
  } finally {
    if (lockAcquired) {
      await redis.del(lockKey).catch(() => {});
    }
  }
});

// GET /api/posts (Fetch anonymous feed with upvote/downvote counts, user vote status, and optional author identity)
router.get('/posts', authRequired, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const filter = { createdAt: { $gte: twentyFourHoursAgo } };
    const currentUserId = new mongoose.Types.ObjectId(req.user.id);

    const [posts, total] = await Promise.all([
      AnonymousPost.find(filter, {
        content: 1,
        isAnonymous: 1,
        userId: 1,
        upvotesCount: 1,
        downvotesCount: 1,
        createdAt: 1,
        upvotes: { $elemMatch: { $eq: currentUserId } },
        downvotes: { $elemMatch: { $eq: currentUserId } }
      })
        .populate('userId', 'name username pictures gender school course identityStatus badges tier subscriptionExpiresAt customDesignId')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AnonymousPost.countDocuments(filter)
    ]);

    const now = new Date();
    const formattedPosts = posts.map(p => {
      const isAnon = p.isAnonymous !== false;
      const hasUpvoted = Array.isArray(p.upvotes) && p.upvotes.length > 0;
      const hasDownvoted = Array.isArray(p.downvotes) && p.downvotes.length > 0;

      let userVote = null;
      if (hasUpvoted) userVote = 'upvote';
      else if (hasDownvoted) userVote = 'downvote';

      const isAuthorGold = p.userId && p.userId.tier === 'gold' && (!p.userId.subscriptionExpiresAt || new Date(p.userId.subscriptionExpiresAt) > now);

      const authorObj = (!isAnon && p.userId) ? {
        id: p.userId._id,
        name: p.userId.name,
        username: p.userId.username,
        pictures: p.userId.pictures,
        gender: p.userId.gender,
        school: p.userId.school,
        course: p.userId.course,
        identityStatus: p.userId.identityStatus,
        badges: p.userId.badges,
        tier: p.userId.tier,
        customDesignId: isAuthorGold ? (p.userId.customDesignId || null) : null
      } : null;

      return {
        id: p._id,
        content: p.content,
        isAnonymous: isAnon,
        author: authorObj,
        upvotesCount: p.upvotesCount || 0,
        downvotesCount: p.downvotesCount || 0,
        userVote,
        createdAt: p.createdAt
      };
    });

    res.json({ posts: formattedPosts, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching posts' });
  }
});

// POST /api/posts/:postId/upvote (Toggle / set upvote on a post atomically)
router.post('/posts/:postId/upvote', authRequired, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.postId)) {
      return res.status(400).json({ error: 'Invalid post ID format' });
    }
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const postId = new mongoose.Types.ObjectId(req.params.postId);

    // Case 1: Toggle off existing upvote
    let post = await AnonymousPost.findOneAndUpdate(
      { _id: postId, upvotes: userId },
      { $pull: { upvotes: userId }, $inc: { upvotesCount: -1 } },
      { new: true }
    );

    if (post) {
      return res.json({
        message: 'Removed vote',
        userVote: null,
        upvotesCount: Math.max(0, post.upvotesCount),
        downvotesCount: Math.max(0, post.downvotesCount)
      });
    }

    // Case 2: Switch downvote to upvote
    post = await AnonymousPost.findOneAndUpdate(
      { _id: postId, downvotes: userId },
      { $pull: { downvotes: userId }, $addToSet: { upvotes: userId }, $inc: { upvotesCount: 1, downvotesCount: -1 } },
      { new: true }
    );

    if (post) {
      if (admin.apps.length > 0 && post.userId.toString() !== userId.toString()) {
        const author = await User.findById(post.userId);
        if (author && author.fcmTokens && author.fcmTokens.length > 0) {
          admin.messaging().sendEachForMulticast({
            tokens: author.fcmTokens,
            notification: { title: 'New Upvote! 👍', body: 'Someone upvoted your anonymous post.' }
          }).catch(e => console.error('[FCM] Upvote push error:', e));
        }
      }
      return res.json({
        message: 'Upvoted post',
        userVote: 'upvote',
        upvotesCount: Math.max(0, post.upvotesCount),
        downvotesCount: Math.max(0, post.downvotesCount)
      });
    }

    // Case 3: Add new upvote
    post = await AnonymousPost.findOneAndUpdate(
      { _id: postId, upvotes: { $ne: userId }, downvotes: { $ne: userId } },
      { $addToSet: { upvotes: userId }, $inc: { upvotesCount: 1 } },
      { new: true }
    );

    if (post) {
      if (admin.apps.length > 0 && post.userId.toString() !== userId.toString()) {
        const author = await User.findById(post.userId);
        if (author && author.fcmTokens && author.fcmTokens.length > 0) {
          admin.messaging().sendEachForMulticast({
            tokens: author.fcmTokens,
            notification: { title: 'New Upvote! 👍', body: 'Someone upvoted your anonymous post.' }
          }).catch(e => console.error('[FCM] Upvote push error:', e));
        }
      }
      return res.json({
        message: 'Upvoted post',
        userVote: 'upvote',
        upvotesCount: Math.max(0, post.upvotesCount),
        downvotesCount: Math.max(0, post.downvotesCount)
      });
    }

    const existingPost = await AnonymousPost.findById(postId);
    if (!existingPost) {
      return res.status(404).json({ error: 'Post not found or has expired' });
    }

    res.json({
      message: 'Upvoted post',
      userVote: 'upvote',
      upvotesCount: Math.max(0, existingPost.upvotesCount),
      downvotesCount: Math.max(0, existingPost.downvotesCount)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating upvote' });
  }
});

// POST /api/posts/:postId/downvote (Toggle / set downvote on a post atomically)
router.post('/posts/:postId/downvote', authRequired, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.postId)) {
      return res.status(400).json({ error: 'Invalid post ID format' });
    }
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const postId = new mongoose.Types.ObjectId(req.params.postId);

    // Case 1: Toggle off existing downvote
    let post = await AnonymousPost.findOneAndUpdate(
      { _id: postId, downvotes: userId },
      { $pull: { downvotes: userId }, $inc: { downvotesCount: -1 } },
      { new: true }
    );

    if (post) {
      return res.json({
        message: 'Removed vote',
        userVote: null,
        upvotesCount: Math.max(0, post.upvotesCount),
        downvotesCount: Math.max(0, post.downvotesCount)
      });
    }

    // Case 2: Switch upvote to downvote
    post = await AnonymousPost.findOneAndUpdate(
      { _id: postId, upvotes: userId },
      { $pull: { upvotes: userId }, $addToSet: { downvotes: userId }, $inc: { upvotesCount: -1, downvotesCount: 1 } },
      { new: true }
    );

    if (post) {
      return res.json({
        message: 'Downvoted post',
        userVote: 'downvote',
        upvotesCount: Math.max(0, post.upvotesCount),
        downvotesCount: Math.max(0, post.downvotesCount)
      });
    }

    // Case 3: Add new downvote
    post = await AnonymousPost.findOneAndUpdate(
      { _id: postId, upvotes: { $ne: userId }, downvotes: { $ne: userId } },
      { $addToSet: { downvotes: userId }, $inc: { downvotesCount: 1 } },
      { new: true }
    );

    if (post) {
      return res.json({
        message: 'Downvoted post',
        userVote: 'downvote',
        upvotesCount: Math.max(0, post.upvotesCount),
        downvotesCount: Math.max(0, post.downvotesCount)
      });
    }

    const existingPost = await AnonymousPost.findById(postId);
    if (!existingPost) {
      return res.status(404).json({ error: 'Post not found or has expired' });
    }

    res.json({
      message: 'Downvoted post',
      userVote: 'downvote',
      upvotesCount: Math.max(0, existingPost.upvotesCount),
      downvotesCount: Math.max(0, existingPost.downvotesCount)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating downvote' });
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
        .limit(limit)
        .lean(),
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

// POST /api/waitlist (Public waitlist sign-up with client IP & fingerprinting)
router.post('/waitlist', async (req, res) => {
  try {
    const {
      email,
      userAgent,
      language,
      platform,
      screenResolution,
      referrer,
      country,
      region,
      city
    } = req.body;

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '127.0.0.1';

    const Waitlist = require('../models/Waitlist');

    // 1. IP uniqueness check
    const existingIp = await Waitlist.findOne({ ip });
    if (existingIp) {
      return res.status(400).json({ error: 'This device has already joined the waitlist.' });
    }

    // 2. Email validation (if provided)
    let cleanEmail = null;
    if (email) {
      if (typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'A valid email is required' });
      }
      cleanEmail = email.trim().toLowerCase();

      // Check if email already on waitlist
      const existingEmail = await Waitlist.findOne({ email: cleanEmail });
      if (existingEmail) {
        return res.status(400).json({ error: 'Email is already on the waitlist.' });
      }
    }

    // Fallback detection for country using Render/Cloudflare geo headers
    const detectedCountry = country || req.headers['cf-ipcountry'] || req.headers['x-appengine-country'] || undefined;

    // 3. Save entry
    const entry = new Waitlist({
      ip,
      email: cleanEmail || undefined,
      userAgent,
      language,
      platform,
      screenResolution,
      referrer,
      country: detectedCountry,
      region,
      city
    });
    await entry.save();

    // 4. Send confirmation email (only if email was supplied)
    if (cleanEmail) {
      const subject = "Welcome to FRND";
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            @media only screen and (max-width: 600px) {
              .email-container { padding: 18px 14px !important; border-radius: 16px !important; }
              .email-header { padding: 20px 16px 14px !important; }
              .email-body { padding: 22px 18px !important; }
              .email-title { font-size: 20px !important; margin-bottom: 10px !important; }
              .badge-pill { margin: 16px 0 !important; padding: 12px 16px !important; }
              .badge-text { font-size: 13px !important; }
              .email-footer { padding: 16px 18px !important; }
            }
          </style>
        </head>
        <body style="margin: 0; padding: 0; background-color: #FDF6EA;">
          <div style="background-color: #FDF6EA; padding: 20px 12px; font-family: 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
            <div class="email-container" style="max-width: 500px; margin: 0 auto; background-color: #FEFDFD; border: 2px solid #040404; border-radius: 20px; box-shadow: 4px 5px 0px #040404; overflow: hidden;">
              
              <!-- Top Branding Banner -->
              <div class="email-header" style="padding: 24px 24px 16px; background-color: #FEFDFD; text-align: center; border-bottom: 2px solid #FDF6EA;">
                <div style="display: inline-block; background-color: #A41534; color: #FEFDFD; padding: 5px 14px; border-radius: 8px; border: 2px solid #040404; box-shadow: 2px 2px 0px #040404; font-weight: 900; font-size: 18px; letter-spacing: 0.08em; text-transform: uppercase;">
                  FRND
                </div>
                <p style="margin: 8px 0 0; font-family: Georgia, 'Times New Roman', serif; font-style: italic; color: #A41534; font-size: 14px; font-weight: 600;">
                  Campus friends, made intentional.
                </p>
              </div>

              <!-- Body Section -->
              <div class="email-body" style="padding: 26px 24px;">
                <h1 class="email-title" style="margin: 0 0 12px; font-size: 22px; font-weight: 900; color: #040404; text-transform: uppercase; letter-spacing: -0.02em; line-height: 1.25;">
                  CAMPUS FRIENDS,<br>MADE <span style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; color: #A41534; text-transform: lowercase; font-weight: normal;">intentional.</span>
                </h1>

                <p style="margin: 0 0 14px; font-size: 14px; line-height: 1.55; color: #3A2F2D; font-weight: 500;">
                  The verified campus dating app to meet your crush, match with real students, and spark authentic connections.
                </p>

                <!-- Status Badge Pill -->
                <div class="badge-pill" style="margin: 20px 0; background-color: #FDF4E5; border: 2px solid #A41534; border-radius: 9999px; padding: 12px 20px; text-align: center; box-shadow: 3px 3px 0px #040404;">
                  <span class="badge-text" style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #A41534;">
                    Spot Reserved on Waitlist
                  </span>
                </div>

                <p style="margin: 0 0 12px; font-size: 14px; line-height: 1.55; color: #3A2F2D; font-weight: 500;">
                  Thanks for joining the FRND waitlist. We have saved your spot. As soon as FRND launches for your campus, you will receive early access.
                </p>

                <p style="margin: 0 0 18px; font-size: 14px; line-height: 1.55; color: #3A2F2D; font-weight: 500;">
                  If you have any questions or feedback in the meantime, feel free to reply directly to this email.
                </p>

                <p style="margin: 0; font-size: 14px; line-height: 1.55; color: #040404; font-weight: 700;">
                  Best,<br>
                  The FRND Team
                </p>
              </div>

              <!-- Dark Charcoal Footer -->
              <div class="email-footer" style="padding: 18px 24px; background-color: #040404; color: #FEFDFD; text-align: center;">
                <p style="margin: 0; font-size: 11px; line-height: 1.5; color: #E3D9CF;">
                  You're receiving this because you signed up for the FRND waitlist.
                </p>
                <p style="margin: 6px 0 0; font-size: 10px; color: #8B7B74; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">
                  © ${new Date().getFullYear()} FRND. All rights reserved.
                </p>
              </div>

            </div>
          </div>
        </body>
        </html>
      `;

      const text = `Welcome to FRND\n\nHi there,\n\nThanks for joining the waitlist for FRND. We've reserved your spot on our list.\n\nWe are building an intentional space for campus students to connect, and we will let you know as soon as access opens for your campus.\n\nIf you have any questions or feedback in the meantime, feel free to reply directly to this email.\n\nBest,\nThe FRND Team`;

      await emailService.sendEmail({ to: cleanEmail, subject, text, html });
    }

    res.status(201).json({ message: 'Successfully joined the waitlist!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error joining waitlist' });
  }
});

module.exports = router;
