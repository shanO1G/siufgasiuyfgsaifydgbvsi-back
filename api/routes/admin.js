const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Admin = require('../models/Admin');
const User = require('../models/User');
const AccountFlag = require('../models/AccountFlag');
const Report = require('../models/Report');
const Feedback = require('../models/Feedback');
const Announcement = require('../models/Announcement');
const AdminAction = require('../models/AdminAction');
const IdentityVerificationRequest = require('../models/IdentityVerificationRequest');
const { getSignedPreviewUrl } = require('../utils/uploader');

const { adminAuthRequired, JWT_SECRET } = require('../middleware/auth');

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
// 1. ADMIN AUTHENTICATION
// ------------------------------------------------------------------

// POST /api/admin/auth/signup
router.post('/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // L-2: Password strength enforcement for admin accounts
    if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ error: `Admin password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters` });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Verify against hardcoded email allowlist in env (generic rejection — don't reveal allowlist)
    const allowlist = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!allowlist.includes(cleanEmail)) {
      return res.status(400).json({ error: 'Access denied: unauthorized admin email' });
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
    if (!email || !password || !commonPass) {
      return res.status(400).json({ error: 'Required: email, password, and common password' });
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
        .limit(limit),
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
    const flag = await AccountFlag.findById(req.params.id);
    if (!flag) {
      return res.status(404).json({ error: 'Flag not found' });
    }

    if (flag.status !== 'open') {
      return res.status(400).json({ error: 'Flag is already resolved' });
    }

    flag.status = targetStatus;
    flag.reviewedBy = req.admin._id;
    flag.reviewedAt = new Date();
    await flag.save();

    // Decrement open flag count on user (atomic)
    const updateOp = { $inc: { openFlagCount: -1 } };
    if (autoBanUser) {
      updateOp.$set = {
        banned: true,
        banReason: `Banned during flag actioning: ${flag.flagType}`
      };
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
    const [users, total] = await Promise.all([
      User.find({})
        .select('name email username gender age school course isPremium openFlagCount banned identityStatus createdAt')
        .sort({ openFlagCount: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments({})
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
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { banned: false }, $unset: { banReason: '' } },
      { new: true }
    ).select('-passwordHash');

    if (!user) return res.status(404).json({ error: 'User not found' });

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
        .limit(limit),
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
        .limit(limit),
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
        .limit(limit),
      IdentityVerificationRequest.countDocuments({ status: 'pending' })
    ]);

    const formatted = await Promise.all(requests.map(async (r) => {
      // Check if a duplicate document flag exists for this request's user
      const isDuplicate = await AccountFlag.exists({
        userId: r.userId._id,
        flagType: 'duplicate_identity_document',
        status: 'open'
      });

      return {
        _id: r._id,
        userId: r.userId,
        idCardUrl: getSignedPreviewUrl(r.idCardImage.publicId),
        faceUrl: getSignedPreviewUrl(r.faceImage.publicId),
        submittedAt: r.submittedAt,
        isDuplicate: !!isDuplicate
      };
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

module.exports = router;
