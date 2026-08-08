const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Admin = require('../models/Admin');
const User = require('../models/User');
const AccountFlag = require('../models/AccountFlag');
const admin = require('../utils/firebase');
const Report = require('../models/Report');
const Feedback = require('../models/Feedback');
const Announcement = require('../models/Announcement');
const AdminAction = require('../models/AdminAction');
const IdentityVerificationRequest = require('../models/IdentityVerificationRequest');
const Payment = require('../models/Payment');
const Match = require('../models/Match');
const Like = require('../models/Like');
const Dislike = require('../models/Dislike');
const Message = require('../models/Message');
const AnonymousPost = require('../models/AnonymousPost');
const Waitlist = require('../models/Waitlist');
const CareerApplication = require('../models/CareerApplication');
const { getSignedPreviewUrl } = require('../utils/uploader');

const { adminAuthRequired, JWT_SECRET } = require('../middleware/auth');
const redis = require('../utils/redis');

const ADMIN_PASSWORD_MIN_LENGTH = 12;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

// Pagination helper
function getPagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_PAGE_LIMIT));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// Helper to log admin audits
async function logAdminAction(adminId, actionType, targetUserId, details) {
  try {
    const action = new AdminAction({
      actionType,
      adminId,
      targetUserId: targetUserId ? new mongoose.Types.ObjectId(targetUserId) : undefined,
      details,
      createdAt: new Date()
    });
    await action.save();
  } catch (err) {
    console.error('Failed to log admin action:', err.message);
  }
}

// ------------------------------------------------------------------
// 2. STATS & ANALYTICS
// ------------------------------------------------------------------

