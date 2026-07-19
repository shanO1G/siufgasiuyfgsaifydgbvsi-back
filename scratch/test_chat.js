const assert = require('assert');
const ioClient = require('socket.io-client');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// Mock models
const User = require('../chat/models/User');
const Match = require('../chat/models/Match');
const Message = require('../chat/models/Message');
const AccountFlag = require('../chat/models/AccountFlag');

const mockUserAId = new mongoose.Types.ObjectId();
const mockUserBId = new mongoose.Types.ObjectId();
const conversationId = `conv_${[mockUserAId.toString(), mockUserBId.toString()].sort().join('_')}`;

let mockFlags = [];
let bulkWriteOps = [];

// Stubs
Match.findOne = async (query) => {
  if (query.conversationId === conversationId) {
    return {
      userA: mockUserAId,
      userB: mockUserBId,
      conversationId
    };
  }
  return null;
};

User.findById = async (id) => {
  return {
    _id: id,
    openFlagCount: 0,
    save: async function() { return this; }
  };
};

Message.bulkWrite = async (ops) => {
  bulkWriteOps.push(...ops);
  return { insertedCount: ops.length };
};

AccountFlag.prototype.save = async function() {
  mockFlags.push(this);
  return this;
};

// Start Server in test mode (no DB connection)
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.CHAT_PORT = 5099;

const server = require('../chat/server');
const redis = require('../chat/utils/redis');

function connectSocket(userId) {
  const token = jwt.sign({ id: userId, username: `user_${userId}` }, 'test-secret');
  return ioClient.connect(`http://localhost:5099`, {
    query: { token },
    transports: ['websocket'],
    forceNew: true
  });
}

async function runTests() {
  console.log('--- Starting Chat Service Flow Verification ---');
  
  // Start server listening
  await new Promise((resolve) => server.listen(5099, resolve));
  console.log('Chat test server listening on port 5099');

  // Test 1: Handshake with JWT connects successfully
  console.log('Testing Test 1: Authorized socket connection...');
  const socketA = connectSocket(mockUserAId.toString());
  
  await new Promise((resolve, reject) => {
    socketA.on('connect', resolve);
    socketA.on('connect_error', reject);
  });
  console.log('✓ Socket A connected successfully.');

  // Verify presence is updated in Redis
  const presence = await redis.get(`presence:${mockUserAId}`);
  assert.strictEqual(presence, '1');
  console.log('✓ Presence correctly set in Redis.');

  // Test 2: Message relaying and batch queuing
  console.log('Testing Test 2: Join room, send message and verify relay...');
  const socketB = connectSocket(mockUserBId.toString());
  await new Promise((resolve) => socketB.on('connect', resolve));
  console.log('✓ Socket B connected successfully.');

  socketA.emit('join_conversation', { conversationId });
  socketB.emit('join_conversation', { conversationId });

  // Set up message listener on socket B
  const messageReceivedPromise = new Promise((resolve) => {
    socketB.on('message_received', (data) => {
      resolve(data);
    });
  });

  const payload = {
    conversationId,
    ciphertext: 'encrypted-message-payload',
    iv: 'encryption-initialization-vector'
  };
  
  socketA.emit('send_message', payload);

  const receivedData = await messageReceivedPromise;
  assert.strictEqual(receivedData.conversationId, conversationId);
  assert.strictEqual(receivedData.ciphertext, 'encrypted-message-payload');
  assert.strictEqual(receivedData.iv, 'encryption-initialization-vector');
  console.log('✓ Message relayed correctly between sockets.');

  // Test 3: Message spam velocity check (> 5 distinct conversations)
  console.log('Testing Test 3: Chat spam checking...');
  // Force clean up redis touched conversations
  await redis.del(`user:${mockUserAId}:conversations_messaged`);

  // Mock Match findOne to accept multiple rooms
  Match.findOne = async () => ({
    userA: mockUserAId,
    userB: mockUserBId,
    conversationId
  });

  for (let i = 1; i <= 6; i++) {
    socketA.emit('send_message', {
      conversationId: `conv_room_${i}`,
      ciphertext: 'spam',
      iv: 'spam-iv'
    });
  }

  // Wait a bit for async socket processing
  await new Promise((resolve) => setTimeout(resolve, 300));

  const spamFlag = mockFlags.find(f => f.flagType === 'message_spam_pattern');
  assert.ok(spamFlag);
  assert.strictEqual(spamFlag.severity, 'medium');
  console.log('✓ Message spamming pattern correctly flagged.');

  // Close connections
  socketA.disconnect();
  socketB.disconnect();
  server.close();
  
  console.log('--- Chat Service Flow Verification Succeeded! ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
