
// 128 threads waste ~112MB RAM for zero throughput gain at this scale
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const connectDB = require('./utils/db');
const authRoutes = require('./routes/auth');
const verificationRoutes = require('./routes/verification');
const socialRoutes = require('./routes/social');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payments');
const playBillingRoutes = require('./routes/play_billing');
const careerRoutes = require('./routes/careers');
require('dotenv').config();

// Fail fast on missing critical secrets in production
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is required in production');
  if (!process.env.ADMIN_PANEL_ORIGIN) throw new Error('ADMIN_PANEL_ORIGIN environment variable is required in production');
  if (!process.env.APP_ORIGINS) throw new Error('APP_ORIGINS environment variable is required in production');
  const redisStatus = require('./utils/redis').clientStatus();
  if (!redisStatus.connected) {
    throw new Error('Upstash Redis configuration (UPSTASH_REDIS_REST_URL/TOKEN or REDIS_URL) is required in production');
  }
}

const app = express();
const PORT = process.env.PORT || 5000;

// Trust Render's reverse proxy — required so req.ip returns the real client IP
// Without this, all rate-limiting and flagging would track the load-balancer IP instead
app.set('trust proxy', 1);

// Allowed origins for the main dating app (comma-separated list in env)
const ADMIN_PANEL_ORIGIN = process.env.ADMIN_PANEL_ORIGIN || 'http://localhost:3000';
const APP_ORIGINS = (process.env.APP_ORIGINS || 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Security middleware
app.use(helmet());
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/payments/webhook')) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Serve local uploads (dev/fallback only — Cloudinary is used in production)
app.use('/uploads', (req, res, next) => {
  if (process.env.NODE_ENV === 'production' && process.env.CLOUDINARY_CLOUD_NAME && !process.env.CLOUDINARY_CLOUD_NAME.startsWith('your_')) {
    // In production with Cloudinary configured, /uploads should not serve local files
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}, express.static(path.join(__dirname, 'public/uploads')));

// Custom CORS handler
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Resolve self-origin to allow same-origin requests from backend-hosted HTML pages
  const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.get('host');
  const selfOrigin = `${protocol}://${host}`;

  if (req.path.startsWith('/api/admin')) {
    // Admin routes: only allow the configured admin SPA origin or self-origin
    if (origin === ADMIN_PANEL_ORIGIN || origin === selfOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else if (origin) {
      return res.status(403).json({ error: 'CORS policy: admin routes restricted' });
    }
    // No origin header (server-to-server / curl) — fall through without CORS headers
  } else {
    // Regular app routes: only allow explicitly whitelisted origins or self-origin
    if (origin && (APP_ORIGINS.includes(origin) || origin === selfOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else if (origin) {
      // Unknown origin — reject with CORS error (browser will block the response)
      return res.status(403).json({ error: 'CORS policy: origin not allowed' });
    }
    // No origin header (server-to-server / curl) — fall through without CORS headers
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Cookie');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/payments/play', playBillingRoutes);
app.use('/api/careers', careerRoutes);
app.use('/api', socialRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/api/health', async (req, res) => {
  const redisStatus = require('./utils/redis').clientStatus();
  let mongoStatus = 'connected';
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) mongoStatus = 'disconnected';
  } catch {
    mongoStatus = 'error';
  }
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    redis: redisStatus,
    mongo: mongoStatus
  });
});

// Root route
app.get('/', (req, res) => {
  res.send('College Dating App API Service is running');
});

// Centralised error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start service
async function startServer() {
  try {
    if (process.env.NODE_ENV !== 'test') {
      await connectDB();
    }
    const server = app.listen(PORT, () => {
      console.log(`API Service listening on port ${PORT}`);
    });

    // Graceful Shutdown Handlers (SIGTERM / SIGINT)
    const gracefulShutdown = async (signal) => {
      console.log(`[SYS] ${signal} received. Closing HTTP server...`);
      server.close(async () => {
        try {
          const mongoose = require('mongoose');
          const redis = require('./utils/redis');
          if (mongoose.connection.readyState >= 1) {
            await mongoose.connection.close(false);
          }
          await redis.quit();
          console.log('[SYS] API Service graceful shutdown complete.');
          process.exit(0);
        } catch (e) {
          console.error('[SYS ERROR] Error during graceful shutdown:', e.message);
          process.exit(1);
        }
      });
      setTimeout(() => process.exit(1), 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[SYS FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (err) => {
      console.error('[SYS FATAL] Uncaught Exception thrown:', err);
      process.exit(1);
    });
  } catch (err) {
    console.error('API service failed to start:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