// GET /api/admin/stats (Full system metrics & database data visualization breakdown)
router.get('/stats', adminAuthRequired, async (req, res) => {
  try {
    const statsCacheKey = 'admin:stats:summary';

    // 1. Safe Redis Cache Lookup
    try {
      const cachedStats = await redis.get(statsCacheKey);
      if (cachedStats) {
        const parsed = typeof cachedStats === 'string' ? JSON.parse(cachedStats) : cachedStats;
        if (parsed && typeof parsed === 'object') {
          return res.json(parsed);
        }
      }
    } catch (cacheErr) {
      console.warn('[ADMIN STATS] Redis cache lookup error (falling back to DB):', cacheErr.message);
    }

    // 2. Resilient DB Aggregations (Individual catch fallbacks prevent whole-dashboard 500s)
    const [
      userStatsAgg,
      likeStatsAgg,
      flagStatsAgg,
      pendingVerifications,
      totalDislikes,
      totalMatches,
      totalMessages,
      totalAnonymousPosts,
      totalFeedback,
      totalWaitlist,
      totalCareers,
      totalReports,
      paymentAgg
    ] = await Promise.all([
      User.aggregate([
        {
          $facet: {
            totalUsers: [{ $count: 'count' }],
            freeUsers: [{ $match: { $or: [{ tier: 'free' }, { tier: { $exists: false } }, { tier: null }] } }, { $count: 'count' }],
            silverUsers: [{ $match: { tier: 'silver' } }, { $count: 'count' }],
            goldUsers: [{ $match: { tier: 'gold' } }, { $count: 'count' }],
            maleUsers: [{ $match: { gender: 'male' } }, { $count: 'count' }],
            femaleUsers: [{ $match: { gender: 'female' } }, { $count: 'count' }],
            otherUsers: [{ $match: { gender: { $nin: ['male', 'female'] } } }, { $count: 'count' }],
            verifiedUsers: [{ $match: { identityStatus: 'verified' } }, { $count: 'count' }],
            unverifiedUsers: [{ $match: { identityStatus: { $in: ['unverified', 'rejected'] } } }, { $count: 'count' }],
            bannedUsers: [{ $match: { banned: true } }, { $count: 'count' }]
          }
        }
      ]).catch((err) => { console.error('[STATS DB ERR] User aggregate:', err.message); return [{}]; }),
      Like.aggregate([
        {
          $facet: {
            totalLikes: [{ $count: 'count' }],
            standardLikes: [{ $match: { type: 'like' } }, { $count: 'count' }],
            superlikes: [{ $match: { type: 'superlike' } }, { $count: 'count' }]
          }
        }
      ]).catch((err) => { console.error('[STATS DB ERR] Like aggregate:', err.message); return [{}]; }),
      AccountFlag.aggregate([
        {
          $facet: {
            openFlags: [{ $match: { status: 'open' } }, { $count: 'count' }],
            highFlags: [{ $match: { status: 'open', severity: 'high' } }, { $count: 'count' }],
            mediumFlags: [{ $match: { status: 'open', severity: 'medium' } }, { $count: 'count' }],
            lowFlags: [{ $match: { status: 'open', severity: 'low' } }, { $count: 'count' }]
          }
        }
      ]).catch((err) => { console.error('[STATS DB ERR] Flag aggregate:', err.message); return [{}]; }),
      IdentityVerificationRequest.countDocuments({ status: 'pending' }).catch(() => 0),
      Dislike.countDocuments({}).catch(() => 0),
      Match.countDocuments({}).catch(() => 0),
      Message.countDocuments({}).catch(() => 0),
      AnonymousPost.countDocuments({}).catch(() => 0),
      Feedback.countDocuments({}).catch(() => 0),
      Waitlist.countDocuments({}).catch(() => 0),
      CareerApplication.countDocuments({}).catch(() => 0),
      Report.countDocuments({}).catch(() => 0),
      Payment.aggregate([
        { $match: { status: { $in: ['paid', 'active'] } } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$amount' },
            silverRevenue: {
              $sum: { $cond: [{ $eq: ['$tier', 'silver'] }, '$amount', 0] }
            },
            goldRevenue: {
              $sum: { $cond: [{ $eq: ['$tier', 'gold'] }, '$amount', 0] }
            },
            activeSubscriptionsCount: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$status', 'active'] },
                      {
                        $and: [
                          { $ne: ['$expiresAt', null] },
                          { $gt: ['$expiresAt', new Date()] }
                        ]
                      }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            totalTransactionsCount: { $sum: 1 }
          }
        }
      ]).catch((err) => { console.error('[STATS DB ERR] Payment aggregate:', err.message); return []; })
    ]);

    const getFacetCount = (agg, key) => (agg && agg[0] && agg[0][key] && agg[0][key][0] && agg[0][key][0].count) || 0;

    const totalUsers = getFacetCount(userStatsAgg, 'totalUsers');
    const freeUsers = getFacetCount(userStatsAgg, 'freeUsers');
    const silverUsers = getFacetCount(userStatsAgg, 'silverUsers');
    const goldUsers = getFacetCount(userStatsAgg, 'goldUsers');
    const maleUsers = getFacetCount(userStatsAgg, 'maleUsers');
    const femaleUsers = getFacetCount(userStatsAgg, 'femaleUsers');
    const otherUsers = getFacetCount(userStatsAgg, 'otherUsers');
    const verifiedUsers = getFacetCount(userStatsAgg, 'verifiedUsers');
    const unverifiedUsers = getFacetCount(userStatsAgg, 'unverifiedUsers');
    const bannedUsers = getFacetCount(userStatsAgg, 'bannedUsers');

    const totalLikes = getFacetCount(likeStatsAgg, 'totalLikes');
    const standardLikes = getFacetCount(likeStatsAgg, 'standardLikes');
    const superlikes = getFacetCount(likeStatsAgg, 'superlikes');

    const openFlags = getFacetCount(flagStatsAgg, 'openFlags');
    const highFlags = getFacetCount(flagStatsAgg, 'highFlags');
    const mediumFlags = getFacetCount(flagStatsAgg, 'mediumFlags');
    const lowFlags = getFacetCount(flagStatsAgg, 'lowFlags');

    const payStats = (paymentAgg && paymentAgg[0]) ? paymentAgg[0] : {
      totalRevenue: 0,
      silverRevenue: 0,
      goldRevenue: 0,
      activeSubscriptionsCount: 0,
      totalTransactionsCount: 0
    };

    const totalRevenue = payStats.totalRevenue || 0;
    const silverRevenue = payStats.silverRevenue || 0;
    const goldRevenue = payStats.goldRevenue || 0;
    const activeSubscriptions = payStats.activeSubscriptionsCount || 0;
    const totalTransactionsCount = payStats.totalTransactionsCount || 0;

    const statsPayload = {
      overview: {
        totalUsers,
        premiumUsers: silverUsers + goldUsers,
        freeUsers,
        silverUsers,
        goldUsers,
        maleUsers,
        femaleUsers,
        otherUsers,
        verifiedUsers,
        pendingVerifications,
        unverifiedUsers,
        bannedUsers
      },
      financials: {
        totalRevenueINR: totalRevenue,
        silverRevenueINR: silverRevenue,
        goldRevenueINR: goldRevenue,
        activeSubscriptionsCount: activeSubscriptions,
        totalTransactionsCount: totalTransactionsCount
      },
      social: {
        totalLikes,
        standardLikes,
        superlikes,
        totalDislikes,
        totalMatches,
        totalMessages,
        totalAnonymousPosts,
        totalFeedback,
        totalWaitlist,
        totalCareers
      },
      moderation: {
        openFlags,
        highFlags,
        mediumFlags,
        lowFlags,
        totalReports,
        bannedUsers
      },
      collections: {
        Users: totalUsers,
        Likes: totalLikes,
        Dislikes: totalDislikes,
        Matches: totalMatches,
        Messages: totalMessages,
        Payments: totalTransactionsCount,
        Flags: openFlags,
        Reports: totalReports,
        Feedback: totalFeedback,
        Waitlist: totalWaitlist,
        Careers: totalCareers,
        AnonymousPosts: totalAnonymousPosts
      }
    };

    try {
      await redis.set(statsCacheKey, JSON.stringify(statsPayload), { EX: 300 });
    } catch (setErr) {
      console.warn('[ADMIN STATS] Redis set cache failed:', setErr.message);
    }

    res.json(statsPayload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching admin stats' });
  }
});

