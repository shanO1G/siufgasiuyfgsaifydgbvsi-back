const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const User = require('../models/User');
const Payment = require('../models/Payment');
const redis = require('../utils/redis');
const { authRequired } = require('../middleware/auth');

// Helper to initialize Razorpay SDK
function getRazorpayInstance() {
  const key_id = process.env.RAZORPAY_KEY_ID || 'rzp_test_your_key_id';
  const key_secret = process.env.RAZORPAY_KEY_SECRET || 'your_razorpay_key_secret';
  return {
    instance: new Razorpay({ key_id, key_secret }),
    key_id,
    key_secret
  };
}

// Tier Autopay Subscription Configuration (28-day recurring cycles)
const TIER_CONFIG = {
  free: {
    tier: 'free',
    name: 'Free Tier',
    priceINR: 0,
    pricePaise: 0,
    period: 'monthly',
    interval: 1,
    validityDays: 28,
    likesLimit: 15,
    superlikesLimit: 3,
    profileBoost: 1,
    isAutopay: false
  },
  silver: {
    tier: 'silver',
    name: 'Silver Pass Autopay',
    priceINR: 39,
    pricePaise: 3900,
    period: 'monthly',
    interval: 1,
    validityDays: 28,
    likesLimit: 25,
    superlikesLimit: 6,
    profileBoost: 3,
    isAutopay: true
  },
  gold: {
    tier: 'gold',
    name: 'Gold Pass Autopay',
    priceINR: 49,
    pricePaise: 4900,
    period: 'monthly',
    interval: 1,
    validityDays: 28,
    likesLimit: 50,
    superlikesLimit: 12,
    profileBoost: 6,
    isAutopay: true
  }
};

// GET /api/payments/tiers (Public details on available subscription tiers)
router.get('/tiers', (req, res) => {
  res.json({
    currency: 'INR',
    billingCycle: '28 Days Autopay Recurring',
    tiers: TIER_CONFIG
  });
});

// Helper: Ensure or create Razorpay Plan ID for recurring Autopay
async function getOrCreateRazorpayPlan(razorpay, tier) {
  const tierInfo = TIER_CONFIG[tier];
  if (!tierInfo || !tierInfo.isAutopay) {
    throw new Error('Invalid tier for subscription');
  }

  // Pre-configured environment plan IDs if provided
  const envPlanId = tier === 'gold' ? process.env.RAZORPAY_GOLD_PLAN_ID : process.env.RAZORPAY_SILVER_PLAN_ID;
  if (envPlanId) return envPlanId;

  try {
    const plan = await razorpay.plans.create({
      period: 'monthly',
      interval: 1,
      item: {
        name: tierInfo.name,
        amount: tierInfo.pricePaise,
        currency: 'INR',
        description: `${tierInfo.name} - 28 days recurring subscription`
      }
    });
    return plan.id;
  } catch (err) {
    console.warn(`[RAZORPAY PLAN CREATION NOTICE]: ${err.message}. Using dynamic plan ID.`);
    return `plan_${tier}_${tierInfo.pricePaise}`;
  }
}

