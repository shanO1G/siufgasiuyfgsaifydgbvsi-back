const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Admin = require('../models/Admin');
const User = require('../models/User');
const redis = require('../utils/redis');

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('FATAL: JWT_SECRET environment variable is missing in production mode.');
}

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-change-in-production';

// Regular user authentication middleware (via HTTP-only cookie or Authorization header fallback)
const authRequired = async (req, res, next) => {
  try {
    let token;

    // A. Try reading cookie
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const cookies = cookieHeader.split(';');
      for (const cookie of cookies) {
        const parts = cookie.trim().split('=');
        if (parts[0] === 'token' && parts.length >= 2) {
          token = parts.slice(1).join('=');
          break;
        }
      }
    }

    // B. Try reading Authorization header (handy fallback for development & API testing)
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.token = token;

    // Check if token has been blacklisted upon logout
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const isBlacklisted = await redis.get(`blacklist:${tokenHash}`).catch(() => null);
    if (isBlacklisted) {
      return res.status(401).json({ error: 'Session invalidated. Please log in again.' });
    }

    // Ensure this is not an admin token being used for user endpoints
    if (decoded.aud === 'admin-panel') {
      return res.status(403).json({ error: 'Forbidden: admin account cannot access user routes' });
    }

    // Fast ban & password change check using Redis cache, falling back to Mongo
    const cacheKey = `user_auth_status:${decoded.id}`;
    let isBanned = null;
    let emailVerified = null;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parts = cached.split(':');
        isBanned = parts[0];
        emailVerified = parts[1];
      }
    } catch (e) {
      // Redis fallback
    }

    if (isBanned === null || isBanned === undefined || emailVerified === undefined) {
      const user = await User.findById(decoded.id).select('banned passwordChangedAt emailVerified').lean();
      if (!user) {
        return res.status(401).json({ error: 'User account not found' });
      }

      if (user.passwordChangedAt && decoded.iat) {
        const passwordChangedTime = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
        if (decoded.iat < passwordChangedTime) {
          return res.status(401).json({ error: 'Password was recently changed. Please log in again.' });
        }
      }

      isBanned = user.banned ? '1' : '0';
      emailVerified = user.emailVerified ? '1' : '0';
      try {
        await redis.set(cacheKey, `${isBanned}:${emailVerified}`, { EX: 300 });
      } catch (e) {
        // Redis cache write fallback
      }
    }

    if (isBanned === '1' || isBanned === true) {
      return res.status(403).json({ error: 'Your account has been suspended.' });
    }

    req.user = {
      ...decoded,
      emailVerified: emailVerified === '1'
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Admin authentication middleware (via Authorization Bearer header)
const adminAuthRequired = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify audience claim
    if (decoded.aud !== 'admin-panel') {
      return res.status(403).json({ error: 'Invalid token audience' });
    }

    // Verify admin exists and is active
    const admin = await Admin.findById(decoded.id);
    if (!admin || !admin.active) {
      return res.status(403).json({ error: 'Admin account is inactive or does not exist' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
};

const verifiedAuthRequired = async (req, res, next) => {
  await authRequired(req, res, () => {
    if (!req.user.emailVerified) {
      return res.status(403).json({ error: 'Email verification required to access this resource.' });
    }
    next();
  });
};

module.exports = {
  authRequired,
  adminAuthRequired,
  verifiedAuthRequired,
  JWT_SECRET
};
