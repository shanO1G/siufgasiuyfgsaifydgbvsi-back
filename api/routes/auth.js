const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AccountFlag = require('../models/AccountFlag');
const EmailVerification = require('../models/EmailVerification');
const redis = require('../utils/redis');
const { authRequired, JWT_SECRET } = require('../middleware/auth');

// Domain regex for college email check
const COLLEGE_EMAIL_REGEX = /@stu\.adamasuniversity\.ac\.in$/i;

// Constants
const OTP_ATTEMPTS_LIMIT = 5;
const BRUTE_FORCE_THRESHOLD = 5;
const BRUTE_FORCE_WINDOW_SECONDS = 900; // 15 min
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_TTL_SECONDS = 600; // 10 min
const SIGNUP_CLUSTER_THRESHOLD = 5;
const SIGNUP_CLUSTER_WINDOW_SECONDS = 3600;

// Helper to generate a 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper to send email OTP (console fallback + Resend API if configured)
async function sendOTPEmail(email, otp) {
  console.log(`\n==================================================`);
  console.log(`[EMAIL OTP] To: ${email} | OTP Code: ${otp}`);
  console.log(`==================================================\n`);

  const apiKey = process.env.EMAIL_API_KEY;
  const fromEmail = process.env.EMAIL_FROM || 'noreply@stu.adamasuniversity.ac.in';

  if (apiKey && !apiKey.startsWith('re_your_')) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromEmail,
          to: email,
          subject: 'Your College Dating App Verification Code',
          html: `<p>Your verification code is <strong>${otp}</strong>. It will expire in 10 minutes.</p>`
        })
      });
    } catch (err) {
      console.error('Failed to send email via Resend API:', err.message);
    }
  }
}

