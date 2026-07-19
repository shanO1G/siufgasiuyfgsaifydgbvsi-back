const assert = require('assert');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

// Mock Mongoose Models
const Admin = require('../api/models/Admin');
const User = require('../api/models/User');
const AccountFlag = require('../api/models/AccountFlag');
const Report = require('../api/models/Report');
const Feedback = require('../api/models/Feedback');
const Announcement = require('../api/models/Announcement');
const AdminAction = require('../api/models/AdminAction');

const mockAdmins = [];
const mockUsers = [];
const mockFlags = [];
const mockActions = [];

// DB Stubs
Admin.findOne = async (query) => {
  return mockAdmins.find(a => a.email === query.email) || null;
};
Admin.findById = async (id) => {
  return mockAdmins.find(a => a._id.toString() === id.toString()) || null;
};
Admin.prototype.save = async function() {
  if (!this._id) this._id = new mongoose.Types.ObjectId();
  const index = mockAdmins.findIndex(a => a._id.toString() === this._id.toString());
  if (index >= 0) mockAdmins[index] = this;
  else mockAdmins.push(this);
  return this;
};

User.find = () => ({
  select: () => ({
    sort: () => mockUsers
  })
});
User.findById = async (id) => {
  return mockUsers.find(u => u._id.toString() === id.toString()) || null;
};
User.prototype.save = async function() {
  if (!this._id) this._id = new mongoose.Types.ObjectId();
  const index = mockUsers.findIndex(u => u._id.toString() === this._id.toString());
  if (index >= 0) mockUsers[index] = this;
  else mockUsers.push(this);
  return this;
};

AccountFlag.findById = async (id) => {
  return mockFlags.find(f => f._id.toString() === id.toString()) || null;
};
AccountFlag.find = () => ({
  populate: () => ({
    sort: () => mockFlags
  })
});
AccountFlag.prototype.save = async function() {
  if (!this._id) this._id = new mongoose.Types.ObjectId();
  const index = mockFlags.findIndex(f => f._id.toString() === this._id.toString());
  if (index >= 0) mockFlags[index] = this;
  else mockFlags.push(this);
  return this;
};

AdminAction.prototype.save = async function() {
  this._id = new mongoose.Types.ObjectId();
  mockActions.push(this);
  return this;
};

// Set Node env to test so database won't auto-connect
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_EMAILS = 'admin@stu.adamasuniversity.ac.in,super@stu.adamasuniversity.ac.in';
// bcrypt hash for "common-secret"
process.env.ADMIN_COMMON_PASSWORD_HASH = '$2a$10$3y6p5fH3j4v.e9e1c1o1m.P4pU1x881f181f181f181f181f181f1'; // bcrypt hash dummy

const app = require('../api/server');
const bcrypt = require('bcryptjs');