// Handler: Create Razorpay Autopay Subscription
async function createSubscriptionHandler(req, res) {
  try {
    const { tier } = req.body;
    if (!tier || !['silver', 'gold'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid subscription tier. Choose "silver" or "gold".' });
    }

    const tierDetails = TIER_CONFIG[tier];
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { instance, key_id, key_secret } = getRazorpayInstance();

    let razorpaySubscriptionId;
    let planId;
    let isSimulated = false;

    if (!key_id.startsWith('rzp_test_your_') && !key_secret.startsWith('your_')) {
      planId = await getOrCreateRazorpayPlan(instance, tier);
      const subscriptionOptions = {
        plan_id: planId,
        total_count: 120, // 10 years max recurring cycles
        quantity: 1,
        customer_notify: 1,
        notes: {
          userId: user._id.toString(),
          userEmail: user.email,
          tier: tier
        }
      };
      const subscription = await instance.subscriptions.create(subscriptionOptions);
      razorpaySubscriptionId = subscription.id;
    } else {
      // Simulated Razorpay Autopay Subscription for dev/test mode
      isSimulated = true;
      planId = `plan_sim_${tier}_${tierDetails.pricePaise}`;
      razorpaySubscriptionId = `sub_sim_${tier}_${Date.now()}_${crypto.randomInt(1000, 10000)}`;
    }

    // Record Subscription Payment intent in DB
    const payment = new Payment({
      userId: user._id,
      tier,
      amount: tierDetails.priceINR,
      amountPaise: tierDetails.pricePaise,
      currency: 'INR',
      razorpaySubscriptionId,
      planId,
      isAutopay: true,
      status: 'created'
    });
    await payment.save();

    res.status(201).json({
      message: 'Razorpay Autopay Subscription initialized successfully',
      subscriptionId: razorpaySubscriptionId,
      planId,
      amount: tierDetails.pricePaise,
      amountINR: tierDetails.priceINR,
      currency: 'INR',
      keyId: key_id,
      tier: tier,
      tierName: tierDetails.name,
      validityDays: tierDetails.validityDays,
      isAutopay: true,
      isSimulated
    });
  } catch (err) {
    console.error('[RAZORPAY CREATE SUBSCRIPTION ERROR]:', err);
    res.status(500).json({ error: 'Failed to create Razorpay subscription' });
  }
}

// POST /api/payments/create-subscription and alias /create-order
router.post('/create-subscription', authRequired, createSubscriptionHandler);
router.post('/create-order', authRequired, createSubscriptionHandler);

// Handler: Verify Razorpay Autopay signature & activate 28-day recurring plan
async function verifySubscriptionHandler(req, res) {
  try {
    // Support legacy field alias
    if (!req.body.razorpay_subscription_id && req.body.razorpay_order_id) {
      req.body.razorpay_subscription_id = req.body.razorpay_order_id;
    }

    const { razorpay_subscription_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_subscription_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing required parameters: razorpay_subscription_id, razorpay_payment_id, and razorpay_signature are required' });
    }

    // Find payment subscription record
    const payment = await Payment.findOne({ razorpaySubscriptionId: razorpay_subscription_id, userId: req.user.id });
    if (!payment) {
      return res.status(404).json({ error: 'Subscription record not found' });
    }

    // Rate limit: max 5 verification attempts per user per 15 minutes
    const verifyRateKey = `payment_verify:${req.user.id}`;
    const verifyCount = await redis.incr(verifyRateKey);
    if (verifyCount === 1) await redis.expire(verifyRateKey, 900);
    if (verifyCount > 5) {
      return res.status(429).json({ error: 'Too many verification attempts. Please wait 15 minutes.' });
    }

    const { key_secret } = getRazorpayInstance();

    // HMAC Signature Validation for Razorpay Subscriptions
    const body = razorpay_payment_id + '|' + razorpay_subscription_id;
    const expectedSignature = crypto
      .createHmac('sha256', key_secret)
      .update(body.toString())
      .digest('hex');

    let isValid = false;
    if (typeof razorpay_signature === 'string' && razorpay_signature.length === expectedSignature.length) {
      isValid = crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(razorpay_signature));
    }

    if (!isValid) {
      payment.status = 'failed';
      await payment.save();
      return res.status(400).json({ error: 'Invalid subscription signature. Verification failed.' });
    }

    // Set 28 Days Expiry
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);

    payment.status = 'active';
    payment.razorpayPaymentId = razorpay_payment_id || payment.razorpayPaymentId || `pay_sim_${Date.now()}`;
    payment.razorpaySignature = razorpay_signature || 'simulated_sig';
    payment.activatedAt = now;
    payment.expiresAt = expiresAt;
    await payment.save();

    // Upgrade User to Silver or Gold with active Autopay
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          tier: payment.tier,
          isPremium: true,
          subscriptionExpiresAt: expiresAt,
          razorpaySubscriptionId: payment.razorpaySubscriptionId,
          razorpayPaymentId: payment.razorpayPaymentId,
          autopayStatus: 'active'
        }
      },
      { new: true }
    ).select('-passwordHash');

    // Invalidate discovery & profile caches for updated subscription status
    await redis.del(`user:profile:${req.user.id}`).catch(() => {});

    res.json({
      message: `🎉 ${TIER_CONFIG[payment.tier].name} activated! Autopay will automatically renew every 28 days.`,
      tier: updatedUser.tier,
      isPremium: updatedUser.isPremium,
      autopayStatus: updatedUser.autopayStatus,
      subscriptionExpiresAt: updatedUser.subscriptionExpiresAt,
      limits: TIER_CONFIG[updatedUser.tier]
    });
  } catch (err) {
    console.error('[RAZORPAY VERIFY SUBSCRIPTION ERROR]:', err);
    res.status(500).json({ error: 'Server error verifying subscription' });
  }
}

// POST /api/payments/verify-subscription and alias /verify
router.post('/verify-subscription', authRequired, verifySubscriptionHandler);
router.post('/verify', authRequired, verifySubscriptionHandler);

// POST /api/payments/cancel-subscription (Cancel Autopay recurring subscription)
router.post('/cancel-subscription', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || !user.razorpaySubscriptionId) {
      return res.status(400).json({ error: 'No active autopay subscription found to cancel' });
    }

    const { instance, key_id, key_secret } = getRazorpayInstance();

    if (!key_id.startsWith('rzp_test_your_') && !user.razorpaySubscriptionId.startsWith('sub_sim_')) {
      try {
        await instance.subscriptions.cancel(user.razorpaySubscriptionId, true); // Cancel at period end
      } catch (err) {
        console.warn(`[RAZORPAY CANCEL NOTICE]: ${err.message}`);
      }
    }

    user.autopayStatus = 'cancelled';
    await user.save();

    await Payment.updateMany(
      { razorpaySubscriptionId: user.razorpaySubscriptionId },
      { $set: { status: 'cancelled' } }
    );

    res.json({
      message: 'Autopay recurring subscription cancelled successfully. Your benefits remain active until your current 28-day period expires.',
      autopayStatus: 'cancelled',
      tier: user.tier,
      subscriptionExpiresAt: user.subscriptionExpiresAt
    });
  } catch (err) {
    console.error('[RAZORPAY CANCEL ERROR]:', err);
    res.status(500).json({ error: 'Server error cancelling subscription' });
  }
});

