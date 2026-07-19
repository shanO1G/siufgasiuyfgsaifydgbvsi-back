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
require('dotenv').config();

// Fail fast on missing critical secrets in production
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required in production');
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('[CHAT] JWT_SECRET not set — using insecure default. Set this in production!');
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'super-secret-jwt-key-change-in-production';

const app = express();
const server = http.createServer(app);

const CHAT_PORT = process.env.CHAT_PORT || 5001;

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
    console.error('[CHAT] Failed to batch write messages:', err);
  }
}

// Flush messages periodically
setInterval(flushMessages, FLUSH_INTERVAL);

// Graceful flush on exit
process.on('SIGTERM', async () => {
  console.log('[CHAT] SIGTERM received. Flushing pending messages...');
  await flushMessages();
  process.exit(0);
});

// Socket.IO JWT authentication middleware
io.use((socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers.cookie;
    let token;

    if (cookieHeader) {
      const tokenCookie = cookieHeader.split('; ').find(row => row.startsWith('token='));
      if (tokenCookie) {
        token = tokenCookie.split('=')[1];
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

  // Track presence in Redis (expires in 2 minutes)
  const presenceKey = `presence:${userId}`;
  await redis.set(presenceKey, '1', { EX: 120 });

  // Handle client joining a room
  socket.on('join_conversation', async ({ conversationId }) => {
    try {
      if (!conversationId || typeof conversationId !== 'string') return;

      // Security check: ensure user is part of the match conversation
      const match = await Match.findOne({ conversationId });
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
  socket.on('send_message', async ({ conversationId, ciphertext, iv }) => {
    try {
      if (!conversationId || !ciphertext || !iv) {
        return socket.emit('chat_error', { error: 'Invalid message payload' });
      }

      if (typeof ciphertext !== 'string' || ciphertext.length > 100000) {
        return socket.emit('chat_error', { error: 'Invalid ciphertext' });
      }

      // Security Check: verify user belongs to this conversation
      const match = await Match.findOne({ conversationId });
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
    } catch (err) {
      console.error('[CHAT] Error sending message:', err);
      socket.emit('chat_error', { error: 'Failed to process message' });
    }
  });

  // Handle client heartbeat
  socket.on('heartbeat', async () => {
    await redis.set(presenceKey, '1', { EX: 120 });
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log(`[CHAT] User disconnected: ${userId}`);
    await redis.del(presenceKey);
  });
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
  } catch (err) {
    console.error('[CHAT] Chat service failed to start:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = server;