// GET /api/admin/payments (Detailed payment & revenue transactions log)
router.get('/payments', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const tier = req.query.tier;
    const filter = {};
    if (tier && ['silver', 'gold'].includes(tier)) {
      filter.tier = tier;
    }

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .populate('userId', 'name email username tier')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments(filter)
    ]);

    res.json({ payments, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching payment logs' });
  }
});

// ------------------------------------------------------------------
// 1. ADMIN AUTHENTICATION
// ------------------------------------------------------------------

// POST /api/admin/auth/signup
router.post('/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required and must be non-empty strings' });
    }

    // Gate registration if initial admin already exists
    const existingAdminCount = await Admin.countDocuments({});
    if (existingAdminCount > 0) {
      // Must be authenticated as an existing admin to create new admin accounts
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Admin authentication required to register new admin accounts' });
      }
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.aud !== 'admin-panel') {
          return res.status(403).json({ error: 'Forbidden' });
        }
        const requestingAdmin = await Admin.findById(decoded.id);
        if (!requestingAdmin || !requestingAdmin.active) {
          return res.status(403).json({ error: 'Active admin credentials required' });
        }
      } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired admin token' });
      }
    }

    // L-2: Password strength enforcement for admin accounts
    if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ error: `Admin password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters` });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Verify against hardcoded email allowlist in env
    // Generic rejection — avoids revealing whether a given email is on the allowlist
    const allowlist = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!allowlist.includes(cleanEmail)) {
      return res.status(400).json({ error: 'Registration failed' });
    }

    // One-time signup: reject if account already exists
    const existingAdmin = await Admin.findOne({ email: cleanEmail });
    if (existingAdmin) {
      return res.status(400).json({ error: 'Admin account already exists' });
    }

    // Hash personal password and save
    const salt = await bcrypt.genSalt(12); // higher cost for admin accounts
    const passwordHash = await bcrypt.hash(password, salt);

    const admin = new Admin({ email: cleanEmail, passwordHash, active: true });
    await admin.save();

    res.status(201).json({ message: 'Admin account registered successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during admin registration' });
  }
});

