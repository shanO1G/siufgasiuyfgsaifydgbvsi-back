const assert = require('assert');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

// Mock User and AccountFlag Mongoose models
const User = require('../api/models/User');
const AccountFlag = require('../api/models/AccountFlag');
const EmailVerification = require('../api/models/EmailVerification');

const mockUsers = [];
const mockFlags = [];
const mockVerifications = [];

// Stub DB operations
User.findOne = async (query) => {
  const email = query.$or?.[0]?.email;
  const username = query.$or?.[1]?.username;
  return mockUsers.find(u => u.email === email || u.username === username || u.email === query.email || u.username === query.username) || null;
};

User.findById = async (id) => {
  return mockUsers.find(u => u._id.toString() === id.toString()) || null;
};

// Mock mongoose save
User.prototype.save = async function() {
  if (!this._id) this._id = new mongoose.Types.ObjectId();
  const index = mockUsers.findIndex(u => u._id.toString() === this._id.toString());
  if (index >= 0) {
    mockUsers[index] = this;
  } else {
    mockUsers.push(this);
  }
  return this;
};

AccountFlag.prototype.save = async function() {
  if (!this._id) this._id = new mongoose.Types.ObjectId();
  mockFlags.push(this);
  return this;
};

EmailVerification.prototype.save = async function() {
  if (!this._id) this._id = new mongoose.Types.ObjectId();
  mockVerifications.push(this);
  return this;
};

EmailVerification.findOne = async (query) => {
  return mockVerifications.find(v => v.email === query.email) || null;
};

// Set Node env to test so database won't auto-connect
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const app = require('../api/server');

async function runTests() {
  console.log('--- Starting Auth Flow Verification ---');

  // Test 1: Sign up under age 18 fails
  console.log('Testing Test 1: Signup under 18 rejection...');
  const res1 = await request(app)
    .post('/api/auth/signup')
    .send({
      email: 'student@stu.adamasuniversity.ac.in',
      username: 'student18',
      password: 'password123',
      name: 'Underage Student',
      age: 16
    });
  assert.strictEqual(res1.status, 400);
  assert.strictEqual(res1.body.error, 'You must be at least 18 years old to sign up');
  console.log('✓ Underage signup correctly rejected.');

  // Test 2: Valid signup creates user and triggers OTP for college email
  console.log('Testing Test 2: Valid college email signup...');
  const res2 = await request(app)
    .post('/api/auth/signup')
    .send({
      email: 'student@stu.adamasuniversity.ac.in',
      username: 'student1',
      password: 'password123',
      name: 'College Student',
      age: 20,
      gender: 'male',
      lookingFor: 'dating',
      bio: 'Just looking'
    });
  assert.strictEqual(res2.status, 201);
  assert.strictEqual(res2.body.otpSent, true);
  assert.strictEqual(res2.body.user.emailVerified, false);
  console.log('✓ College signup succeeded and OTP triggered.');

  // Test 3: Login fails with incorrect password
  console.log('Testing Test 3: Login password failure...');
  const res3 = await request(app)
    .post('/api/auth/login')
    .send({
      identity: 'student@stu.adamasuniversity.ac.in',
      password: 'wrongpassword'
    });
  assert.strictEqual(res3.status, 401);
  assert.strictEqual(res3.body.error, 'Invalid username/email or password');
  console.log('✓ Login failure correctly handled.');

  // Test 4: Login succeeds with correct password
  console.log('Testing Test 4: Correct login credentials...');
  const res4 = await request(app)
    .post('/api/auth/login')
    .send({
      identity: 'student@stu.adamasuniversity.ac.in',
      password: 'password123'
    });
  assert.strictEqual(res4.status, 200);
  assert.ok(res4.headers['set-cookie']);
  console.log('✓ Login succeeded and cookie set.');

  console.log('--- Auth Flow Verification Succeeded! ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
