const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const AccountFlag = require('../models/AccountFlag');
const EmailVerification = require('../models/EmailVerification');
const redis = require('../utils/redis');
const { authRequired, JWT_SECRET } = require('../middleware/auth');
const emailService = require('../utils/emailService');

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

// Helper to generate a 6-digit OTP using cryptographically secure random bytes
function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

// Helper to hash OTP using SHA-256 for fast, low-CPU verification
function hashOTP(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function verifyOTP(inputOtp, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const inputHash = hashOTP(inputOtp);
  if (inputHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(storedHash));
}

// Helper to send email OTP (console fallback + emailService pool with automatic retry & failover)
async function sendOTPEmail(email, otp) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`\n==================================================`);
    console.log(`[DEV OTP] To: ${email} | OTP Code: ${otp}`);
    console.log(`==================================================\n`);
  }

  const subject = 'Your FRND Verification Code';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        @media only screen and (max-width: 600px) {
          .email-container { padding: 20px 16px !important; border-radius: 16px !important; }
          .email-header { padding: 20px 16px 16px !important; }
          .email-body { padding: 24px 18px !important; }
          .email-title { font-size: 22px !important; margin-bottom: 12px !important; }
          .otp-box { margin: 18px 0 !important; padding: 14px 12px !important; }
          .otp-code { font-size: 28px !important; letter-spacing: 0.18em !important; }
          .email-footer { padding: 18px 16px !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #FDF6EA;">
      <div style="background-color: #FDF6EA; padding: 24px 12px; font-family: 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
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
          <div class="email-body" style="padding: 28px 24px;">
            <h1 class="email-title" style="margin: 0 0 14px; font-size: 22px; font-weight: 900; color: #040404; text-transform: uppercase; letter-spacing: -0.02em; line-height: 1.2;">
              VERIFICATION <span style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; color: #A41534; text-transform: lowercase; font-weight: normal;">code.</span>
            </h1>

            <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.55; color: #3A2F2D; font-weight: 500;">
              Use the verification code below to complete your sign-in to FRND:
            </p>

            <!-- OTP Code Box -->
            <div class="otp-box" style="margin: 20px 0; text-align: center; background-color: #FDF4E5; border: 2px solid #040404; border-radius: 14px; padding: 16px 12px; box-shadow: 3px 3px 0px #040404;">
              <span class="otp-code" style="font-family: monospace, Courier, sans-serif; font-size: 32px; font-weight: 900; letter-spacing: 0.2em; color: #A41534; display: inline-block; margin-left: 0.2em;">
                ${otp}
              </span>
            </div>

            <p style="margin: 0 0 18px; font-size: 13px; line-height: 1.5; color: #665853; font-weight: 500;">
              This code will expire in <strong>10 minutes</strong>. If you did not request this code, you can safely ignore this message.
            </p>

            <p style="margin: 0; font-size: 14px; line-height: 1.55; color: #040404; font-weight: 700;">
              Best,<br>
              The FRND Team
            </p>
          </div>

          <!-- Dark Charcoal Footer -->
          <div class="email-footer" style="padding: 18px 24px; background-color: #040404; color: #FEFDFD; text-align: center;">
            <p style="margin: 0; font-size: 11px; line-height: 1.5; color: #E3D9CF;">
              You're receiving this email to verify your FRND account.
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

  const text = `Verification Code\n\nUse the verification code below to complete your sign-in to FRND:\n\n${otp}\n\nThis code will expire in 10 minutes. If you did not request this code, you can safely ignore this message.\n\nBest,\nThe FRND Team`;

  await emailService.sendEmail({ to: email, subject, text, html });
}

// Input length validation helper
function validateStringLength(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength;
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, username, password, name, age, gender, lookingFor, bio, religion, beliefs } = req.body;

    // 1. Basic presence & type validation
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Required fields: email, password (must be strings)' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const isCollegeEmail = COLLEGE_EMAIL_REGEX.test(cleanEmail);

    // 2. Input length caps & password rules
    if (!validateStringLength(password, 128)) return res.status(400).json({ error: 'Password too long (max 128 chars)' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    if (name && !validateStringLength(name, 100)) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
    if (username && !validateStringLength(username, 50)) return res.status(400).json({ error: 'Username too long (max 50 chars)' });
    if (bio && !validateStringLength(bio, 500)) return res.status(400).json({ error: 'Bio too long (max 500 chars)' });
    if (religion && !validateStringLength(religion, 100)) return res.status(400).json({ error: 'Religion too long (max 100 chars)' });
    if (beliefs && !validateStringLength(beliefs, 200)) return res.status(400).json({ error: 'Beliefs too long (max 200 chars)' });

    // 3. Generate or sanitise username
    let finalUsername = username ? username.toLowerCase().trim() : '';
    if (!finalUsername) {
      const prefix = cleanEmail.split('@')[0].replace(/[^a-z0-9_.]/g, '') || 'user';
      finalUsername = prefix;
      let exists = await User.exists({ username: finalUsername });
      let attempts = 0;
      while (exists && attempts < 5) {
        finalUsername = `${prefix}_${crypto.randomInt(1000, 10000)}`;
        exists = await User.exists({ username: finalUsername });
        attempts++;
      }
      if (exists) {
        finalUsername = `${prefix}_${Date.now().toString(36)}`;
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

    // 5. Check if user already exists (in parallel using boolean exists checks)
    const [existingEmail, existingUsername] = await Promise.all([
      User.exists({ email: cleanEmail }),
      User.exists({ username: finalUsername })
    ]);

    if (existingEmail) {
      return res.status(400).json({ error: 'Email already registered' });
    }

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
      religion: religion ? religion.trim() : '',
      beliefs: beliefs ? beliefs.trim() : '',
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

    // 8. OTP generation for all user signups (fast SHA-256 hash)
    const otp = generateOTP();
    const otpHash = hashOTP(otp);

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

    // 9. Generate token & login user automatically upon signup
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
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
      otpSent: true
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

    // 5. Compare OTP (SHA-256 constant-time comparison)
    const isMatch = verifyOTP(otp, otpHash);
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

    // Generate new OTP (fast SHA-256 hash)
    const otp = generateOTP();
    const otpHash = hashOTP(otp);

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
    if (!identity || !password || typeof identity !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Required: identity (email/username) and password must be non-empty strings' });
    }

    const cleanIdentity = identity.trim().toLowerCase();

    // 0. Pre-bcrypt rate-limit check: block locked identities before burning heavy CPU cycles
    const bruteIdentityKey = `failedLogin:identity:${cleanIdentity}`;
    const initialAttemptsStr = await redis.get(bruteIdentityKey).catch(() => null);
    const initialAttempts = initialAttemptsStr ? parseInt(initialAttemptsStr, 10) : 0;
    if (initialAttempts >= BRUTE_FORCE_THRESHOLD) {
      return res.status(429).json({ error: 'Too many failed login attempts. Please try again in 15 minutes.' });
    }

    // 1. Find user
    const user = await User.findOne({
      $or: [{ email: cleanIdentity }, { username: cleanIdentity }]
    });

    if (user) {
      const bruteUserKey = `failedLogin:user:${user._id}`;
      const userAttemptsStr = await redis.get(bruteUserKey).catch(() => null);
      const userAttempts = userAttemptsStr ? parseInt(userAttemptsStr, 10) : 0;
      if (userAttempts >= BRUTE_FORCE_THRESHOLD) {
        return res.status(429).json({ error: 'Too many failed login attempts. Please try again in 15 minutes.' });
      }
    }

    // 2. Compare password (always run bcrypt to prevent timing attacks)
    const dummyHash = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    const passwordMatch = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, dummyHash); // constant-time dummy compare

    if (!user || !passwordMatch) {
      // Track failed attempts by user ID if user exists, otherwise by identity
      const trackerKey = user ? `user:${user._id}` : `identity:${cleanIdentity}`;
      const bruteKey = `failedLogin:${trackerKey}`;
      const failedAttempts = await redis.incr(bruteKey);
      if (failedAttempts === 1) {
        await redis.expire(bruteKey, BRUTE_FORCE_WINDOW_SECONDS);
      }

      // Flag & block if threshold exceeded
      if (failedAttempts >= BRUTE_FORCE_THRESHOLD) {
        if (user) {
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
        return res.status(429).json({ error: 'Too many failed login attempts. Please try again in 15 minutes.' });
      }

      return res.status(401).json({ error: 'Invalid username/email or password' });
    }

    // Check if user is banned
    if (user.banned) {
      return res.status(403).json({ error: `Your account has been banned: ${user.banReason || 'No reason specified'}` });
    }

    // On successful login, clear failed attempts
    await redis.del(`failedLogin:user:${user._id}`, `failedLogin:identity:${cleanIdentity}`).catch(() => {});

    // 3. Issue token
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
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
router.post('/logout', authRequired, async (req, res) => {
  try {
    let token = req.token;
    if (!token) {
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
      if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          token = authHeader.split(' ')[1];
        }
      }
    }

    if (token) {
      const decoded = jwt.decode(token);
      if (decoded && decoded.exp) {
        const remainingSeconds = Math.max(1, Math.ceil((decoded.exp * 1000 - Date.now()) / 1000));
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await redis.set(`blacklist:${tokenHash}`, '1', { EX: remainingSeconds }).catch(() => {});
      }
    }
  } catch (err) {
    // Non-blocking logout error
  }

  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });
  res.json({ message: 'Logout successful' });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    // Rate limit: max 3 reset requests per IP per 15 minutes
    const ip = req.ip || '127.0.0.1';
    const resetRateKey = `pwreset_ip:${ip}`;
    const resetCount = await redis.incr(resetRateKey);
    if (resetCount === 1) await redis.expire(resetRateKey, 900);
    if (resetCount > 3) {
      return res.status(429).json({ error: 'Too many password reset requests. Please try again in 15 minutes.' });
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

    // Get backend base URL dynamically (or prefer configured APP_URL env variable)
    const baseUrl = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')}://${req.get('host')}`;
    const resetLink = `${baseUrl}/api/auth/reset-password?token=${token}&email=${encodeURIComponent(cleanEmail)}`;

    // Send email with reset link via Resend emailService pool
    const subject = '🔑 Reset Your FRND Password';
    const html = `
      <div style="background-color: #FDF4E5; padding: 40px 16px; font-family: 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100%;">
        <div style="max-width: 560px; margin: 0 auto; background-color: #FEFDFD; border: 2px solid #040404; border-radius: 24px; box-shadow: 4px 6px 0px #040404; overflow: hidden;">
          
          <!-- Header Branding -->
          <div style="padding: 32px 32px 24px; border-bottom: 2px solid #FDF4E5; background-color: #FEFDFD; text-align: center;">
            <h2 style="margin: 0; font-size: 32px; font-weight: 900; letter-spacing: -0.04em; color: #040404; text-transform: uppercase;">
              FR<span style="color: #A41534;">ND</span>
            </h2>
            <p style="margin: 4px 0 0; font-family: Georgia, serif; font-style: italic; color: #A41534; font-size: 15px;">
              Campus friends, made intentional.
            </p>
          </div>

          <!-- Body Content -->
          <div style="padding: 32px;">
            <h1 style="margin: 0 0 18px; font-size: 24px; font-weight: 800; color: #040404; text-transform: uppercase; letter-spacing: -0.02em; line-height: 1.25;">
              Password Reset Request 🔑
            </h1>

            <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.65; color: #3A2F2D; font-weight: 500;">
              We received a request to reset your password. Click the button below to set a new password. This link is valid for <strong>10 minutes</strong>.
            </p>

            <!-- Reset Button -->
            <div style="margin: 24px 0; text-align: left;">
              <a href="${resetLink}" target="_blank"
                 style="display: inline-block; background-color: #A41534; color: #FEFDFD; text-decoration: none; padding: 14px 28px; border-radius: 9999px; font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: 0.12em; border: 2px solid #040404; box-shadow: 3px 3px 0px #040404;">
                Reset Password →
              </a>
            </div>

            <p style="margin: 20px 0 0; font-size: 13px; line-height: 1.6; color: #665853; word-break: break-all;">
              If the button doesn't work, copy and paste this URL into your browser:<br>
              <a href="${resetLink}" style="color: #A41534; font-weight: 600;">${resetLink}</a>
            </p>
          </div>

          <!-- Footer -->
          <div style="padding: 24px 32px; background-color: #040404; color: #FEFDFD;">
            <p style="margin: 0; font-size: 12px; line-height: 1.6; color: #E3D9CF;">
              If you didn't request a password reset, you can safely ignore this email.
            </p>

            <p style="margin: 8px 0 0; font-size: 12px; line-height: 1.6; color: #E3D9CF;">
              Need help? Contact
              <a href="mailto:contact@frnd.buzz" style="color: #A41534; text-decoration: none; font-weight: 700;">contact@frnd.buzz</a>.
            </p>

            <p style="margin: 14px 0 0; font-size: 11px; color: #8B7B74; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">
              © ${new Date().getFullYear()} FRND. All rights reserved.
            </p>
          </div>

        </div>
      </div>
    `;

    await emailService.sendEmail({ to: cleanEmail, subject, html });

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
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'`);
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

  <script nonce="${nonce}">
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
    if (!email || !token || !newPassword || typeof email !== 'string' || typeof token !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Required fields: email, token, newPassword (must be non-empty strings)' });
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
    user.passwordChangedAt = new Date();
    await user.save();

    res.json({ message: 'Your password has been reset successfully. You can now log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error resetting password' });
  }
});

// POST /api/auth/fcm-token
// Register a new FCM device token for the authenticated user
router.post('/fcm-token', authRequired, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.fcmTokens) {
      user.fcmTokens = [];
    }

    if (!user.fcmTokens.includes(token)) {
      user.fcmTokens.push(token);
      await user.save();
    }

    res.json({ message: 'Token registered successfully' });
  } catch (err) {
    console.error('[FCM] Error registering token:', err);
    res.status(500).json({ error: 'Server error registering token' });
  }
});

// DELETE /api/auth/fcm-token
// Remove an FCM device token for the authenticated user (e.g., on logout)
router.delete('/fcm-token', authRequired, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.fcmTokens && user.fcmTokens.includes(token)) {
      user.fcmTokens = user.fcmTokens.filter(t => t !== token);
      await user.save();
    }

    res.json({ message: 'Token removed successfully' });
  } catch (err) {
    console.error('[FCM] Error removing token:', err);
    res.status(500).json({ error: 'Server error removing token' });
  }
});

module.exports = router;