// POST /api/admin/auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password, commonPass } = req.body;
    if (!email || !password || !commonPass || typeof email !== 'string' || typeof password !== 'string' || typeof commonPass !== 'string') {
      return res.status(400).json({ error: 'Required: email, password, and common password (must be non-empty strings)' });
    }

    // Brute force protection: max 5 attempts per IP per 15 minutes, hard lock at 10
    const ip = req.ip || '127.0.0.1';
    const bruteKey = `admin_login_attempts:${ip}`;
    const attempts = await redis.incr(bruteKey);
    if (attempts === 1) await redis.expire(bruteKey, 900);
    if (attempts > 10) {
      return res.status(429).json({ error: 'Too many login attempts. Your IP has been temporarily locked.' });
    }
    if (attempts > 5) {
      return res.status(429).json({ error: 'Too many failed login attempts. Try again in 15 minutes.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Fetch admin account
    const admin = await Admin.findOne({ email: cleanEmail });

    // Constant-time dummy hash to prevent timing-based admin account enumeration
    const dummyHash = '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    const personalMatch = admin ? await bcrypt.compare(password, admin.passwordHash) : await bcrypt.compare(password, dummyHash);

    if (!admin || !admin.active || !personalMatch) {
      return res.status(401).json({ error: 'Invalid credentials or inactive account' });
    }

    // Compare shared common password
    const commonHash = process.env.ADMIN_COMMON_PASSWORD_HASH;
    if (!commonHash) {
      return res.status(500).json({ error: 'Server missing shared common password configuration' });
    }

    const isCommonMatch = await bcrypt.compare(commonPass, commonHash);
    if (!isCommonMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Issue admin-scoped JWT with audience claim
    const token = jwt.sign(
      { id: admin._id, email: admin.email, aud: 'admin-panel' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    admin.lastLoginAt = new Date();
    await admin.save();

    // Clear brute-force counter on successful login
    await redis.del(bruteKey);

    await logAdminAction(admin._id, 'login', null, { ip: req.ip });

    res.json({ message: 'Admin login successful', token, email: admin.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during admin login' });
  }
});

// POST /api/admin/auth/logout
router.post('/auth/logout', adminAuthRequired, async (req, res) => {
  await logAdminAction(req.admin._id, 'logout', null, {});
  res.json({ message: 'Admin logged out successfully' });
});

// ------------------------------------------------------------------
// 2. ADMIN OPERATIONS (ALL GATED)
// ------------------------------------------------------------------

// GET /api/admin/flags
router.get('/flags', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const status = req.query.status || 'open';
    const validStatuses = ['open', 'reviewed', 'dismissed', 'actioned'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }

    const [flags, total] = await Promise.all([
      AccountFlag.find({ status })
        .populate('userId', 'name email username openFlagCount')
        .sort({ severity: -1, createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AccountFlag.countDocuments({ status })
    ]);

    res.json({ flags, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching flags' });
  }
});

// GET /api/admin/flags/user/:userId
router.get('/flags/user/:userId', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const [flags, total] = await Promise.all([
      AccountFlag.find({ userId: req.params.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      AccountFlag.countDocuments({ userId: req.params.userId })
    ]);
    res.json({ flags, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching user flags' });
  }
});

// Helper for flag status transitions
async function transitionFlag(req, res, targetStatus, autoBanUser = false) {
  try {
    const flag = await AccountFlag.findOneAndUpdate(
      { _id: req.params.id, status: 'open' },
      {
        $set: {
          status: targetStatus,
          reviewedBy: req.admin._id,
          reviewedAt: new Date()
        }
      },
      { new: true }
    );

    if (!flag) {
      const existing = await AccountFlag.findById(req.params.id).lean();
      if (!existing) {
        return res.status(404).json({ error: 'Flag not found' });
      }
      return res.status(400).json({ error: 'Flag is already resolved' });
    }

    // Decrement open flag count on user (atomic)
    const updateOp = { $inc: { openFlagCount: -1 } };
    if (autoBanUser) {
      updateOp.$set = {
        banned: true,
        banReason: `Banned during flag actioning: ${flag.flagType}`
      };
      await redis.set(`banned:${flag.userId}`, '1', { EX: 86400 * 30 }).catch(() => {});
    }
    await User.findByIdAndUpdate(flag.userId, updateOp);

    await logAdminAction(req.admin._id, `resolve_flag_${targetStatus}`, flag.userId, { flagId: flag._id });

    res.json({ message: `Flag resolved with status: ${targetStatus}`, flag });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error resolving flag' });
  }
}

// POST /api/admin/flags/:id/dismiss
router.post('/flags/:id/dismiss', adminAuthRequired, (req, res) => transitionFlag(req, res, 'dismissed', false));

// POST /api/admin/flags/:id/review
router.post('/flags/:id/review', adminAuthRequired, (req, res) => transitionFlag(req, res, 'reviewed', false));

// POST /api/admin/flags/:id/action (bans user)
router.post('/flags/:id/action', adminAuthRequired, (req, res) => transitionFlag(req, res, 'actioned', true));

// GET /api/admin/users
router.get('/users', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const filter = {};
    if (req.query.tier && ['free', 'silver', 'gold'].includes(req.query.tier)) {
      if (req.query.tier === 'free') {
        filter.$or = [{ tier: 'free' }, { tier: { $exists: false } }];
      } else {
        filter.tier = req.query.tier;
      }
    }
    if (req.query.isPremium === 'true') {
      filter.isPremium = true;
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('name email username gender age school course isPremium tier subscriptionExpiresAt autopayStatus openFlagCount banned identityStatus createdAt')
        .sort({ openFlagCount: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter)
    ]);
    res.json({ users, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error listing users' });
  }
});

// GET /api/admin/users/:id
router.get('/users/:id', adminAuthRequired, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user ID format' });
    }
    const user = await User.findById(req.params.id).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching user details' });
  }
});

// POST /api/admin/users/:id/ban
router.post('/users/:id/ban', adminAuthRequired, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user ID format' });
    }
    const { reason } = req.body;
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Ban reason is required' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { banned: true, banReason: reason.trim() } },
      { new: true }
    ).select('-passwordHash');

    if (!user) return res.status(404).json({ error: 'User not found' });

    await redis.set(`banned:${user._id}`, '1', { EX: 86400 * 30 }).catch(() => {});
    await redis.del(`discover:${user._id}`, `user:profile:${user._id}`).catch(() => {});
    await logAdminAction(req.admin._id, 'ban_user', user._id, { reason: reason.trim() });

    res.json({ message: 'User banned successfully', user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error banning user' });
  }
});

// POST /api/admin/users/:id/unban
router.post('/users/:id/unban', adminAuthRequired, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user ID format' });
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { banned: false }, $unset: { banReason: '' } },
      { new: true }
    ).select('-passwordHash');

    if (!user) return res.status(404).json({ error: 'User not found' });

    await redis.set(`banned:${user._id}`, '0', { EX: 300 }).catch(() => {});
    await redis.del(`discover:${user._id}`, `user:profile:${user._id}`).catch(() => {});
    await logAdminAction(req.admin._id, 'unban_user', user._id, {});

    res.json({ message: 'User unbanned successfully', user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error unbanning user' });
  }
});

// POST /api/admin/users/:id/premium
router.post('/users/:id/premium', adminAuthRequired, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user ID format' });
    }
    const { isPremium } = req.body;
    if (typeof isPremium !== 'boolean') {
      return res.status(400).json({ error: 'isPremium boolean is required' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { isPremium } },
      { new: true }
    ).select('-passwordHash');

    if (!user) return res.status(404).json({ error: 'User not found' });

    await redis.del(`discover:${user._id}`, `user:profile:${user._id}`).catch(() => {});
    await logAdminAction(req.admin._id, 'update_premium', user._id, { isPremium });

    res.json({ message: `Premium status set to ${isPremium}`, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating premium status' });
  }
});

// POST /api/admin/users/:id/badge
router.post('/users/:id/badge', adminAuthRequired, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user ID format' });
    }
    const { badges } = req.body;
    if (!Array.isArray(badges)) {
      return res.status(400).json({ error: 'Badges must be an array' });
    }
    // Sanitise badge strings
    const sanitisedBadges = badges.map(b => String(b).trim()).filter(Boolean);

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { badges: sanitisedBadges } },
      { new: true }
    ).select('-passwordHash');

    if (!user) return res.status(404).json({ error: 'User not found' });

    await logAdminAction(req.admin._id, 'update_badges', user._id, { badges: sanitisedBadges });

    res.json({ message: 'User badges updated successfully', user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating badges' });
  }
});

