/**
 * Seed Script — College Dating App
 * Usage (from project root): node scratch/seed.js
 *
 * Seeds the database with:
 *   - 1 admin account
 *   - 12 users (mix of genders, verified/unverified, college/outsider)
 *   - some likes and mutual matches
 *   - some reports, blocks, anonymous posts, feedback, announcements
 *   - a few account flags
 *
 * Credentials printed to console at the end.
 */

const path = require('path');
const API_DIR = path.join(__dirname, '..', 'api');

// Load .env from api/
require(path.join(API_DIR, 'node_modules', 'dotenv')).config({ path: path.join(API_DIR, '.env') });

// Ensure all requires resolve from api/node_modules
process.chdir(API_DIR);

const mongoose = require(path.join(API_DIR, 'node_modules', 'mongoose'));
const bcrypt   = require(path.join(API_DIR, 'node_modules', 'bcryptjs'));

// ─── Models ──────────────────────────────────────────────────────────────────
const User = require('../api/models/User');
const Admin = require('../api/models/Admin');
const Like = require('../api/models/Like');
const Match = require('../api/models/Match');
const Block = require('../api/models/Block');
const Report = require('../api/models/Report');
const AccountFlag = require('../api/models/AccountFlag');
const AnonymousPost = require('../api/models/AnonymousPost');
const Feedback = require('../api/models/Feedback');
const Announcement = require('../api/models/Announcement');
const AdminAction = require('../api/models/AdminAction');
const EmailVerification = require('../api/models/EmailVerification');
const IdentityVerificationRequest = require('../api/models/IdentityVerificationRequest');

// ─── Helpers ──────────────────────────────────────────────────────────────────
const hash = (plain, rounds = 10) => bcrypt.hash(plain, rounds);

const IMAGEKIT_BASE = 'https://ik.imagekit.io/demo/img';

// Realistic placeholder ImageKit demo images
const AVATAR_URLS = [
  { url: `${IMAGEKIT_BASE}/default-image.jpg`, fileId: 'demo_1' },
  { url: `${IMAGEKIT_BASE}/sample-video-thumbnail.jpg`, fileId: 'demo_2' },
  { url: `https://randomuser.me/api/portraits/men/32.jpg`, fileId: 'demo_3' },
  { url: `https://randomuser.me/api/portraits/women/44.jpg`, fileId: 'demo_4' },
  { url: `https://randomuser.me/api/portraits/men/55.jpg`, fileId: 'demo_5' },
  { url: `https://randomuser.me/api/portraits/women/65.jpg`, fileId: 'demo_6' },
  { url: `https://randomuser.me/api/portraits/men/12.jpg`, fileId: 'demo_7' },
  { url: `https://randomuser.me/api/portraits/women/18.jpg`, fileId: 'demo_8' },
  { url: `https://randomuser.me/api/portraits/men/73.jpg`, fileId: 'demo_9' },
  { url: `https://randomuser.me/api/portraits/women/90.jpg`, fileId: 'demo_10' },
  { url: `https://randomuser.me/api/portraits/men/48.jpg`, fileId: 'demo_11' },
  { url: `https://randomuser.me/api/portraits/women/29.jpg`, fileId: 'demo_12' },
];

// Raw user definitions (password will be "Password@123" for all)
const USER_PASSWORD = 'Password@123';
const ADMIN_PASSWORD = 'AdminSecure@2026';
const COMMON_PASS    = 'common-admin-secret-password-123';

