const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-change-in-production';

// Regular user authentication middleware (via HTTP-only cookie)
const authRequired = (req, res, next) => {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tokenCookie = cookieHeader.split('; ').find(row => row.startsWith('token='));
    if (!tokenCookie) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = tokenCookie.split('=')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Ensure this is not an admin token being used for user endpoints
    if (decoded.aud === 'admin-panel') {
      return res.status(403).json({ error: 'Forbidden: admin account cannot access user routes' });
    }

    req.user = decoded;
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

module.exports = {
  authRequired,
  adminAuthRequired,
  JWT_SECRET
};