// GET /api/admin/reports
router.get('/reports', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const [reports, total] = await Promise.all([
      Report.find({})
        .populate('reporterId', 'username email')
        .populate('targetUserId', 'username email openFlagCount')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Report.countDocuments({})
    ]);
    res.json({ reports, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching reports' });
  }
});


// GET /api/admin/feedback
router.get('/feedback', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const [feedback, total] = await Promise.all([
      Feedback.find({})
        .populate('userId', 'username email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Feedback.countDocuments({})
    ]);
    res.json({ feedback, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching feedback' });
  }
});


// POST /api/admin/announce
router.post('/announce', adminAuthRequired, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ error: 'Title is required' });
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'Content is required' });
    }
    if (title.length > 200) return res.status(400).json({ error: 'Title too long (max 200 chars)' });
    if (content.length > 5000) return res.status(400).json({ error: 'Content too long (max 5000 chars)' });

    const announcement = new Announcement({
      title: title.trim(),
      content: content.trim(),
      adminId: req.admin._id,
      createdAt: new Date()
    });
    await announcement.save();

    await logAdminAction(req.admin._id, 'create_announcement', null, { title: title.trim() });

    if (admin.apps.length > 0) {
      admin.messaging().send({
        topic: 'global_announcements',
        notification: {
          title: title.trim(),
          body: content.trim()
        }
      }).catch(e => console.error('[FCM] Announcement push error:', e));
    }

    res.status(201).json({ message: 'Announcement posted successfully', announcement });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error posting announcement' });
  }
});

