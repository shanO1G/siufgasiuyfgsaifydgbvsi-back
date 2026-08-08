/**
 * FRND — Google Play Billing Backend Routes
 *
 * Handles:
 *   POST /api/payments/play/verify  — server-side purchase token verification + acknowledgment
 *   POST /api/payments/play/rtdn    — Real-time Developer Notifications via Pub/Sub push
 *
 * ── REQUIRED ENVIRONMENT VARIABLES ──────────────────────────────────────────
 *
 *   GOOGLE_PLAY_PACKAGE_NAME
 *     The app's package name in Play Console (e.g. "com.frnd.app").
 *
 *   GOOGLE_SERVICE_ACCOUNT_JSON
 *     The full JSON content of a Google Cloud service account key file,
 *     base64-encoded. The service account must have the "Financial data viewer"
 *     role granted in Play Console (not just IAM — must be added in
 *     Play Console → Setup → API access).
 *
 *     To generate:
 *       1. Google Cloud Console → IAM & Admin → Service Accounts → Create
 *       2. No IAM roles needed on GCP itself
 *       3. Download JSON key
 *       4. base64 -i key.json → paste as env var
 *       5. In Play Console → Setup → API access → link project → grant account access
 *          (Permission: "View financial data, orders, and cancellation survey responses")
 *
 *   PLAY_RTDN_PUBSUB_TOKEN
 *     A shared secret token appended as ?token= to your Pub/Sub push
 *     subscription URL. Used to authenticate incoming RTDN push messages.
 *     Example: a 32+ character random string.
 *
 *     Pub/Sub push URL to configure in Google Cloud Console:
 *       https://your-api.onrender.com/api/payments/play/rtdn?token=<PLAY_RTDN_PUBSUB_TOKEN>
 *
 * ── PRODUCT ID → TIER MAPPING ────────────────────────────────────────────────
 *   frnd_silver_pass  →  'silver'  (₹39, every 4 weeks)
 *   frnd_gold_pass    →  'gold'    (₹49, every 4 weeks)
 *
 * ── MANUAL SETUP CHECKLIST (before testing end-to-end) ───────────────────────
 *   □ Play Console: Create frnd_silver_pass and frnd_gold_pass as recurring
 *     subscriptions with "Every 4 weeks" base plan at ₹39 / ₹49 respectively.
 *   □ Play Console: Enable the Google Play Developer API in Google Cloud Console.
 *   □ Google Cloud Console: Create Pub/Sub topic (e.g. "frnd-play-rtdn").
 *   □ Google Cloud Console: Create a push subscription pointing to this endpoint.
 *   □ Play Console → Monetize → Real-time Developer Notifications: configure topic.
 *   □ Set all three env vars on Render (or your hosting provider).
 */

'use strict';

const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const User = require('../models/User');
const Payment = require('../models/Payment');
const redis = require('../utils/redis');
const { authRequired } = require('../middleware/auth');

// ─── Constants ────────────────────────────────────────────────────────────────

const PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.frnd.app';

/** Maps Play Console product IDs to internal tier strings. */
const PRODUCT_TIER_MAP = {
  frnd_silver_pass: 'silver',
  frnd_gold_pass: 'gold',
};

/** Entitlement limits by tier — mirrors TIER_CONFIG in payments.js. */
const TIER_LIMITS = {
  free:   { likesLimit: 15, superlikesLimit: 3,  profileBoost: 1 },
  silver: { likesLimit: 25, superlikesLimit: 6,  profileBoost: 3 },
  gold:   { likesLimit: 50, superlikesLimit: 12, profileBoost: 6 },
};

// ─── Google Play Developer API Client ─────────────────────────────────────────

function getAndroidPublisherClient() {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!serviceAccountJson) {
    throw new Error(
      '[PlayBilling] GOOGLE_SERVICE_ACCOUNT_JSON env var is not set. ' +
      'See the setup checklist at the top of play_billing.js.'
    );
  }

  let credentials;
  try {
    // Accept both raw JSON and base64-encoded JSON.
    const decoded = Buffer.from(serviceAccountJson, 'base64').toString('utf8');
    credentials = JSON.parse(decoded);
  } catch {
    try {
      credentials = JSON.parse(serviceAccountJson);
    } catch {
      throw new Error('[PlayBilling] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64-encoded JSON.');
    }
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  return google.androidpublisher({ version: 'v3', auth });
}

