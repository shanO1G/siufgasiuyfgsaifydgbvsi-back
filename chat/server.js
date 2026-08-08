// libuv threadpool: 16 threads is sufficient for 250 concurrent users on 0.1 vCPU free tier
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const connectDB = require('./utils/db');
const redis = require('./utils/redis');
const Message = require('./models/Message');
const Match = require('./models/Match');
const User = require('./models/User');
const AccountFlag = require('./models/AccountFlag');
const admin = require('./utils/firebase');
require('dotenv').config();

// Fail fast on missing critical secrets in production
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is required in production');
  const redisStatus = redis.clientStatus();
  if (!redisStatus.connected) {
    throw new Error('Upstash Redis configuration (UPSTASH_REDIS_REST_URL/TOKEN or REDIS_URL) is required in production');
  }
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('[CHAT] JWT_SECRET not set — using insecure default. Set this in production!');
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'super-secret-jwt-key-change-in-production';

const app = express();
const server = http.createServer(app);

// Render injects PORT and scans for it. CHAT_PORT is for local multi-service dev only.
const CHAT_PORT = process.env.PORT || process.env.CHAT_PORT || 5001;

// Allowed origins for the main dating app (comma-separated list in env)
const APP_ORIGINS = (process.env.APP_ORIGINS || 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const io = socketIO(server, {
  cors: {
    origin: APP_ORIGINS, // H-2 fix: explicit allowlist, not '*'
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Message Queue for Mongoose bulkWrite batching
let messageQueue = [];
const BATCH_SIZE = 20;
const FLUSH_INTERVAL = 2000; // 2 seconds

async function flushMessages() {
  if (messageQueue.length === 0) return;
  const batch = [...messageQueue];
  messageQueue = [];

  try {
    const ops = batch.map(msg => ({ insertOne: { document: msg } }));
    await Message.bulkWrite(ops);
    console.log(`[CHAT] Batch wrote ${batch.length} messages to DB.`);
  } catch (err) {
    console.error('[CHAT] Failed to batch write messages. Re-queueing batch...', err);
    // Put batch back into messageQueue to avoid silent message loss (capped at 1000 to prevent OOM)
    messageQueue = [...batch, ...messageQueue].slice(0, 1000);
  }
}

// Flush messages periodically
setInterval(flushMessages, FLUSH_INTERVAL);

// Socket.IO JWT authentication middleware
io.use((socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers.cookie;
    let token;

    if (cookieHeader) {
      const tokenCookie = cookieHeader.split(';').map(c => c.trim()).find(row => row.startsWith('token='));
      if (tokenCookie) {
        token = tokenCookie.substring(6);
      }
    }

    if (!token) {
      token = socket.handshake.auth?.token || socket.handshake.query?.token;
    }

    if (!token) {
      return next(new Error('Authentication error: token not provided'));
    }

    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);

    // Block admin tokens from connecting to chat
    if (decoded.aud === 'admin-panel') {
      return next(new Error('Authentication error: admins cannot connect to chat'));
    }

    socket.user = decoded;
    next();
  } catch (err) {
    return next(new Error('Authentication error: invalid or expired token'));
  }
});

// Connection handler
io.on('connection', async (socket) => {
  const userId = socket.user.id;
  console.log(`[CHAT] User connected: ${userId}`);

  // Automatically join personal user room for instant push notifications
  socket.join(`user_${userId}`);

  // Track presence in Redis (expires in 2 minutes)
  const presenceKey = `presence:${userId}`;
  await redis.set(presenceKey, '1', { EX: 120 });

  // Handle real-time WebSocket fetching of incoming likes ("Who Liked You")
  socket.on('fetch_received_likes', async () => {
    try {
      const user = await User.findById(userId);
      if (!user) return;

      const now = new Date();
      const isSubActive = user.tier && user.tier !== 'free' && (!user.subscriptionExpiresAt || new Date(user.subscriptionExpiresAt) > now);

      const Like = require('./models/Like');
      const Block = require('./models/Block');

      const blocks = await Block.find({
        $or: [{ blockerId: userId }, { blockedId: userId }]
      }).lean();
      const blockedUserIds = blocks.map(b => String(b.blockerId) === String(userId) ? b.blockedId : b.blockerId);
      const matches = await Match.find({ $or: [{ userA: userId }, { userB: userId }] }).lean();
      const matchedUserIds = matches.map(m => String(m.userA) === String(userId) ? m.userB : m.userA);

      const excludedIds = [...blockedUserIds, ...matchedUserIds];
      const incomingLikes = await Like.find({ toUserId: userId, fromUserId: { $nin: excludedIds } }).sort({ createdAt: -1 }).lean();

      const totalLikesCount = incomingLikes.length;

      if (!isSubActive) {
        return socket.emit('received_likes_update', {
          totalLikesCount,
          hasAccess: false,
          isLocked: true,
          tier: user.tier || 'free',
          message: 'Upgrade to Silver or Gold Pass to unlock and see full profiles of users who liked you!',
          likers: []
        });
      }

      // Batch-fetch all liker profiles in ONE query — eliminates N+1
      const likerIds = incomingLikes.map(l => l.fromUserId);
      const likerUsers = await User.find({ _id: { $in: likerIds }, banned: false })
        .select('name age height pictures bio school course gender identityStatus badges tier subscriptionExpiresAt customDesignId')
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

      socket.emit('received_likes_update', {
        totalLikesCount: validLikers.length,
        hasAccess: true,
        isLocked: false,
        tier: user.tier,
        likers: validLikers
      });
    } catch (err) {
      console.error('[CHAT] Error in fetch_received_likes:', err);
      socket.emit('chat_error', { error: 'Error fetching received likes via websocket' });
    }
  });

  // Handle client joining a room
  socket.on('join_conversation', async (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      const { conversationId } = data;
      if (!conversationId || typeof conversationId !== 'string') return;

      // Security check: ensure user is part of the match conversation
      const match = await Match.findOne({ conversationId }).lean();
      if (!match) {
        return socket.emit('chat_error', { error: 'Conversation not found' });
      }

      if (match.userA.toString() !== userId && match.userB.toString() !== userId) {
        return socket.emit('chat_error', { error: 'Access denied to this conversation' });
      }

      socket.join(conversationId);
      console.log(`[CHAT] User ${userId} joined room ${conversationId}`);
    } catch (err) {
      console.error('[CHAT] Error joining room:', err);
    }
  });

  // Handle message sending (relays ciphertext and IV only — E2EE)
  socket.on('send_message', async (data) => {
    try {
      if (!data || typeof data !== 'object') {
        return socket.emit('chat_error', { error: 'Invalid message payload' });
      }
      const { conversationId, ciphertext, iv } = data;
      if (!conversationId || !ciphertext || !iv) {
        return socket.emit('chat_error', { error: 'Invalid message payload' });
      }

      if (typeof ciphertext !== 'string' || ciphertext.length > 100000) {
        return socket.emit('chat_error', { error: 'Invalid ciphertext' });
      }

      // Security Check: verify user belongs to this conversation
      const match = await Match.findOne({ conversationId }).lean();
      if (!match || (match.userA.toString() !== userId && match.userB.toString() !== userId)) {
        return socket.emit('chat_error', { error: 'Access denied' });
      }

      // Update presence
      await redis.set(presenceKey, '1', { EX: 120 });

      // Chat Metadata Spam Flagging (distinct matches messaged in short window)
      const spamKey = `user:${userId}:conversations_messaged`;
      const added = await redis.sAdd(spamKey, conversationId);
      if (added === 1) {
        const count = await redis.sCard(spamKey);
        if (count === 1) {
          await redis.expire(spamKey, 3600); // 1 hour tracking window
        }

        if (count > 5) {
          const flag = new AccountFlag({
            userId: socket.user.id,
            flagType: 'message_spam_pattern',
            severity: 'medium',
            details: { distinctConversations: count },
            status: 'open'
          });
          await flag.save();

          await User.findByIdAndUpdate(userId, { $inc: { openFlagCount: 1 } });
        }
      }

      // Prepare message payload (server stores ciphertext + IV only)
      const msgData = {
        conversationId,
        senderId: userId,
        ciphertext,
        iv,
        timestamp: new Date(),
        delivered: false
      };

      // Relay to room (excluding sender)
      socket.to(conversationId).emit('message_received', msgData);

      // Push to batch insert queue
      messageQueue.push(msgData);
      if (messageQueue.length >= BATCH_SIZE) {
        await flushMessages();
      }

      // Acknowledge receipt to sender
      socket.emit('message_sent', { conversationId, timestamp: msgData.timestamp });

      // Send Push Notification to recipient
      if (admin.apps.length > 0) {
        const recipientId = match.userA.toString() === userId ? match.userB.toString() : match.userA.toString();
        const recipient = await User.findById(recipientId).select('name fcmTokens');
        const sender = await User.findById(userId).select('name');
        if (recipient && recipient.fcmTokens && recipient.fcmTokens.length > 0) {
          admin.messaging().sendEachForMulticast({
            tokens: recipient.fcmTokens,
            notification: {
              title: `New message from ${sender?.name || 'someone'}`,
              body: 'You have a new message.'
            },
            data: {
              type: 'chat',
              chatId: conversationId
            }
          }).catch(e => console.error('[FCM] Chat push error:', e));
        }
      }
    } catch (err) {
      console.error('[CHAT] Error sending message:', err);
      socket.emit('chat_error', { error: 'Failed to process message' });
    }
  });

  // Heartbeat: rate-limited to 1 Redis write per 60 seconds per socket
  let lastHeartbeat = 0;
  socket.on('heartbeat', async () => {
    try {
      const now = Date.now();
      if (now - lastHeartbeat < 60000) return; // 60s throttle
      lastHeartbeat = now;
      await redis.set(presenceKey, '1', { EX: 120 });
    } catch (err) {
      console.error('[CHAT] Error setting presence heartbeat:', err.message);
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    try {
      console.log(`[CHAT] User disconnected: ${userId}`);
      await redis.del(presenceKey);
    } catch (err) {
      console.error('[CHAT] Error removing presence on disconnect:', err.message);
    }
  });
});

app.use(express.json());

// Internal Notification Bridge — secured with shared secret header
// Receives like/match events from REST API and relays via WebSockets
const INTERNAL_NOTIFY_SECRET = process.env.INTERNAL_NOTIFY_SECRET || 'internal-secret-change-in-production';
app.post('/internal/notify', async (req, res) => {
  try {
    // Security: reject calls without the correct shared internal secret
    if (req.headers['x-internal-secret'] !== INTERNAL_NOTIFY_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { event, toUserId, fromUserId, userA, userB, conversationId, type, timestamp } = req.body;
    const now = timestamp || new Date();

    if (event === 'new_like' && toUserId) {
      io.to(`user_${toUserId}`).emit('new_like', {
        event: 'new_like',
        toUserId,
        fromUserId,
        type: type || 'like',
        message: 'Someone liked your profile!',
        timestamp: now
      });
      console.log(`[SOCKET NOTIFY] Emitted new_like to user_${toUserId}`);
    } else if (event === 'new_match' && userA && userB) {
      // Each user gets exactly ONE new_match event with the correct partnerId
      io.to(`user_${userA}`).emit('new_match', {
        event: 'new_match',
        conversationId,
        partnerId: userB,
        message: "It's a Match!",
        timestamp: now
      });
      io.to(`user_${userB}`).emit('new_match', {
        event: 'new_match',
        conversationId,
        partnerId: userA,
        message: "It's a Match!",
        timestamp: now
      });
      console.log(`[SOCKET NOTIFY] Emitted new_match to user_${userA} & user_${userB}`);
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[CHAT] Internal notify handler error:', err);
    res.status(500).json({ error: 'Internal notification handling error' });
  }
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'chat',
    timestamp: new Date()
  });
});

async function startServer() {
  try {
    if (process.env.NODE_ENV !== 'test') {
      await connectDB();
    }
    server.listen(CHAT_PORT, () => {
      console.log(`[CHAT] Chat Service listening on port ${CHAT_PORT}`);
    });

    // Graceful Shutdown Handlers (SIGTERM / SIGINT)
    const gracefulShutdown = async (signal) => {
      console.log(`[CHAT SYS] ${signal} received. Flushing pending messages and closing Chat WebSockets & HTTP server...`);
      try {
        await flushMessages();
      } catch (flushErr) {
        console.error('[CHAT SYS ERROR] Error flushing messages on shutdown:', flushErr.message);
      }
      io.close();
      server.close(async () => {
        try {
          const mongoose = require('mongoose');
          if (mongoose.connection.readyState >= 1) {
            await mongoose.connection.close(false);
          }
          await redis.quit();
          console.log('[CHAT SYS] Chat Service graceful shutdown complete.');
          process.exit(0);
        } catch (e) {
          console.error('[CHAT SYS ERROR] Error during graceful shutdown:', e.message);
          process.exit(1);
        }
      });
      setTimeout(() => process.exit(1), 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[CHAT SYS FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (err) => {
      console.error('[CHAT SYS FATAL] Uncaught Exception thrown:', err);
      process.exit(1);
    });
  } catch (err) {
    console.error('[CHAT] Chat service failed to start:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = server;