async function runTests() {
  console.log('--- Starting Admin Flow Verification ---');

  // Test 1: Admin signup allowlist gating (unauthorized email fails)
  console.log('Testing Test 1: Admin signup allowlist gating...');
  const res1 = await request(app)
    .post('/api/admin/auth/signup')
    .send({
      email: 'outsider@gmail.com',
      password: 'adminpassword123'
    });
  assert.strictEqual(res1.status, 400);
  assert.strictEqual(res1.body.error, 'Access denied: unauthorized admin email');
  console.log('✓ Unauthorized admin email rejected.');

  // Test 2: Admin signup success for allowlisted email
  console.log('Testing Test 2: Authorized admin signup...');
  const res2 = await request(app)
    .post('/api/admin/auth/signup')
    .send({
      email: 'admin@stu.adamasuniversity.ac.in',
      password: 'adminpassword123'
    });
  assert.strictEqual(res2.status, 201);
  assert.strictEqual(res2.body.message, 'Admin account registered successfully');
  assert.strictEqual(mockAdmins.length, 1);
  console.log('✓ Allowlisted admin signed up successfully.');

  // Test 3: Admin login - personal password verification
  console.log('Testing Test 3: Admin login credential checking...');
  // Force correct common password hash in env
  const salt = await bcrypt.genSalt(10);
  const commonPassHash = await bcrypt.hash('common-secret', salt);
  process.env.ADMIN_COMMON_PASSWORD_HASH = commonPassHash;

  // Login failure (wrong personal pass)
  const res3a = await request(app)
    .post('/api/admin/auth/login')
    .send({
      email: 'admin@stu.adamasuniversity.ac.in',
      password: 'wrongpassword',
      commonPass: 'common-secret'
    });
  assert.strictEqual(res3a.status, 401);
  assert.strictEqual(res3a.body.error, 'Invalid credentials');

  // Login failure (wrong common pass)
  const res3b = await request(app)
    .post('/api/admin/auth/login')
    .send({
      email: 'admin@stu.adamasuniversity.ac.in',
      password: 'adminpassword123',
      commonPass: 'wrong-common'
    });
  assert.strictEqual(res3b.status, 401);
  assert.strictEqual(res3b.body.error, 'Invalid credentials');

  // Login success
  const res3c = await request(app)
    .post('/api/admin/auth/login')
    .send({
      email: 'admin@stu.adamasuniversity.ac.in',
      password: 'adminpassword123',
      commonPass: 'common-secret'
    });
  assert.strictEqual(res3c.status, 200);
  assert.ok(res3c.body.token);
  console.log('✓ Double-secret admin login verification passed.');

  const adminToken = res3c.body.token;

  // Test 4: Gated admin endpoints require admin token
  console.log('Testing Test 4: Gated operations auth block...');
  const res4a = await request(app)
    .get('/api/admin/users');
  assert.strictEqual(res4a.status, 401); // missing token

  // Normal user token should fail audience test
  const jwt = require('jsonwebtoken');
  const userToken = jwt.sign({ id: new mongoose.Types.ObjectId() }, 'test-secret'); // no aud: admin-panel
  const res4b = await request(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${userToken}`);
  assert.strictEqual(res4b.status, 403); // invalid token audience

  // Correct token works
  const res4c = await request(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res4c.status, 200);
  console.log('✓ Authorization scopes correctly verified.');

  // Test 5: Flag transitions and actions
  console.log('Testing Test 5: Admin flag resolution...');
  const testUser = new User({
    email: 'reported@stu.adamasuniversity.ac.in',
    username: 'reporteduser',
    name: 'Reported User',
    age: 21,
    gender: 'male',
    passwordHash: 'dummy',
    openFlagCount: 2
  });
  await testUser.save();

  const flag = new AccountFlag({
    userId: testUser._id,
    flagType: 'login_brute_force',
    severity: 'medium',
    status: 'open'
  });
  await flag.save();

  // A. Dismiss flag
  const res5a = await request(app)
    .post(`/api/admin/flags/${flag._id}/dismiss`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send();
  assert.strictEqual(res5a.status, 200);
  assert.strictEqual(flag.status, 'dismissed');
  assert.strictEqual(testUser.openFlagCount, 1); // decremented

  // B. Action flag (auto-bans user!)
  const flag2 = new AccountFlag({
    userId: testUser._id,
    flagType: 'duplicate_identity_document',
    severity: 'high',
    status: 'open'
  });
  await flag2.save();
  testUser.openFlagCount = 1;
  await testUser.save();

  const res5b = await request(app)
    .post(`/api/admin/flags/${flag2._id}/action`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send();
  assert.strictEqual(res5b.status, 200);
  assert.strictEqual(flag2.status, 'actioned');
  assert.strictEqual(testUser.banned, true); // auto banned!
  assert.strictEqual(testUser.openFlagCount, 0); // decremented
  console.log('✓ Flag dismiss and auto-ban actions verify successfully.');

  // Test 6: Manual operations (unban, premium, badge)
  console.log('Testing Test 6: Manual user moderation...');
  // Unban user
  const res6a = await request(app)
    .post(`/api/admin/users/${testUser._id}/unban`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send();
  assert.strictEqual(res6a.status, 200);
  assert.strictEqual(testUser.banned, false);

  // Set premium status
  const res6b = await request(app)
    .post(`/api/admin/users/${testUser._id}/premium`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ isPremium: true });
  assert.strictEqual(res6b.status, 200);
  assert.strictEqual(testUser.isPremium, true);

  // Set badges
  const res6c = await request(app)
    .post(`/api/admin/users/${testUser._id}/badge`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ badges: ['verified-insider', 'top-profile'] });
  assert.strictEqual(res6c.status, 200);
  assert.deepStrictEqual(testUser.badges, ['verified-insider', 'top-profile']);

  console.log('✓ Manual moderation commands verify successfully.');
  console.log('--- Admin Flow Verification Succeeded! ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