// Input length validation helper
function validateStringLength(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength;
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, username, password, name, age, gender, lookingFor, bio } = req.body;

    // 1. Basic presence validation
    if (!email || !username || !password || !name || age === undefined) {
      return res.status(400).json({ error: 'Required fields: email, username, password, name, age' });
    }

    // 2. Input length caps
    if (!validateStringLength(password, 128)) return res.status(400).json({ error: 'Password too long (max 128 chars)' });
    if (!validateStringLength(name, 100)) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
    if (!validateStringLength(username, 50)) return res.status(400).json({ error: 'Username too long (max 50 chars)' });
    if (bio && !validateStringLength(bio, 500)) return res.status(400).json({ error: 'Bio too long (max 500 chars)' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // 3. Minimum age check (18)
    if (parseInt(age, 10) < 18) {
      return res.status(400).json({ error: 'You must be at least 18 years old to sign up' });
    }

    // 4. Check if user already exists
    const existingUser = await User.findOne({ $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Email or username already registered' });
    }

    // 5. Signup cluster check (IP velocity rate limiting / flagging)
    const ip = req.ip || '127.0.0.1';
    const signupKey = `signup:${ip}`;
    const signupCount = await redis.incr(signupKey);
    if (signupCount === 1) {
      await redis.expire(signupKey, SIGNUP_CLUSTER_WINDOW_SECONDS);
    }

    // 6. Create user
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = new User({
      email: email.toLowerCase().trim(),
      username: username.toLowerCase().trim(),
      name: name.trim(),
      age: parseInt(age, 10),
      gender,
      lookingFor,
      bio: bio ? bio.trim() : '',
      passwordHash,
      emailVerified: false,
      identityStatus: 'not_submitted'
    });

    await user.save();

    // 7. Flag if signup cluster threshold exceeded
    if (signupCount > SIGNUP_CLUSTER_THRESHOLD) {
      const flag = new AccountFlag({
        userId: user._id,
        flagType: 'signup_cluster',
        severity: 'medium',
        details: { ip, count: signupCount },
        status: 'open'
      });
      await flag.save();
      await User.findByIdAndUpdate(user._id, { $inc: { openFlagCount: 1 } });
    }

    // 8. OTP generation if college email matched
    const isCollegeEmail = COLLEGE_EMAIL_REGEX.test(email);
    if (isCollegeEmail) {
      const otp = generateOTP();
      const otpSalt = await bcrypt.genSalt(6);
      const otpHash = await bcrypt.hash(otp, otpSalt);

      // Delete any existing verification records for this email
      await EmailVerification.deleteMany({ email: user.email });

      // Save hashed OTP to Redis
      await redis.set(`otp:${user.email}`, otpHash, { EX: OTP_TTL_SECONDS });

      // Save to MongoDB emailVerifications
      const verification = new EmailVerification({
        email: user.email,
        otpHash,
        userId: user._id,
        purpose: 'signup',
        attempts: 0
      });
      await verification.save();

      await sendOTPEmail(user.email, otp);
    }

    // 9. Generate token & login user automatically upon signup
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(201).json({
      message: 'Signup successful',
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        name: user.name,
        emailVerified: user.emailVerified,
        identityStatus: user.identityStatus
      },
      otpSent: isCollegeEmail
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', authRequired, async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) {
      return res.status(400).json({ error: 'OTP is required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!COLLEGE_EMAIL_REGEX.test(user.email)) {
      return res.status(400).json({ error: 'Verification only required for college emails' });
    }

    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }

    // 1. Fetch the Mongo verification record (single source of truth for attempts)
    const dbVerification = await EmailVerification.findOne({ email: user.email }).sort({ createdAt: -1 });
    if (!dbVerification) {
      return res.status(400).json({ error: 'OTP expired or not found. Please resend.' });
    }

    // 2. Check attempt limit BEFORE incrementing
    if (dbVerification.attempts >= OTP_ATTEMPTS_LIMIT) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new OTP.' });
    }

    // 3. Increment attempts atomically
    dbVerification.attempts += 1;
    await dbVerification.save();

    // 4. Fetch the hash: prefer Redis (fresher), fall back to Mongo
    let otpHash;
    const redisOtp = await redis.get(`otp:${user.email}`);
    if (redisOtp) {
      otpHash = redisOtp;
    } else {
      otpHash = dbVerification.otpHash;
    }

    // 5. Compare OTP
    const isMatch = await bcrypt.compare(otp, otpHash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Incorrect verification code' });
    }

    // 6. Update user verification status
    user.emailVerified = true;
    await user.save();

    // 7. Clean up verification records
    await redis.del(`otp:${user.email}`);
    await dbVerification.deleteOne();

    res.json({ message: 'Email verified successfully', emailVerified: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during OTP verification' });
  }
});

// POST /api/auth/resend-otp
router.post('/resend-otp', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!COLLEGE_EMAIL_REGEX.test(user.email)) {
      return res.status(400).json({ error: 'Only college emails require verification' });
    }

    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }

    // Rate limit: check if user requested OTP in last 60 seconds
    const rateLimitKey = `otp_ratelimit:${user.email}`;
    const recentRequest = await redis.get(rateLimitKey);
    if (recentRequest) {
      return res.status(429).json({ error: 'Please wait 60 seconds before requesting another code' });
    }

    // Generate new OTP
    const otp = generateOTP();
    const otpSalt = await bcrypt.genSalt(6);
    const otpHash = await bcrypt.hash(otp, otpSalt);

    // Save to Redis
    await redis.set(`otp:${user.email}`, otpHash, { EX: OTP_TTL_SECONDS });
    // Set rate limit tracker
    await redis.set(rateLimitKey, '1', { EX: OTP_RESEND_COOLDOWN_SECONDS });

    // Replace Mongo record with fresh one (reset attempts)
    await EmailVerification.deleteMany({ email: user.email });
    const verification = new EmailVerification({
      email: user.email,
      otpHash,
      userId: user._id,
      purpose: 'reverify',
      attempts: 0
    });
    await verification.save();

    await sendOTPEmail(user.email, otp);

    res.json({ message: 'Verification code sent successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during OTP resend' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { identity, password } = req.body; // identity can be email or username
    if (!identity || !password) {
      return res.status(400).json({ error: 'Required: identity (email/username) and password' });
    }

    const cleanIdentity = identity.trim().toLowerCase();

    // 1. Find user first
    const user = await User.findOne({
      $or: [{ email: cleanIdentity }, { username: cleanIdentity }]
    });

    // 2. Compare password (always run bcrypt to prevent timing attacks)
    const dummyHash = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    const passwordMatch = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, dummyHash); // constant-time dummy compare

    if (!user || !passwordMatch) {
      // Only increment failed-login counter on actual failure
      const bruteKey = `failedLogin:${cleanIdentity}`;
      const failedAttempts = await redis.incr(bruteKey);
      if (failedAttempts === 1) {
        await redis.expire(bruteKey, BRUTE_FORCE_WINDOW_SECONDS);
      }

      // Flag if threshold exceeded (only when user actually exists)
      if (user && failedAttempts >= BRUTE_FORCE_THRESHOLD) {
        const flag = new AccountFlag({
          userId: user._id,
          flagType: 'login_brute_force',
          severity: 'medium',
          details: { identity: cleanIdentity, attempts: failedAttempts },
          status: 'open'
        });
        await flag.save();
        await User.findByIdAndUpdate(user._id, { $inc: { openFlagCount: 1 } });
      }

      return res.status(401).json({ error: 'Invalid username/email or password' });
    }

    // Check if user is banned
    if (user.banned) {
      return res.status(403).json({ error: `Your account has been banned: ${user.banReason || 'No reason specified'}` });
    }

    // On successful login, clear failed attempts
    await redis.del(`failedLogin:${cleanIdentity}`);

    // 3. Issue token
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      message: 'Login successful',
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        name: user.name,
        emailVerified: user.emailVerified,
        identityStatus: user.identityStatus
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// POST /api/auth/logout
router.post('/logout', authRequired, (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  });
  res.json({ message: 'Logout successful' });
});

module.exports = router;
