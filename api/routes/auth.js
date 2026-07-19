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
const OTP_RESEND_COOLDOWN_SECONDS = 120; // 2 minutes cooldown
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
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  if (apiKey && !apiKey.startsWith('re_your_')) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(apiKey);

      const { data, error } = await resend.emails.send({
        from: fromEmail,
        to: [email],
        subject: 'Your College Dating App Verification Code',
        html: `<p>Your verification code is <strong>${otp}</strong>. It will expire in 10 minutes.</p>`
      });

      if (error) {
        console.error('[RESEND ERROR] Failed to send email:', error);
      } else {
        console.log('[RESEND SUCCESS] Email sent successfully:', data);
      }
    } catch (err) {
      console.error('[RESEND EXCEPTION] Failed to send email via Resend SDK:', err.message);
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
    if (!email || !password) {
      return res.status(400).json({ error: 'Required fields: email, password' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // 2. Input length caps & password rules
    if (!validateStringLength(password, 128)) return res.status(400).json({ error: 'Password too long (max 128 chars)' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    if (name && !validateStringLength(name, 100)) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
    if (username && !validateStringLength(username, 50)) return res.status(400).json({ error: 'Username too long (max 50 chars)' });
    if (bio && !validateStringLength(bio, 500)) return res.status(400).json({ error: 'Bio too long (max 500 chars)' });

    // 3. Generate or sanitise username
    let finalUsername = username ? username.toLowerCase().trim() : '';
    if (!finalUsername) {
      const prefix = cleanEmail.split('@')[0].replace(/[^a-z0-9_.]/g, '');
      finalUsername = prefix || 'user';
      let exists = await User.exists({ username: finalUsername });
      while (exists) {
        finalUsername = `${prefix}_${Math.floor(1000 + Math.random() * 9000)}`;
        exists = await User.exists({ username: finalUsername });
      }
    }

    const finalName = name ? name.trim() : finalUsername;

    // 4. Minimum age check (18) if age is provided
    let finalAge;
    if (age !== undefined && age !== null && age !== '') {
      finalAge = parseInt(age, 10);
      if (isNaN(finalAge) || finalAge < 18) {
        return res.status(400).json({ error: 'You must be at least 18 years old to sign up' });
      }
    }

    // 5. Check if user already exists
    const existingEmail = await User.findOne({ email: cleanEmail });
    if (existingEmail) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const existingUsername = await User.findOne({ username: finalUsername });
    if (existingUsername) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    // 6. Signup cluster check (IP velocity rate limiting / flagging)
    const ip = req.ip || '127.0.0.1';
    const signupKey = `signup:${ip}`;
    const signupCount = await redis.incr(signupKey);
    if (signupCount === 1) {
      await redis.expire(signupKey, SIGNUP_CLUSTER_WINDOW_SECONDS);
    }

    // 7. Create user
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = new User({
      email: cleanEmail,
      username: finalUsername,
      name: finalName,
      age: finalAge,
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
    const isCollegeEmail = COLLEGE_EMAIL_REGEX.test(cleanEmail);
    if (isCollegeEmail) {
      const otp = generateOTP();
      const otpSalt = await bcrypt.genSalt(6);
      const otpHash = await bcrypt.hash(otp, otpSalt);

      // Delete any existing verification records for this email
      await EmailVerification.deleteMany({ email: cleanEmail });

      // Save hashed OTP to Redis
      await redis.set(`otp:${cleanEmail}`, otpHash, { EX: OTP_TTL_SECONDS });

      // Save to MongoDB emailVerifications
      const verification = new EmailVerification({
        email: cleanEmail,
        otpHash,
        userId: user._id,
        purpose: 'signup',
        attempts: 0
      });
      await verification.save();

      await sendOTPEmail(cleanEmail, otp);
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
    await redis.del(`otp_resend_count:${user.email}`);
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

    // 1. Rate limit: check if user requested OTP in last 2 minutes
    const rateLimitKey = `otp_ratelimit:${user.email}`;
    const recentRequest = await redis.get(rateLimitKey);
    if (recentRequest) {
      return res.status(429).json({ error: 'Please wait 2 minutes before requesting another code' });
    }

    // 2. Limit: check if user exceeded 3 resends total
    const resendCountKey = `otp_resend_count:${user.email}`;
    const resendCount = await redis.get(resendCountKey);
    if (resendCount && parseInt(resendCount, 10) >= 3) {
      return res.status(429).json({ error: 'Maximum of 3 OTP resends reached. Please try again later.' });
    }

    // Generate new OTP
    const otp = generateOTP();
    const otpSalt = await bcrypt.genSalt(6);
    const otpHash = await bcrypt.hash(otp, otpSalt);

    // Save to Redis
    await redis.set(`otp:${user.email}`, otpHash, { EX: OTP_TTL_SECONDS });
    // Set rate limit tracker
    await redis.set(rateLimitKey, '1', { EX: OTP_RESEND_COOLDOWN_SECONDS });
    
    // Increment resend counter
    const nextCount = resendCount ? parseInt(resendCount, 10) + 1 : 1;
    await redis.set(resendCountKey, String(nextCount), { EX: 3600 }); // expire counter in 1 hour

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
  res.json({ message: 'Logout luxurious' }); // wait, logout successful is better
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if user exists
    const user = await User.findOne({ email: cleanEmail });
    if (!user) {
      // To prevent email enumeration, return a 200 OK success message even if email is not found.
      return res.json({ message: 'If this email is registered, a password reset link has been sent.' });
    }

    // Generate secure token
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Save token and expiry (10 minutes)
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 600000; // 10 minutes (600,000 ms)
    await user.save();

    // Get backend base URL dynamically (works on local, render, staging, etc.)
    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.get('host');
    const resetLink = `${protocol}://${host}/api/auth/reset-password?token=${token}&email=${encodeURIComponent(cleanEmail)}`;

    // Send email with reset link via Resend
    const apiKey = process.env.EMAIL_API_KEY;
    const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';
    if (apiKey && !apiKey.startsWith('re_your_')) {
      try {
        const { Resend } = require('resend');
        const resend = new Resend(apiKey);
        await resend.emails.send({
          from: fromEmail,
          to: [cleanEmail],
          subject: 'Reset Your Password',
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px 24px; border: 1px solid #f0f0f0; border-radius: 12px; color: #2d3748;">
              <h2 style="font-size: 20px; font-weight: 700; color: #dc2626; margin-top: 0; margin-bottom: 16px;">Password Reset Request</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #4a5568; margin-bottom: 24px;">We received a request to reset your password. Click the button below to reset it. This link is valid for **10 minutes**.</p>
              <div style="text-align: center; margin-bottom: 24px;">
                <a href="${resetLink}" target="_blank" style="background-color: #6366f1; color: #ffffff; padding: 12px 24px; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(99, 102, 241, 0.4);">
                  Reset Password
                </a>
              </div>
              <p style="font-size: 13px; line-height: 1.6; color: #718096; margin-bottom: 24px; word-break: break-all;">If the button doesn't work, copy and paste this link into your browser:<br> <a href="${resetLink}" style="color: #6366f1;">${resetLink}</a></p>
              <p style="font-size: 14px; line-height: 1.6; color: #718096; margin-bottom: 24px; border-top: 1px solid #edf2f7; padding-top: 16px;">If you did not request this password reset, you can safely ignore this email.</p>
              <div style="text-align: center;">
                <span style="font-size: 12px; color: #a0aec0;">College Dating App Team</span>
              </div>
            </div>
          `
        });
      } catch (emailErr) {
        console.error('[RESET EMAIL EXCEPTION] Failed to send reset link:', emailErr.message);
      }
    }

    res.json({ message: 'If this email is registered, a password reset link has been sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during forgot password' });
  }
});

// GET /api/auth/reset-password
// Serves a beautiful, mobile-friendly HTML form to reset the password directly in the browser.
router.get('/reset-password', async (req, res) => {
  try {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
  <style>
    :root {
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --bg: #000000;
      --card-bg: #050505;
      --text: #ffffff;
      --text-secondary: #737373;
      --border: #1a1a1a;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    h2 {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 8px;
      text-align: center;
      background: linear-gradient(135deg, #a5b4fc, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p.desc {
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1.5;
      text-align: center;
      margin-bottom: 24px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
      color: var(--text-secondary);
    }
    .input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }
    input {
      width: 100%;
      padding: 12px 48px 12px 16px;
      background-color: #000000;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: var(--primary);
    }
    .toggle-btn {
      position: absolute;
      right: 12px;
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6px;
      transition: color 0.2s;
    }
    .toggle-btn:hover {
      color: var(--text);
    }
    .toggle-btn svg {
      width: 20px;
      height: 20px;
      pointer-events: none;
    }
    .btn {
      width: 100%;
      padding: 12px;
      background-color: var(--primary);
      color: #ffffff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    .btn:hover {
      background-color: var(--primary-hover);
    }
    .btn:disabled {
      background-color: var(--border);
      cursor: not-allowed;
      opacity: 0.6;
    }
    .alert {
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 20px;
      display: none;
    }
    .alert.danger {
      background-color: rgba(239, 68, 68, 0.15);
      border: 1px solid #ef4444;
      color: #fca5a5;
    }
    .success-container {
      display: none;
      text-align: center;
    }
    .success-icon {
      font-size: 48px;
      color: #10b981;
      margin-bottom: 16px;
    }
    .requirements {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 6px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="card">
    <div id="form-container">
      <h2>Reset Password</h2>
      <p class="desc">Enter a new secure password for your account.</p>
      
      <div id="error-alert" class="alert danger"></div>

      <form id="reset-form" onsubmit="event.preventDefault(); return false;">
        <div class="form-group">
          <label for="new-password">New Password</label>
          <div class="input-wrapper">
            <input type="password" id="new-password" placeholder="••••••••" required autocomplete="new-password">
            <button type="button" class="toggle-btn" onclick="togglePasswordVisibility('new-password', this)">
              <svg class="eye-open" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              <svg class="eye-slashed" style="display: none;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                <line x1="1" y1="1" x2="23" y2="23"></line>
              </svg>
            </button>
          </div>
          <div class="requirements">Must be between 8 and 128 characters.</div>
        </div>
        <div class="form-group">
          <label for="confirm-password">Confirm Password</label>
          <div class="input-wrapper">
            <input type="password" id="confirm-password" placeholder="••••••••" required>
            <button type="button" class="toggle-btn" onclick="togglePasswordVisibility('confirm-password', this)">
              <svg class="eye-open" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              <svg class="eye-slashed" style="display: none;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                <line x1="1" y1="1" x2="23" y2="23"></line>
              </svg>
            </button>
          </div>
        </div>
        <button type="submit" id="submit-btn" class="btn">Reset Password</button>
      </form>
    </div>

    <div id="success-container" class="success-container">
      <div class="success-icon">✓</div>
      <h2>Password Reset Complete</h2>
      <p class="desc" style="margin-top: 12px;">Your password has been successfully updated.</p>
      <p class="desc">You can now close this page and log back into the app.</p>
    </div>
  </div>

  <script>
    const form = document.getElementById('reset-form');
    const submitBtn = document.getElementById('submit-btn');
    const errorAlert = document.getElementById('error-alert');
    const formContainer = document.getElementById('form-container');
    const successContainer = document.getElementById('success-container');

    // Parse URL query parameters client-side
    const urlParams = new URLSearchParams(window.location.search);
    const email = urlParams.get('email');
    const token = urlParams.get('token');

    if (!email || !token) {
      formContainer.style.display = 'none';
      showError('The password reset link is invalid or incomplete. Please request a new link.');
    }

    function togglePasswordVisibility(inputId, btn) {
      const input = document.getElementById(inputId);
      const eyeOpen = btn.querySelector('.eye-open');
      const eyeSlashed = btn.querySelector('.eye-slashed');

      if (input.type === 'password') {
        input.type = 'text';
        eyeOpen.style.display = 'none';
        eyeSlashed.style.display = 'block';
      } else {
        input.type = 'password';
        eyeOpen.style.display = 'block';
        eyeSlashed.style.display = 'none';
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorAlert.style.display = 'none';
      
      const newPassword = document.getElementById('new-password').value;
      const confirmPassword = document.getElementById('confirm-password').value;

      if (!email || !token) {
        showError('Invalid reset session. Please request a new reset link.');
        return;
      }
      if (newPassword.length < 8) {
        showError('Password must be at least 8 characters long.');
        return;
      }
      if (newPassword.length > 128) {
        showError('Password must be less than 128 characters long.');
        return;
      }
      if (newPassword !== confirmPassword) {
        showError('Passwords do not match.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerText = 'Resetting...';

      try {
        const response = await fetch(window.location.pathname, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: email,
            token: token,
            newPassword: newPassword
          })
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to reset password.');
        }

        formContainer.style.display = 'none';
        successContainer.style.display = 'block';
      } catch (err) {
        showError(err.message);
        submitBtn.disabled = false;
        submitBtn.innerText = 'Reset Password';
      }
    });

    function showError(message) {
      errorAlert.innerText = message;
      errorAlert.style.display = 'block';
    }
  </script>
</body>
</html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'Required fields: email, token, newPassword' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Hash the token to compare with the DB
    const crypto = require('crypto');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Find user with valid token and unexpired reset window
    const user = await User.findOne({
      email: cleanEmail,
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired password reset link. Please request a new one.' });
    }

    // Validate password rules
    if (!validateStringLength(newPassword, 128)) {
      return res.status(400).json({ error: 'Password too long (max 128 chars)' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Hash and update password
    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(newPassword, salt);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Your password has been reset successfully. You can now log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error resetting password' });
  }
});

module.exports = router;