// GET /api/admin/verification-requests
router.get('/verification-requests', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);

    const [requests, total] = await Promise.all([
      IdentityVerificationRequest.find({ status: 'pending' })
        .populate('userId', 'name email username')
        .sort({ submittedAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      IdentityVerificationRequest.countDocuments({ status: 'pending' })
    ]);

    const userIds = requests.map(r => r.userId ? r.userId._id : null).filter(Boolean);
    const duplicateFlags = await AccountFlag.find({
      userId: { $in: userIds },
      flagType: 'duplicate_identity_document',
      status: 'open'
    }).select('userId').lean();
    const dupUserSet = new Set(duplicateFlags.map(f => f.userId.toString()));

    const formatted = requests.map((r) => ({
      _id: r._id,
      userId: r.userId,
      idCardUrl: r.idCardImage && r.idCardImage.publicId ? getSignedPreviewUrl(r.idCardImage.publicId) : null,
      faceUrl: r.faceImage && r.faceImage.publicId ? getSignedPreviewUrl(r.faceImage.publicId) : null,
      submittedAt: r.submittedAt,
      isDuplicate: r.userId ? dupUserSet.has(r.userId._id.toString()) : false
    }));

    res.json({ requests: formatted, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error listing verification requests' });
  }
});

// POST /api/admin/verification-requests/:id/approve
router.post('/verification-requests/:id/approve', adminAuthRequired, async (req, res) => {
  try {
    const request = await IdentityVerificationRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Verification request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request is already reviewed' });
    }

    request.status = 'verified';
    request.reviewedBy = req.admin._id;
    request.reviewedAt = new Date();
    await request.save();

    await User.findByIdAndUpdate(request.userId, {
      $set: {
        identityStatus: 'verified',
        identityReviewedBy: req.admin._id,
        identityReviewedAt: new Date()
      },
      $unset: { identityReviewReason: '' }
    });

    await logAdminAction(req.admin._id, 'approve_verification', request.userId, { requestId: request._id });

    res.json({ message: 'Verification request approved successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error approving verification request' });
  }
});

// POST /api/admin/verification-requests/:id/reject
router.post('/verification-requests/:id/reject', adminAuthRequired, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const request = await IdentityVerificationRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Verification request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request is already reviewed' });
    }

    request.status = 'unverified';
    request.reason = reason.trim();
    request.reviewedBy = req.admin._id;
    request.reviewedAt = new Date();
    await request.save();

    await User.findByIdAndUpdate(request.userId, {
      $set: {
        identityStatus: 'unverified',
        identityReviewReason: reason.trim(),
        identityReviewedBy: req.admin._id,
        identityReviewedAt: new Date()
      }
    });

    await logAdminAction(req.admin._id, 'reject_verification', request.userId, { requestId: request._id, reason: reason.trim() });

    res.json({ message: 'Verification request rejected successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error rejecting verification request' });
  }
});

// GET /api/admin/waitlist (Paginated list + Data Visualizer summary)
router.get('/waitlist', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const Waitlist = require('../models/Waitlist');

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [entries, total, visualizerAgg] = await Promise.all([
      Waitlist.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Waitlist.countDocuments({}),
      Waitlist.aggregate([
        {
          $facet: {
            dailyTimeline: [
              { $match: { createdAt: { $gte: thirtyDaysAgo } } },
              {
                $group: {
                  _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                  count: { $sum: 1 }
                }
              },
              { $sort: { _id: 1 } }
            ],
            platforms: [
              { $match: { platform: { $exists: true, $ne: "" } } },
              {
                $group: {
                  _id: "$platform",
                  count: { $sum: 1 }
                }
              },
              { $sort: { count: -1 } },
              { $limit: 5 }
            ],
            topCities: [
              { $match: { city: { $exists: true, $ne: "" } } },
              {
                $group: {
                  _id: "$city",
                  count: { $sum: 1 }
                }
              },
              { $sort: { count: -1 } },
              { $limit: 5 }
            ],
            domainBreakdown: [
              { $match: { email: { $exists: true, $ne: "" } } },
              {
                $project: {
                  domain: { $toLower: { $arrayElemAt: [{ $split: ["$email", "@"] }, 1] } }
                }
              },
              {
                $group: {
                  _id: "$domain",
                  count: { $sum: 1 }
                }
              },
              { $sort: { count: -1 } }
            ]
          }
        }
      ])
    ]);

    // Format domain & college email breakdown from DB aggregation
    let collegeCount = 0;
    let generalCount = 0;
    const rawDomains = visualizerAgg[0]?.domainBreakdown || [];

    rawDomains.forEach(item => {
      const domain = (item._id || '').trim();
      if (!domain) return;
      if (domain.includes('.edu') || domain.includes('.ac.in') || domain.includes('adamasuniversity')) {
        collegeCount += item.count;
      } else {
        generalCount += item.count;
      }
    });

    const topDomains = rawDomains
      .slice(0, 5)
      .map(d => ({ domain: d._id, count: d.count }));

    const timeline = (visualizerAgg[0]?.dailyTimeline || []).map(t => ({ date: t._id, count: t.count }));
    const platforms = (visualizerAgg[0]?.platforms || []).map(p => ({ name: p._id, count: p.count }));
    const cities = (visualizerAgg[0]?.topCities || []).map(c => ({ city: c._id, count: c.count }));

    const visualizer = {
      totalEntries: total,
      collegeVsGeneral: { collegeCount, generalCount },
      topDomains,
      platforms,
      topCities: cities,
      dailyTimeline: timeline
    };

    res.json({ entries, page, limit, total, visualizer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching waitlist' });
  }
});