// POST /api/payments/webhook (Razorpay Automated Webhook Handler for Autopay Renewals)
router.post('/webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'your_razorpay_webhook_secret';
    const signature = req.headers['x-razorpay-signature'];

    const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body)));
    
    let eventPayload;
    if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
      eventPayload = req.body;
    } else {
      eventPayload = JSON.parse(rawBody.toString());
    }

    // ✅ Unconditional signature verification — reject if secret not configured
    if (!webhookSecret || webhookSecret.startsWith('your_')) {
      console.error('[WEBHOOK] RAZORPAY_WEBHOOK_SECRET is not configured — rejecting request');
      return res.status(500).json({ error: 'Webhook secret not configured on server' });
    }

    if (!signature) {
      return res.status(400).json({ error: 'Missing webhook signature header' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    let isValid = false;
    if (typeof signature === 'string' && signature.length === expectedSignature.length) {
      isValid = crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
    }

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const { event, payload } = eventPayload;

    // Handle Subscription Charged / Renewed Autopay Event
    if (event === 'subscription.charged' || event === 'payment.captured' || event === 'subscription.activated') {
      const subEntity = payload.subscription ? payload.subscription.entity : (payload.payment ? payload.payment.entity : {});
      const subscriptionId = subEntity.id || subEntity.subscription_id;

      if (subscriptionId) {
        const user = await User.findOne({ razorpaySubscriptionId: subscriptionId });
        if (user) {
          const now = new Date();
          // Add 28 Days from current expiration (or now if expired)
          const baseDate = (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now) 
            ? new Date(user.subscriptionExpiresAt) 
            : now;
          const newExpiresAt = new Date(baseDate.getTime() + 28 * 24 * 60 * 60 * 1000);

          user.tier = user.tier === 'free' ? 'silver' : user.tier; // Keep gold/silver tier
          user.isPremium = true;
          user.subscriptionExpiresAt = newExpiresAt;
          user.autopayStatus = 'active';
          if (payload.payment && payload.payment.entity) {
            user.razorpayPaymentId = payload.payment.entity.id;
          }
          await user.save();
          await redis.del(`user:profile:${user._id}`).catch(() => {});

          // Save audit payment log
          const payment = new Payment({
            userId: user._id,
            tier: user.tier,
            amount: TIER_CONFIG[user.tier]?.priceINR || 39,
            amountPaise: TIER_CONFIG[user.tier]?.pricePaise || 3900,
            currency: 'INR',
            razorpaySubscriptionId: subscriptionId,
            razorpayPaymentId: user.razorpayPaymentId,
            isAutopay: true,
            status: 'active',
            activatedAt: now,
            expiresAt: newExpiresAt
          });
          await payment.save();
        }
      }
    } else if (event === 'subscription.halted' || event === 'subscription.cancelled') {
      const subEntity = payload.subscription ? payload.subscription.entity : {};
      if (subEntity.id) {
        await User.findOneAndUpdate(
          { razorpaySubscriptionId: subEntity.id },
          { $set: { autopayStatus: event === 'subscription.halted' ? 'halted' : 'cancelled' } }
        );
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[RAZORPAY WEBHOOK ERROR]:', err);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

// GET /api/payments/subscription-status (Current user tier status, autopay state, and quota details)
router.get('/subscription-status', authRequired, async (req, res) => {
  try {
    let user = await User.findById(req.user.id).select('tier isPremium subscriptionExpiresAt razorpaySubscriptionId autopayStatus');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Auto-check expiration (if 28 days passed and autopay is not active)
    if (user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) < new Date()) {
      if (user.autopayStatus === 'cancelled' || user.autopayStatus === 'halted' || user.autopayStatus === 'none') {
        user = await User.findByIdAndUpdate(
          req.user.id,
          {
            $set: {
              tier: 'free',
              isPremium: false,
              subscriptionExpiresAt: null,
              autopayStatus: 'none'
            }
          },
          { new: true }
        ).select('tier isPremium subscriptionExpiresAt razorpaySubscriptionId autopayStatus');
        await redis.del(`user:profile:${req.user.id}`).catch(() => {});
      }
    }

    const activeTier = user.tier || 'free';
    const tierInfo = TIER_CONFIG[activeTier];

    res.json({
      tier: activeTier,
      isPremium: user.isPremium || false,
      autopayStatus: user.autopayStatus || 'none',
      subscriptionExpiresAt: user.subscriptionExpiresAt || null,
      validityDaysRemaining: user.subscriptionExpiresAt ? Math.max(0, Math.ceil((new Date(user.subscriptionExpiresAt) - new Date()) / (1000 * 60 * 60 * 24))) : 0,
      limits: {
        likesLimit: tierInfo.likesLimit,
        superlikesLimit: tierInfo.superlikesLimit,
        profileBoost: tierInfo.profileBoost
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching subscription status' });
  }
});

module.exports = router;
