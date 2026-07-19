const { Redis } = require('@upstash/redis');

const redisClient = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || 'https://fluent-wildcat-167213.upstash.io',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAo0tAAIgcDJjYjNhZDVjNzBlZTQ0NGY4YWQxYjc5NjdmODNiMjY1Yw',
});

const redis = {
  get: async (key) => {
    return await redisClient.get(key);
  },
  set: async (key, value, options) => {
    let opts = {};
    if (options) {
      if (options.EX) opts.ex = options.EX;
      if (options.ex) opts.ex = options.ex;
      if (options.PX) opts.px = options.PX;
      if (options.px) opts.px = options.px;
    }
    return await redisClient.set(key, String(value), opts);
  },
  del: async (key) => {
    return await redisClient.del(key);
  },
  incr: async (key) => {
    return await redisClient.incr(key);
  },
  expire: async (key, seconds) => {
    return await redisClient.expire(key, seconds);
  },
  expireAt: async (key, timestamp) => {
    return await redisClient.expireAt(key, timestamp);
  },
  sAdd: async (key, value) => {
    return await redisClient.sadd(key, String(value));
  },
  sCard: async (key) => {
    return await redisClient.scard(key);
  },
  zAdd: async (key, score, value) => {
    return await redisClient.zadd(key, { score, member: String(value) });
  },
  zCount: async (key, min, max) => {
    return await redisClient.zcount(key, min, max);
  },
  zRemRangeByScore: async (key, min, max) => {
    return await redisClient.zremrangebyscore(key, min, max);
  },
  clientStatus: () => ({ isMock: false, connected: true })
};

module.exports = redis;
