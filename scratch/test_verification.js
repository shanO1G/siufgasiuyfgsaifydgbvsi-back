const assert = require('assert');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

// Mock User, AccountFlag, IdentityVerificationRequest Mongoose models
const User = require('../api/models/User');
const AccountFlag = require('../api/models/AccountFlag');
const IdentityVerificationRequest = require('../api/models/IdentityVerificationRequest');

let mockUser = {
  _id: new mongoose.Types.ObjectId(),
  email: 'test@stu.adamasuniversity.ac.in',
  username: 'testuser',
  identityStatus: 'not_submitted',
  openFlagCount: 0,
  save: async function() { return this; }
};

const mockFlags = [];
const mockRequests = [];

// Stub DB operations
User.findById = async (id) => mockUser;
User.findOne = async () => null;

IdentityVerificationRequest.findOne = async (query) => {
  // If we are looking for a duplicate, check if there's any request with the same hash
  const andCond = query.$and;
  if (andCond) {
    const isDuplicateQuery = andCond[1].$or;
    const searchHash = isDuplicateQuery[0].idCardHash;
    return mockRequests.find(r => r.idCardHash === searchHash && r.userId.toString() !== mockUser._id.toString()) || null;
  }
  return null;
};

IdentityVerificationRequest.prototype.save = async function() {
  this._id = new mongoose.Types.ObjectId();
  mockRequests.push(this);
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

// Stub authRequired middleware to bypass JWT for ease of testing
const authMiddleware = require('../api/middleware/auth');
authMiddleware.authRequired = (req, res, next) => {
  req.user = { id: mockUser._id, username: mockUser.username };
  next();
};

const app = require('../api/server');

async function runTests() {
  console.log('--- Starting Verification Flow Testing ---');

  // Test 1: Submit verification missing files fails
  console.log('Testing Test 1: Submit missing files...');
  const res1 = await request(app)
    .post('/api/verification/identity/submit')
    .send();
  assert.strictEqual(res1.status, 400);
  assert.strictEqual(res1.body.error, 'Both idCard and face files are required');
  console.log('✓ Missing files submission correctly blocked.');

  // Test 2: Submit verification with valid files succeeds
  console.log('Testing Test 2: Submit valid files...');
  const dummyBuffer = Buffer.from('fake-image-bytes');
  const res2 = await request(app)
    .post('/api/verification/identity/submit')
    .attach('idCard', dummyBuffer, 'id_card.png')
    .attach('face', dummyBuffer, 'face.png');

  assert.strictEqual(res2.status, 201);
  assert.strictEqual(res2.body.status, 'pending');
  assert.strictEqual(mockUser.identityStatus, 'pending');
  assert.strictEqual(mockRequests.length, 1);
  console.log('✓ Valid files submission succeeded.');

  // Test 3: Resubmit when not unverified fails
  console.log('Testing Test 3: Resubmit when status is pending...');
  const res3 = await request(app)
    .post('/api/verification/identity/resubmit')
    .attach('idCard', dummyBuffer, 'id_card.png')
    .attach('face', dummyBuffer, 'face.png');
  assert.strictEqual(res3.status, 400);
  assert.strictEqual(res3.body.error, 'You can only resubmit if your verification status is unverified');
  console.log('✓ Resubmission on wrong state blocked.');

  // Test 4: Duplicate verification hash triggers account flagging
  console.log('Testing Test 4: Duplicate verification detection...');
  // Force user status back to not_submitted to allow a new submission
  mockUser.identityStatus = 'not_submitted';
  // Create another user to own the original request
  const originalUserRequest = {
    userId: new mongoose.Types.ObjectId(),
    idCardHash: mockRequests[0].idCardHash,
    faceHash: mockRequests[0].faceHash
  };
  mockRequests.push(originalUserRequest);

  const res4 = await request(app)
    .post('/api/verification/identity/submit')
    .attach('idCard', dummyBuffer, 'id_card.png')
    .attach('face', dummyBuffer, 'face.png');

  assert.strictEqual(res4.status, 201);
  assert.strictEqual(mockFlags.length, 1);
  assert.strictEqual(mockFlags[0].flagType, 'duplicate_identity_document');
  assert.strictEqual(mockFlags[0].severity, 'high');
  console.log('✓ Duplicate hashes correctly flagged.');

  console.log('--- Verification Flow Testing Succeeded! ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
