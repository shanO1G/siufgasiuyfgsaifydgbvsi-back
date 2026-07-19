const { createClient } = require('redis');

let redisClient;
let isMock = false;
let mockClient;

const getRedisClient = () => {
  if (isMock) return mockClient;
  if (redisClient) return redisClient;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_URL is required in production. Set it in your environment variables.');
    }
    console.warn('[REDIS] REDIS_URL not set. Falling back to in-memory mock (dev/test only). Rate-limiting and flagging counters are NOT shared across processes.');
    isMock = true;
    mockClient = createMockClient();
    return mockClient;
  }

  try {
    redisClient = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            // After 3 failed reconnects, fall back to mock in non-production
            if (process.env.NODE_ENV !== 'production') {
              console.error('[REDIS] Connection failed after retries. Falling back to in-memory mock. Rate-limiting counters are NOT shared across processes.');
              isMock = true;
              if (!mockClient) mockClient = createMockClient();
              return false; // stop retrying
            }
            // In production, keep retrying indefinitely
            return Math.min(retries * 500, 5000);
          }
          return Math.min(retries * 200, 1000);
        }
      }
    });

    redisClient.on('error', (err) => {
      if (!isMock) {
        console.error('[REDIS] Client error:', err.message);
        if (process.env.NODE_ENV !== 'production') {
          isMock = true;
          if (!mockClient) mockClient = createMockClient();
          console.warn('[REDIS] Switched to in-memory mock due to connection error.');
        }
      }
    });

    redisClient.connect().catch((err) => {
      console.error('[REDIS] Initial connection failed:', err.message);
      if (process.env.NODE_ENV !== 'production') {
        isMock = true;
        if (!mockClient) mockClient = createMockClient();
        console.warn('[REDIS] Switched to in-memory mock.');
      }
    });
  } catch (err) {
    console.error('[REDIS] Failed to create client:', err.message);
    if (process.env.NODE_ENV === 'production') throw err;
    isMock = true;
    mockClient = createMockClient();
  }

  return redisClient;
};

function createMockClient() {
  console.warn('[REDIS] Using in-memory mock Redis. This is NOT suitable for production.');
  const mockStore = new Map();
  const mock = {
    async get(key) {
      const val = mockStore.get(key);
      if (!val) return null;
      if (val.expiresAt && val.expiresAt < Date.now()) {
        mockStore.delete(key);
        return null;
      }
      return val.value;
    },
    async set(key, value, options = {}) {
      const val = { value: String(value) };
      if (options.EX) val.expiresAt = Date.now() + options.EX * 1000;
      else if (options.PX) val.expiresAt = Date.now() + options.PX;
      mockStore.set(key, val);
      return 'OK';
    },
    async del(key) {
      return mockStore.delete(key) ? 1 : 0;
    },
    async incr(key) {
      const current = await mock.get(key);
      const next = current ? parseInt(current, 10) + 1 : 1;
      const existing = mockStore.get(key);
      const expiresAt = existing ? existing.expiresAt : undefined;
      mockStore.set(key, { value: String(next), expiresAt });
      return next;
    },
    async expire(key, seconds) {
      const val = mockStore.get(key);
      if (val) {
        val.expiresAt = Date.now() + seconds * 1000;
        return 1;
      }
      return 0;
    },
    async expireAt(key, timestamp) {
      const val = mockStore.get(key);
      if (val) {
        val.expiresAt = timestamp * 1000;
        return 1;
      }
      return 0;
    },
    async sAdd(key, value) {
      let entry = mockStore.get(key);
      if (!entry) {
        entry = { value: new Set() };
        mockStore.set(key, entry);
      }
      if (entry.value instanceof Set) {
        const existed = entry.value.has(String(value));
        entry.value.add(String(value));
        return existed ? 0 : 1;
      }
      return 0;
    },
    async sCard(key) {
      const entry = mockStore.get(key);
      return entry && entry.value instanceof Set ? entry.value.size : 0;
    },
    async zAdd(key, score, value) {
      let entry = mockStore.get(key);
      if (!entry) {
        entry = { value: [] };
        mockStore.set(key, entry);
      }
      entry.value.push({ score, value: String(value) });
      return 1;
    },
    async zCount(key, min, max) {
      const entry = mockStore.get(key);
      if (!entry || !Array.isArray(entry.value)) return 0;
      return entry.value.filter(item => item.score >= min && item.score <= max).length;
    },
    async zRemRangeByScore(key, min, max) {
      const entry = mockStore.get(key);
      if (!entry || !Array.isArray(entry.value)) return 0;
      const before = entry.value.length;
      entry.value = entry.value.filter(item => item.score < min || item.score > max);
      return before - entry.value.length;
    },
    isMock: true
  };
  return mock;
}

// Wrap operations in try-catch to guarantee fallback without throwing
async function runSafe(method, ...args) {
  if (isMock) {
    if (!mockClient) mockClient = createMockClient();
    return mockClient[method](...args);
  }
  try {
    const client = getRedisClient();
    if (isMock) {
      if (!mockClient) mockClient = createMockClient();
      return mockClient[method](...args);
    }
    return await client[method](...args);
  } catch (err) {
    console.error(`[REDIS] Operation '${method}' failed:`, err.message);
    if (process.env.NODE_ENV === 'production') {
      // In production, propagate the error — don't silently degrade
      throw err;
    }
    isMock = true;
    if (!mockClient) mockClient = createMockClient();
    return mockClient[method](...args);
  }
}

const redis = {
  get: (key) => runSafe('get', key),
  set: (key, value, options) => runSafe('set', key, value, options),
  del: (key) => runSafe('del', key),
  incr: (key) => runSafe('incr', key),
  expire: (key, seconds) => runSafe('expire', key, seconds),
  expireAt: (key, timestamp) => runSafe('expireAt', key, timestamp),
  sAdd: (key, value) => runSafe('sAdd', key, value),
  sCard: (key) => runSafe('sCard', key),
  zAdd: (key, score, value) => runSafe('zAdd', key, score, value),
  zCount: (key, min, max) => runSafe('zCount', key, min, max),
  zRemRangeByScore: (key, min, max) => runSafe('zRemRangeByScore', key, min, max),
  clientStatus: () => ({ isMock, connected: !isMock })
};

module.exports = redis;
