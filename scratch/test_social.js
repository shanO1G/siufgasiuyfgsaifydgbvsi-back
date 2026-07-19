const assert = require('assert');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

// Mock Mongoose models
const User = require('../api/models/User');
const Like = require('../api/models/Like');
const Match = require('../api/models/Match');
const Block = require('../api/models/Block');
const Report = require('../api/models/Report');
const AccountFlag = require('../api/models/AccountFlag');

const mockUser = {
  _id: new mongoose.Types.ObjectId(),
  email: 'test@stu.adamasuniversity.ac.in',
  username: 'testuser',
  gender: 'male',
  emailVerified: false,
  openFlagCount: 0,
  save: async function() { return this; }
};

const mockTarget = {
  _id: new mongoose.Types.ObjectId(),
  email: 'target@stu.adamasuniversity.ac.in',
  username: 'targetuser',
  gender: 'female',
  emailVerified: true,
  openFlagCount: 0,
  save: async function() { return this; }
};

const mockLikes = [];
const mockMatches = [];
const mockBlocks = [];
const mockReports = [];
const mockFlags = [];

// Stub DB operations
User.findById = async (id) => {
  if (id.toString() === mockUser._id.toString()) return mockUser;
  if (id.toString() === mockTarget._id.toString()) return mockTarget;
  return null;
};

User.findOne = async () => null;

Like.findOneAndUpdate = async (query, update, options) => {
  const existing = mockLikes.find(l => l.fromUserId.equals(query.fromUserId) && l.toUserId.equals(query.toUserId));
  if (existing) {
    existing.type = update.type;
  } else {
    mockLikes.push({ ...query, ...update });
  }
  return existing;
};

Like.findOne = async (query) => {
  return mockLikes.find(l => l.fromUserId.equals(query.fromUserId) && l.toUserId.equals(query.toUserId)) || null;
};

Match.prototype.save = async function() {
  this._id = new mongoose.Types.ObjectId();
  mockMatches.push(this);
  return this;
};

Block.findOneAndUpdate = async (query, update, options) => {
  const existing = mockBlocks.find(b => b.blockerId.equals(query.blockerId) && b.blockedId.equals(query.blockedId));
  if (!existing) {
    mockBlocks.push(query);
  }
  return existing;
};

Block.findOne = async (query) => {
  return mockBlocks.find(b => 
    (b.blockerId.equals(query.$or[0].blockerId) && b.blockedId.equals(query.$or[0].blockedId)) ||
    (b.blockerId.equals(query.$or[1].blockerId) && b.blockedId.equals(query.$or[1].blockedId))
  ) || null;
};

Report.prototype.save = async function() {
  this._id = new mongoose.Types.ObjectId();
  mockReports.push(this);
  return this;
};

AccountFlag.prototype.save = async function() {
  this._id = new mongoose.Types.ObjectId();
  mockFlags.push(this);
  return this;
};

// Set Node env to test so database won't auto-connect
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

// Stub auth middleware
const authMiddleware = require('../api/middleware/auth');
authMiddleware.authRequired = (req, res, next) => {
  req.user = { id: mockUser._id, username: mockUser.username };
  next();
};

const app = require('../api/server');

async function runTests() {
  console.log('--- Starting Social Flow Testing ---');

  // Test 1: Liking a user works and records in Like collection
  console.log('Testing Test 1: Standard like action...');
  const res1 = await request(app)
    .post(`/api/like/${mockTarget._id}`)
    .send();
  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.matchFormed, false);
  assert.strictEqual(mockLikes.length, 1);
  console.log('✓ Like recorded successfully.');

  // Test 2: Daily limit enforcement (Outsider male gets 5 likes limit)
  console.log('Testing Test 2: Like limit enforcement...');
  // Trigger remaining likes to breach quota of 5 (already used 1)
  await request(app).post(`/api/like/${mockTarget._id}`).send(); // 2
  await request(app).post(`/api/like/${mockTarget._id}`).send(); // 3
  await request(app).post(`/api/like/${mockTarget._id}`).send(); // 4
  await request(app).post(`/api/like/${mockTarget._id}`).send(); // 5
  
  const res2 = await request(app)
    .post(`/api/like/${mockTarget._id}`)
    .send(); // 6 (should fail)
  assert.strictEqual(res2.status, 429);
  assert.strictEqual(res2.body.error, 'Daily likes quota exceeded');
  console.log('✓ Quota correctly enforced.');

  // Test 3: Like velocity spike triggers account flagging (> 5 actions)
  console.log('Testing Test 3: Like velocity spike detection...');
  mockUser.emailVerified = true; // Make user verified insider for unlimited likes
  const redis = require('../api/utils/redis');
  await redis.del(`user:${mockUser._id}:likes`); // Clean up previous counts
  
  // Make 6 quick likes to trigger velocity (> 5 in 10s)
  for (let i = 0; i < 6; i++) {
    await request(app).post(`/api/like/${mockTarget._id}`).send();
  }
  
  const velocityFlag = mockFlags.find(f => f.flagType === 'like_velocity_spike');
  assert.ok(velocityFlag);
  assert.strictEqual(velocityFlag.severity, 'low');
  console.log('✓ Velocity spike detected and flagged.');

  // Test 4: Mutual Match detection
  console.log('Testing Test 4: Mutual Match detection...');
  // Force a back-like in mockLikes (Target likes User)
  mockLikes.push({
    fromUserId: mockTarget._id,
    toUserId: mockUser._id,
    type: 'like'
  });
  
  // Clean up quotas in Redis mock store by deleting key
  await redis.del(`user:${mockUser._id}:likes`);

  const res4 = await request(app)
    .post(`/api/like/${mockTarget._id}`)
    .send();
  assert.strictEqual(res4.status, 200);
  assert.strictEqual(res4.body.matchFormed, true);
  assert.ok(res4.body.conversationId);
  assert.strictEqual(mockMatches.length, 1);
  console.log('✓ Mutual match correctly detected and created.');

  // Test 5: Mass Block target flagging
  console.log('Testing Test 5: Mass Block target detection...');
  for (let i = 0; i < 11; i++) {
    await request(app).post(`/api/block/${mockTarget._id}`).send();
  }
  const blockFlag = mockFlags.find(f => f.flagType === 'mass_block_target');
  assert.ok(blockFlag);
  assert.strictEqual(blockFlag.severity, 'medium');
  console.log('✓ Mass block threshold correctly flagged.');

  // Test 6: Mass Report target flagging
  console.log('Testing Test 6: Mass Report target detection...');
  for (let i = 0; i < 6; i++) {
    await request(app)
      .post('/api/report')
      .send({ targetUserId: mockTarget._id.toString(), reason: 'Spamming' });
  }
  const reportFlag = mockFlags.find(f => f.flagType === 'mass_report_target');
  assert.ok(reportFlag);
  assert.strictEqual(reportFlag.severity, 'high');
  console.log('✓ Mass report threshold correctly flagged.');

  console.log('--- Social Flow Testing Succeeded! ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