// ─── Helper: Verify and acknowledge a purchase token ─────────────────────────

/**
 * Calls purchases.subscriptionsv2.get against the Play Developer API.
 * Returns the subscription resource on success, throws on failure.
 *
 * @param {string} purchaseToken
 * @param {string} productId  — e.g. 'frnd_silver_pass'
 */
async function verifyPlaySubscription(purchaseToken, productId) {
  const androidpublisher = getAndroidPublisherClient();

  const response = await androidpublisher.purchases.subscriptionsv2.get({
    packageName: PACKAGE_NAME,
    token: purchaseToken,
  });

  return response.data; // SubscriptionPurchaseV2 resource
}

/**
 * Acknowledges a subscription purchase via the Play Developer API.
 * MUST be called within 3 days of purchase or Google auto-refunds the user.
 *
 * @param {string} purchaseToken
 * @param {string} productId
 */
async function acknowledgePlaySubscription(purchaseToken, productId) {
  const androidpublisher = getAndroidPublisherClient();
  await androidpublisher.purchases.subscriptions.acknowledge({
    packageName: PACKAGE_NAME,
    subscriptionId: productId,
    token: purchaseToken,
    requestBody: {},
  });
}

/**
 * Derives the subscription state string from the v2 resource.
 * SUBSCRIPTION_STATE_ACTIVE | SUBSCRIPTION_STATE_CANCELED | etc.
 */
function getPlaySubscriptionState(subscriptionData) {
  return subscriptionData.subscriptionState || 'SUBSCRIPTION_STATE_UNSPECIFIED';
}

// ─── POST /api/payments/play/verify ──────────────────────────────────────────

/**
 * Called by the Flutter app immediately after a successful Play purchase.
 * Verifies the purchase token server-side, acknowledges the purchase,
 * and grants the user's tier entitlement in the database.
 *
 * Body: { purchaseToken: string, productId: string }
 */
router.post('/verify', authRequired, async (req, res) => {
  try {
    const { purchaseToken, productId } = req.body;

    if (!purchaseToken || !productId) {
      return res.status(400).json({
        error: 'Missing required fields: purchaseToken and productId are required.',
      });
    }

    const tier = PRODUCT_TIER_MAP[productId];
    if (!tier) {
      return res.status(400).json({
        error: `Unknown productId: ${productId}. Expected frnd_silver_pass or frnd_gold_pass.`,
      });
    }

    // Rate-limit: max 5 verification attempts per user per 15 minutes.
    const rateKey = `play_verify:${req.user.id}`;
    const attempts = await redis.incr(rateKey);
    if (attempts === 1) await redis.expire(rateKey, 900);
    if (attempts > 5) {
      return res.status(429).json({ error: 'Too many verification attempts. Wait 15 minutes.' });
    }

    // 1. Verify against Play Developer API.
    let subscriptionData;
    try {
      subscriptionData = await verifyPlaySubscription(purchaseToken, productId);
    } catch (err) {
      console.error('[PlayBilling VERIFY] Play API error:', err.message);
      return res.status(502).json({
        error: 'Could not reach Google Play Developer API. Please try again.',
      });
    }

    const subscriptionState = getPlaySubscriptionState(subscriptionData);
    const isActive =
      subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE' ||
      subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';

    if (!isActive) {
      return res.status(400).json({
        error: `Subscription is not active (state: ${subscriptionState}). Payment may be pending.`,
      });
    }

    // 2. Acknowledge the purchase (required within 3 days).
    try {
      await acknowledgePlaySubscription(purchaseToken, productId);
    } catch (err) {
      // Non-fatal if already acknowledged (idempotent).
      console.warn('[PlayBilling VERIFY] Acknowledge warning:', err.message);
    }

    // 3. Determine expiry from the v2 lineItems.
    let expiresAt = null;
    const lineItem = subscriptionData.lineItems?.[0];
    if (lineItem?.expiryTime) {
      expiresAt = new Date(lineItem.expiryTime);
    } else {
      // Fallback: 28 days from now.
      expiresAt = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000);
    }

    // 4. Grant tier entitlement in the database.
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          tier,
          isPremium: true,
          subscriptionExpiresAt: expiresAt,
          playPurchaseToken: purchaseToken,
          playProductId: productId,
          playSubscriptionState: 'active',
        },
      },
      { new: true }
    ).select('-passwordHash');

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // 5. Create audit payment record.
    const tierLimits = TIER_LIMITS[tier];
    const amountINR = tier === 'gold' ? 49 : 39;
    const payment = new Payment({
      userId: updatedUser._id,
      tier,
      amount: amountINR,
      amountPaise: amountINR * 100,
      currency: 'INR',
      paymentProcessor: 'google_play',
      playPurchaseToken: purchaseToken,
      playProductId: productId,
      playOrderId: subscriptionData.latestOrderId || null,
      isAutopay: true,
      status: 'active',
      activatedAt: new Date(),
      expiresAt,
    });
    await payment.save();

    // 6. Invalidate caches.
    await redis.del(`discover:${req.user.id}`, `user:profile:${req.user.id}`).catch(() => {});

    res.json({
      message: `🎉 ${tier === 'gold' ? 'Gold' : 'Silver'} Pass activated via Google Play!`,
      tier: updatedUser.tier,
      isPremium: updatedUser.isPremium,
      subscriptionExpiresAt: updatedUser.subscriptionExpiresAt,
      validityDaysRemaining: Math.max(
        0,
        Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24))
      ),
      limits: tierLimits,
    });
  } catch (err) {
    console.error('[PlayBilling VERIFY ERROR]:', err);
    res.status(500).json({ error: 'Server error during Play Billing verification.' });
  }
});