const USER_DEFS = [
  {
    name: 'Arjun Sharma',
    username: 'arjun_s',
    email: 'arjun@stu.adamasuniversity.ac.in',
    age: 21,
    gender: 'male',
    school: 'Adamas University',
    course: 'CSE',
    height: 178,
    lookingFor: 'dating',
    bio: 'Coffee addict ☕ | DSA nerd | Looking for someone to debug life with.',
    hobbies: ['Coding', 'Chess', 'Gaming'],
    skills: ['JavaScript', 'Python', 'React'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'verified',
    isPremium: false,
    tags: { smoke: false, drink: false, pets: true },
  },
  {
    name: 'Priya Dey',
    username: 'priya_d',
    email: 'priya@stu.adamasuniversity.ac.in',
    age: 20,
    gender: 'female',
    school: 'Adamas University',
    course: 'BCA',
    height: 162,
    lookingFor: 'dating',
    bio: 'Art lover 🎨 | Foodie | Certified overthinker.',
    hobbies: ['Painting', 'Reading', 'Cooking'],
    skills: ['Figma', 'CSS', 'Illustration'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'verified',
    isPremium: true,
    badges: ['Early Adopter'],
    tags: { smoke: false, drink: false, pets: false },
  },
  {
    name: 'Rahul Biswas',
    username: 'rahul_b',
    email: 'rahul@stu.adamasuniversity.ac.in',
    age: 22,
    gender: 'male',
    school: 'Adamas University',
    course: 'ECE',
    height: 175,
    lookingFor: 'friends',
    bio: 'Into robotics and weird sci-fi novels.',
    hobbies: ['Robotics', 'Reading', 'Cycling'],
    skills: ['C++', 'Arduino', 'MATLAB'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'pending',
    isPremium: false,
    tags: { smoke: false, drink: true, pets: false },
  },
  {
    name: 'Sneha Roy',
    username: 'sneha_r',
    email: 'sneha@stu.adamasuniversity.ac.in',
    age: 19,
    gender: 'female',
    school: 'Adamas University',
    course: 'MBA',
    height: 165,
    lookingFor: 'dating',
    bio: 'Entrepreneur in the making 🚀 | Chai > Coffee.',
    hobbies: ['Business', 'Travel', 'Photography'],
    skills: ['Marketing', 'Excel', 'Public Speaking'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'verified',
    isPremium: false,
    tags: { smoke: false, drink: false, pets: true },
  },
  {
    name: 'Karan Mehta',
    username: 'karan_m',
    email: 'karan@gmail.com',          // outsider — non-college email
    age: 23,
    gender: 'male',
    school: 'Delhi University',
    course: 'B.Com',
    height: 180,
    lookingFor: 'dating',
    bio: 'Gym rat by day, meme lord by night.',
    hobbies: ['Gym', 'Football', 'Memes'],
    skills: ['Excel', 'Tally', 'Trading'],
    sexualOrientation: 'straight',
    emailVerified: false,              // outsider — cannot college-verify
    identityStatus: 'not_submitted',
    isPremium: false,
    tags: { smoke: false, drink: true, pets: false },
  },
  {
    name: 'Ananya Ghosh',
    username: 'ananya_g',
    email: 'ananya@stu.adamasuniversity.ac.in',
    age: 20,
    gender: 'female',
    school: 'Adamas University',
    course: 'BSc Physics',
    height: 158,
    lookingFor: 'friends',
    bio: 'Star-gazer 🌌 | Quantum enthusiast | Introvert trying to be social.',
    hobbies: ['Astronomy', 'Gaming', 'Anime'],
    skills: ['Python', 'Data Analysis', 'LaTeX'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'unverified',
    identityReviewReason: 'ID card image was too blurry.',
    isPremium: false,
    tags: { smoke: false, drink: false, pets: true },
  },
  {
    name: 'Dev Kapoor',
    username: 'dev_k',
    email: 'dev@stu.adamasuniversity.ac.in',
    age: 21,
    gender: 'male',
    school: 'Adamas University',
    course: 'BBA',
    height: 182,
    lookingFor: 'dating',
    bio: 'Finance bro who somehow ended up here. Send help (and swipes).',
    hobbies: ['Cricket', 'Investing', 'Cooking'],
    skills: ['Finance', 'Leadership', 'Public Speaking'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'verified',
    isPremium: true,
    badges: ['Verified', 'Early Adopter'],
    tags: { smoke: false, drink: true, pets: false },
  },
  {
    name: 'Riya Mukherjee',
    username: 'riya_m',
    email: 'riya@gmail.com',           // outsider
    age: 22,
    gender: 'female',
    school: 'Presidency University',
    course: 'English Honours',
    height: 163,
    lookingFor: 'dating',
    bio: 'Bookworm | Tea obsessed | Will talk about Austen for hours.',
    hobbies: ['Reading', 'Writing', 'Theatre'],
    skills: ['Creative Writing', 'Editing', 'Research'],
    sexualOrientation: 'straight',
    emailVerified: false,
    identityStatus: 'not_submitted',
    isPremium: false,
    tags: { smoke: false, drink: false, pets: true },
  },
  {
    name: 'Aman Verma',
    username: 'aman_v',
    email: 'aman@stu.adamasuniversity.ac.in',
    age: 20,
    gender: 'male',
    school: 'Adamas University',
    course: 'CSE AI/ML',
    height: 176,
    lookingFor: 'friends',
    bio: 'Training models all day, trying to find human connection IRL.',
    hobbies: ['Machine Learning', 'Badminton', 'Music'],
    skills: ['Python', 'TensorFlow', 'PyTorch'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'verified',
    isPremium: false,
    tags: { smoke: false, drink: false, pets: false },
  },
  {
    name: 'Pooja Nair',
    username: 'pooja_n',
    email: 'pooja@stu.adamasuniversity.ac.in',
    age: 21,
    gender: 'female',
    school: 'Adamas University',
    course: 'CSE',
    height: 161,
    lookingFor: 'dating',
    bio: 'Frontend dev who actually cares about UX. Rare species.',
    hobbies: ['UI Design', 'Dancing', 'Travel'],
    skills: ['React', 'Figma', 'TailwindCSS'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'verified',
    isPremium: false,
    tags: { smoke: false, drink: false, pets: true },
  },
  {
    name: 'Sahil Das',
    username: 'sahil_d',
    email: 'sahil@stu.adamasuniversity.ac.in',
    age: 22,
    gender: 'male',
    school: 'Adamas University',
    course: 'MCA',
    height: 174,
    lookingFor: 'dating',
    bio: 'Backend dev and occasional philosopher. Ask me about databases at 2 AM.',
    hobbies: ['Coding', 'Chess', 'Running'],
    skills: ['Node.js', 'MongoDB', 'Docker'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'verified',
    isPremium: false,
    tags: { smoke: false, drink: false, pets: false },
    banned: false
  },
  {
    name: 'Nisha Joshi',
    username: 'nisha_j',
    email: 'nisha@stu.adamasuniversity.ac.in',
    age: 19,
    gender: 'female',
    school: 'Adamas University',
    course: 'BCA',
    height: 160,
    lookingFor: 'dating',
    bio: 'Spotify wrapped says I listened to Taylor Swift for 8000 hours. Not sorry.',
    hobbies: ['Music', 'Singing', 'Photography'],
    skills: ['Photoshop', 'Video Editing', 'Social Media'],
    sexualOrientation: 'straight',
    emailVerified: true,
    identityStatus: 'verified',
    isPremium: false,
    tags: { smoke: false, drink: false, pets: true },
  },
];

const POSTS = [
  "Anyone else's WiFi drop exactly when their assignment is due? 😭",
  'The canteen coffee should be classified as a biohazard. Fight me.',
  'Unpopular opinion: group projects are just individual projects with extra anxiety.',
  'Found ₹10 on the ground. I am rich. Do not approach me.',
  'If you borrowed my charger and never returned it, I hope you step on a Lego.',
  'The library AC is always on full blast. Bring a sweater. You were warned.',
];

const FEEDBACK_MSGS = [
  'Love the app! Would be great to have a dark mode.',
  'The identity verification took a few days but process was smooth.',
  'Please add more profile fields — favourite movies, music taste etc.',
  'The anonymous posts feature is fun! More people should know about it.',
];

// ─── Main ─────────────────────────────────────────────────────────────────────
async function seed() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('❌  MONGODB_URI not set in environment. Make sure api/.env exists.');
    process.exit(1);
  }

  console.log('🔌  Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('✅  Connected.\n');

  // ── Wipe existing seed data ──────────────────────────────────────────────
  console.log('🗑   Clearing existing data...');
  await Promise.all([
    User.deleteMany({}),
    Admin.deleteMany({}),
    Like.deleteMany({}),
    Match.deleteMany({}),
    Block.deleteMany({}),
    Report.deleteMany({}),
    AccountFlag.deleteMany({}),
    AnonymousPost.deleteMany({}),
    Feedback.deleteMany({}),
    Announcement.deleteMany({}),
    AdminAction.deleteMany({}),
    EmailVerification.deleteMany({}),
    IdentityVerificationRequest.deleteMany({}),
  ]);
  console.log('✅  Database cleared.\n');

  // ── Create Admin ─────────────────────────────────────────────────────────
  console.log('👤  Creating admin account...');
  const adminEmail = (process.env.ADMIN_EMAILS || '').split(',')[0].trim();
  if (!adminEmail) {
    console.warn('⚠️   ADMIN_EMAILS not set — skipping admin creation.');
  } else {
    const adminPasswordHash = await hash(ADMIN_PASSWORD, 12);
    const admin = new Admin({ email: adminEmail, passwordHash: adminPasswordHash, active: true });
    await admin.save();
    console.log(`✅  Admin created: ${adminEmail}`);
  }

  // ── Create Users ─────────────────────────────────────────────────────────
  console.log('\n👥  Creating users...');
  const userPasswordHash = await hash(USER_PASSWORD, 10);

  const createdUsers = [];
  for (let i = 0; i < USER_DEFS.length; i++) {
    const def = USER_DEFS[i];
    const user = new User({
      ...def,
      passwordHash: userPasswordHash,
      pictures: [AVATAR_URLS[i]],
    });
    await user.save();
    createdUsers.push(user);
    console.log(`  ➕  ${user.name} (${user.username}) — ${user.gender}, ${user.emailVerified ? 'insider' : 'outsider'}, identity: ${user.identityStatus}`);
  }

  // ── Likes & Matches ───────────────────────────────────────────────────────
  console.log('\n💘  Creating likes and matches...');

  // Helper to find user by username
  const byUsername = (u) => createdUsers.find(x => x.username === u);

  const arjun  = byUsername('arjun_s');
  const priya  = byUsername('priya_d');
  const rahul  = byUsername('rahul_b');
  const sneha  = byUsername('sneha_r');
  const karan  = byUsername('karan_m');
  const ananya = byUsername('ananya_g');
  const dev    = byUsername('dev_k');
  const riya   = byUsername('riya_m');
  const aman   = byUsername('aman_v');
  const pooja  = byUsername('pooja_n');
  const sahil  = byUsername('sahil_d');
  const nisha  = byUsername('nisha_j');

  // Mutual likes → matches
  const mutualPairs = [
    [arjun, priya],    // match 1
    [dev, sneha],      // match 2
    [sahil, nisha],    // match 3
    [aman, pooja],     // match 4
  ];

  for (const [a, b] of mutualPairs) {
    await Like.create({ fromUserId: a._id, toUserId: b._id, type: 'like' });
    await Like.create({ fromUserId: b._id, toUserId: a._id, type: 'like' });
    const conversationId = `conv_${[a._id.toString(), b._id.toString()].sort().join('_')}`;
    await Match.create({ userA: a._id, userB: b._id, conversationId });
    console.log(`  💞  ${a.name} ↔ ${b.name} matched`);
  }

  // One-sided likes (no match yet)
  const oneSidedLikes = [
    [karan, priya, 'like'],
    [rahul, sneha, 'superlike'],
    [ananya, aman, 'like'],
    [riya, dev, 'like'],
  ];
  for (const [from, to, type] of oneSidedLikes) {
    await Like.create({ fromUserId: from._id, toUserId: to._id, type });
    console.log(`  👍  ${from.name} → ${to.name} (${type})`);
  }

  // ── Blocks ────────────────────────────────────────────────────────────────
  console.log('\n🚫  Creating blocks...');
  await Block.create({ blockerId: priya._id, blockedId: karan._id });
  await Block.create({ blockerId: nisha._id, blockedId: rahul._id });
  console.log('  ✅  2 blocks created');

  // ── Reports ───────────────────────────────────────────────────────────────
  console.log('\n🚩  Creating reports...');
  await Report.insertMany([
    { reporterId: arjun._id, targetUserId: karan._id, reason: 'Sending inappropriate messages', status: 'open' },
    { reporterId: priya._id, targetUserId: karan._id, reason: 'Fake profile suspected', status: 'open' },
    { reporterId: sneha._id, targetUserId: karan._id, reason: 'Harassment', status: 'reviewed' },
  ]);
  console.log('  ✅  3 reports created');

  // ── Account Flags ─────────────────────────────────────────────────────────
  console.log('\n🏴  Creating account flags...');
  await AccountFlag.insertMany([
    {
      userId: karan._id,
      flagType: 'mass_report_target',
      severity: 'high',
      details: { reportCount: 3 },
      status: 'open',
    },
    {
      userId: rahul._id,
      flagType: 'like_velocity_spike',
      severity: 'low',
      details: { count: 8, action: 'like' },
      status: 'open',
    },
    {
      userId: ananya._id,
      flagType: 'repeated_verification_rejection',
      severity: 'medium',
      details: { priorRejections: 2 },
      status: 'open',
    },
  ]);

  // Sync openFlagCount
  await User.findByIdAndUpdate(karan._id, { openFlagCount: 1 });
  await User.findByIdAndUpdate(rahul._id, { openFlagCount: 1 });
  await User.findByIdAndUpdate(ananya._id, { openFlagCount: 1 });
  console.log('  ✅  3 flags created');

  // ── Anonymous Posts ───────────────────────────────────────────────────────
  console.log('\n📝  Creating anonymous posts...');
  const postDocs = POSTS.map(content => ({ content }));
  await AnonymousPost.insertMany(postDocs);
  console.log(`  ✅  ${POSTS.length} posts created`);

  // ── Feedback ──────────────────────────────────────────────────────────────
  console.log('\n💬  Creating feedback...');
  const feedbackUsers = [arjun, priya, rahul, sneha];
  await Feedback.insertMany(
    FEEDBACK_MSGS.map((content, i) => ({ userId: feedbackUsers[i]._id, content }))
  );
  console.log(`  ✅  ${FEEDBACK_MSGS.length} feedback entries created`);

  // ── Announcement ─────────────────────────────────────────────────────────
  console.log('\n📢  Creating announcement...');
  const adminDoc = await Admin.findOne();
  if (adminDoc) {
    await Announcement.create({
      title: '🎉 Welcome to Frnd Beta!',
      content: 'We\'re so excited to have you here! Frnd is a college dating & friendship app built for Adamas University. Explore, connect, and be yourself. Give us your feedback — we read everything!',
      adminId: adminDoc._id,
    });
    console.log('  ✅  Announcement created');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('🌱  SEED COMPLETE\n');
  console.log('📋  Login Credentials');
  console.log('─'.repeat(60));
  console.log(`  ADMIN`);
  console.log(`    Email   : ${adminEmail || '(not created — ADMIN_EMAILS not set)'}`);
  console.log(`    Password: ${ADMIN_PASSWORD}`);
  console.log(`    Common  : ${COMMON_PASS}`);
  console.log('');
  console.log(`  ALL USERS  (password: ${USER_PASSWORD})`);
  console.log('─'.repeat(60));
  for (const u of createdUsers) {
    console.log(`  ${u.username.padEnd(14)} | ${u.email}`);
  }
  console.log('─'.repeat(60));
  console.log('\n  Notable accounts:');
  console.log(`  • arjun_s  ↔ priya_d   → matched ✅`);
  console.log(`  • dev_k    ↔ sneha_r   → matched ✅`);
  console.log(`  • sahil_d  ↔ nisha_j   → matched ✅`);
  console.log(`  • aman_v   ↔ pooja_n   → matched ✅`);
  console.log(`  • karan_m              → 3 reports, 1 open flag (high)`);
  console.log(`  • ananya_g             → identity unverified, 1 open flag`);
  console.log('─'.repeat(60));

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(err => {
  console.error('❌  Seed failed:', err);
  mongoose.disconnect();
  process.exit(1);
});