// GET /api/admin/waitlist/visualizer (Dedicated Data Visualizer analytics endpoint for charts UI)
router.get('/waitlist/visualizer', adminAuthRequired, async (req, res) => {
  try {
    const Waitlist = require('../models/Waitlist');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [total, visualizerAgg] = await Promise.all([
      Waitlist.countDocuments({}),
      Waitlist.aggregate([
        {
          $facet: {
            dailyTimeline: [
              { $match: { createdAt: { $gte: thirtyDaysAgo } } },
              {
                $group: {
                  _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                  count: { $sum: 1 }
                }
              },
              { $sort: { _id: 1 } }
            ],
            platforms: [
              { $match: { platform: { $exists: true, $ne: "" } } },
              {
                $group: {
                  _id: "$platform",
                  count: { $sum: 1 }
                }
              },
              { $sort: { count: -1 } },
              { $limit: 5 }
            ],
            topCities: [
              { $match: { city: { $exists: true, $ne: "" } } },
              {
                $group: {
                  _id: "$city",
                  count: { $sum: 1 }
                }
              },
              { $sort: { count: -1 } },
              { $limit: 5 }
            ],
            domainBreakdown: [
              { $match: { email: { $exists: true, $ne: "" } } },
              {
                $project: {
                  domain: { $toLower: { $arrayElemAt: [{ $split: ["$email", "@"] }, 1] } }
                }
              },
              {
                $group: {
                  _id: "$domain",
                  count: { $sum: 1 }
                }
              },
              { $sort: { count: -1 } }
            ]
          }
        }
      ])
    ]);

    let collegeCount = 0;
    let generalCount = 0;
    const rawDomains = visualizerAgg[0]?.domainBreakdown || [];

    rawDomains.forEach(item => {
      const domain = (item._id || '').trim();
      if (!domain) return;
      if (domain.includes('.edu') || domain.includes('.ac.in') || domain.includes('adamasuniversity')) {
        collegeCount += item.count;
      } else {
        generalCount += item.count;
      }
    });

    const topDomains = rawDomains
      .slice(0, 5)
      .map(d => ({ domain: d._id, count: d.count }));

    const timeline = (visualizerAgg[0]?.dailyTimeline || []).map(t => ({ date: t._id, count: t.count }));
    const platforms = (visualizerAgg[0]?.platforms || []).map(p => ({ name: p._id, count: p.count }));
    const cities = (visualizerAgg[0]?.topCities || []).map(c => ({ city: c._id, count: c.count }));

    res.json({
      visualizer: {
        totalEntries: total,
        collegeVsGeneral: { collegeCount, generalCount },
        topDomains,
        platforms,
        topCities: cities,
        dailyTimeline: timeline
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error generating waitlist data visualizer analytics' });
  }
});

// GET /api/admin/actions
router.get('/actions', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const [actions, total] = await Promise.all([
      AdminAction.find({})
        .populate('adminId', 'email')
        .populate('targetUserId', 'username email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AdminAction.countDocuments({})
    ]);
    res.json({ actions, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching admin actions' });
  }
});

// ------------------------------------------------------------------
// ONBOARDING OPTIONS CONFIGURATION
// ------------------------------------------------------------------

// GET /api/admin/config/onboarding
router.get('/config/onboarding', adminAuthRequired, async (req, res) => {
  try {
    const { getOrInitOnboardingConfig } = require('../utils/onboardingConfig');
    const config = await getOrInitOnboardingConfig();
    res.json({
      key: config.key,
      segments: config.segments,
      sections: config.sections,
      updatedAt: config.updatedAt
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching onboarding config' });
  }
});

// PUT /api/admin/config/onboarding (Admin: Edit/Update Interests & Prompts JSON options)
router.put('/config/onboarding', adminAuthRequired, async (req, res) => {
  try {
    const { segments, sections } = req.body;
    if (!segments || !sections || !Array.isArray(segments) || !Array.isArray(sections)) {
      return res.status(400).json({ error: 'Required payload: segments (array) and sections (array)' });
    }

    const OnboardingConfig = require('../models/OnboardingConfig');
    const config = await OnboardingConfig.findOneAndUpdate(
      { key: 'default_onboarding_config' },
      { $set: { segments, sections } },
      { new: true, upsert: true }
    );

    // Invalidate Redis onboarding config cache
    await redis.del('config:onboarding').catch(() => {});

    await logAdminAction(req.admin._id, 'update_onboarding_config', null, {
      segmentsCount: segments.length,
      sectionsCount: sections.length
    });

    res.json({
      message: 'Onboarding configuration updated successfully',
      config
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating onboarding config' });
  }
});

// ------------------------------------------------------------------
// RESEND EMAIL POOL & FAILOVER MANAGEMENT
// ------------------------------------------------------------------

// GET /api/admin/config/email
router.get('/config/email', adminAuthRequired, async (req, res) => {
  try {
    const emailService = require('../utils/emailService');
    const status = await emailService.getEmailServiceStatus();
    res.json(status);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching email service status' });
  }
});

// PUT /api/admin/config/email/switch (Admin: Manually switch active key or re-enable quota exceeded key)
router.put('/config/email/switch', adminAuthRequired, async (req, res) => {
  try {
    const { activeKeyIndex } = req.body;
    if (activeKeyIndex === undefined || activeKeyIndex === null) {
      return res.status(400).json({ error: 'activeKeyIndex is required' });
    }

    const emailService = require('../utils/emailService');
    const updatedStatus = await emailService.setActiveEmailAccount(activeKeyIndex);

    await logAdminAction(req.admin._id, 'switch_email_account', null, { activeKeyIndex });

    res.json({
      message: `Active email account successfully switched to Account #${Number(activeKeyIndex) + 1}`,
      status: updatedStatus
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Error switching active email account' });
  }
});

// PUT /api/admin/config/email/count (Admin: Manually alter/update daily sent count for an email account under 100 quota)
router.put('/config/email/count', adminAuthRequired, async (req, res) => {
  try {
    const { accountIndex, dailySentCount } = req.body;
    if (accountIndex === undefined || dailySentCount === undefined) {
      return res.status(400).json({ error: 'Required fields: accountIndex and dailySentCount' });
    }

    const emailService = require('../utils/emailService');
    const updatedStatus = await emailService.updateAccountDailySentCount(accountIndex, dailySentCount);

    await logAdminAction(req.admin._id, 'update_email_sent_count', null, { accountIndex, dailySentCount });

    res.json({
      message: `Daily sent count for Account #${Number(accountIndex) + 1} updated to ${dailySentCount}`,
      status: updatedStatus
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Error updating daily sent count' });
  }
});

// ------------------------------------------------------------------
// CAREER APPLICATIONS MANAGEMENT
// ------------------------------------------------------------------

// GET /api/admin/careers (List submitted role applications for career page)
router.get('/careers', adminAuthRequired, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const CareerApplication = require('../models/CareerApplication');

    const [applications, total] = await Promise.all([
      CareerApplication.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CareerApplication.countDocuments({})
    ]);

    res.json({ applications, page, limit, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching career applications' });
  }
});

// PUT /api/admin/careers/:id/status (Update application status)
router.put('/careers/:id/status', adminAuthRequired, async (req, res) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['pending', 'reviewed', 'contacted', 'rejected'];
    if (!status || !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowedStatuses.join(', ')}` });
    }

    const CareerApplication = require('../models/CareerApplication');
    const application = await CareerApplication.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    );

    if (!application) {
      return res.status(404).json({ error: 'Career application not found' });
    }

    await logAdminAction(req.admin._id, 'update_career_application_status', null, { applicationId: req.params.id, status });

    res.json({ message: 'Career application status updated successfully', application });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating career application status' });
  }
});

module.exports = router;