// ─── POST /api/payments/play/rtdn ─────────────────────────────────────────────

/**
 * Google Cloud Pub/Sub push endpoint for Real-time Developer Notifications (RTDN).
 *
 * Configure the Pub/Sub push subscription to deliver to:
 *   https://your-api.onrender.com/api/payments/play/rtdn?token=<PLAY_RTDN_PUBSUB_TOKEN>
 *
 * Handles:
 *   SUBSCRIPTION_RENEWED        → extend subscriptionExpiresAt by 28 days
 *   SUBSCRIPTION_CANCELED       → mark playSubscriptionState = 'canceled' (keep access until expiry)
 *   SUBSCRIPTION_EXPIRED        → downgrade to free tier
 *   SUBSCRIPTION_REVOKED        → immediate downgrade (refund)
 *   SUBSCRIPTION_ON_HOLD        → mark as on_hold (payment issue; access continues briefly)
 *   SUBSCRIPTION_RESTARTED      → reactivate
 *   SUBSCRIPTION_PURCHASED (new)→ handled by /verify; log here if needed
 */
router.post('/rtdn', async (req, res) => {
  try {
    // Authenticate the Pub/Sub push message via shared token.
    const expectedToken = process.env.PLAY_RTDN_PUBSUB_TOKEN;
    const receivedToken = req.query.token;

    if (!expectedToken || expectedToken.length < 8) {
      console.error('[PlayBilling RTDN] PLAY_RTDN_PUBSUB_TOKEN is not configured.');
      return res.status(500).json({ error: 'RTDN token not configured.' });
    }

    if (receivedToken !== expectedToken) {
      console.warn('[PlayBilling RTDN] Invalid token. Rejecting push.');
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    // Pub/Sub delivers messages as base64-encoded JSON in req.body.message.data.
    const pubsubMessage = req.body?.message;
    if (!pubsubMessage?.data) {
      return res.status(400).json({ error: 'Invalid Pub/Sub message format.' });
    }

    const rawData = Buffer.from(pubsubMessage.data, 'base64').toString('utf8');
    const notification = JSON.parse(rawData);

    const { packageName, subscriptionNotification, testNotification } = notification;

    // Acknowledge test notifications immediately.
    if (testNotification) {
      console.log('[PlayBilling RTDN] Test notification received.');
      return res.status(204).send();
    }

    if (!subscriptionNotification) {
      // Not a subscription notification — could be a voided purchase, etc. Ignore.
      return res.status(204).send();
    }

    const { purchaseToken, subscriptionId, notificationType } = subscriptionNotification;

    console.log(`[PlayBilling RTDN] notificationType=${notificationType} productId=${subscriptionId}`);

    // Notification type codes from Play Billing reference:
    // https://developer.android.com/google/play/billing/rtdn-reference
    const NOTIFICATION = {
      RECOVERED: 1,
      RENEWED: 2,
      CANCELED: 3,
      PURCHASED: 4,
      ON_HOLD: 5,
      IN_GRACE_PERIOD: 6,
      RESTARTED: 7,
      PRICE_CHANGE_CONFIRMED: 8,
      DEFERRED: 9,
      PAUSED: 10,
      PAUSE_SCHEDULE_CHANGED: 11,
      REVOKED: 12,
      EXPIRED: 13,
    };

    const user = await User.findOne({ playPurchaseToken: purchaseToken });

    if (!user) {
      // Token not found — could be a new purchase token after upgrade; log and ack.
      console.warn(`[PlayBilling RTDN] No user found for token. May be a new token from upgrade.`);
      return res.status(204).send();
    }

    const tier = PRODUCT_TIER_MAP[subscriptionId] || user.tier;
    const now = new Date();

    switch (notificationType) {
      case NOTIFICATION.RENEWED:
      case NOTIFICATION.RECOVERED:
      case NOTIFICATION.RESTARTED:
      case NOTIFICATION.IN_GRACE_PERIOD: {
        // Subscription renewed or recovered — extend expiry by 28 days.
        const baseDate =
          user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now
            ? new Date(user.subscriptionExpiresAt)
            : now;
        const newExpiresAt = new Date(baseDate.getTime() + 28 * 24 * 60 * 60 * 1000);
        await User.findByIdAndUpdate(user._id, {
          $set: {
            tier,
            isPremium: true,
            subscriptionExpiresAt: newExpiresAt,
            playSubscriptionState: 'active',
            playPurchaseToken: purchaseToken,
            playProductId: subscriptionId,
          },
        });
        // Create renewal audit record.
        const amountINR = tier === 'gold' ? 49 : 39;
        await new Payment({
          userId: user._id,
          tier,
          amount: amountINR,
          amountPaise: amountINR * 100,
          currency: 'INR',
          paymentProcessor: 'google_play',
          playPurchaseToken: purchaseToken,
          playProductId: subscriptionId,
          isAutopay: true,
          status: 'active',
          activatedAt: now,
          expiresAt: newExpiresAt,
        }).save();
        await redis.del(`discover:${user._id}`, `user:profile:${user._id}`).catch(() => {});
        break;
      }

      case NOTIFICATION.CANCELED:
        // User cancelled — retain access until current expiry, then expire.
        await User.findByIdAndUpdate(user._id, {
          $set: { playSubscriptionState: 'canceled' },
        });
        break;

      case NOTIFICATION.ON_HOLD:
      case NOTIFICATION.PAUSED:
        // Payment on hold or paused — mark state but keep access temporarily.
        await User.findByIdAndUpdate(user._id, {
          $set: { playSubscriptionState: 'on_hold' },
        });
        break;

      case NOTIFICATION.EXPIRED:
        // Subscription has fully expired — downgrade to free tier.
        await User.findByIdAndUpdate(user._id, {
          $set: {
            tier: 'free',
            isPremium: false,
            subscriptionExpiresAt: null,
            playSubscriptionState: 'expired',
          },
        });
        await redis.del(`discover:${user._id}`, `user:profile:${user._id}`).catch(() => {});
        break;

      case NOTIFICATION.REVOKED:
        // Subscription revoked (refunded) — immediate downgrade to free.
        await User.findByIdAndUpdate(user._id, {
          $set: {
            tier: 'free',
            isPremium: false,
            subscriptionExpiresAt: null,
            playSubscriptionState: 'expired',
          },
        });
        await redis.del(`discover:${user._id}`, `user:profile:${user._id}`).catch(() => {});
        break;

      case NOTIFICATION.PURCHASED:
        // New purchase — already handled by /verify. Nothing extra needed here.
        break;

      default:
        console.log(`[PlayBilling RTDN] Unhandled notificationType: ${notificationType}`);
    }

    // Always ack the Pub/Sub message (return 2xx so Google doesn't retry).
    res.status(204).send();
  } catch (err) {
    console.error('[PlayBilling RTDN ERROR]:', err);
    // Still return 204 to prevent Pub/Sub infinite retry on non-recoverable errors.
    res.status(204).send();
  }
});

module.exports = router;
