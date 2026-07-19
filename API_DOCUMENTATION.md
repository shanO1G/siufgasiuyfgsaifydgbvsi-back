# College Dating App — Backend API Specification & Integration Guide

This document provides complete instructions for developers integrating with the backend API and Chat services.

---

## 1. Environment & Architecture Overview

The backend consists of two separate services running in parallel, connected to MongoDB Atlas and Upstash Redis.

### Deployment Endpoints
- **Production REST API Base URL**: `https://frnd-api-n3hv.onrender.com`
- **Production Chat WebSocket URL**: `https://frnd-chat-a2cm.onrender.com`
- **Local Dev REST API**: `http://localhost:5000`
- **Local Dev Chat WebSocket**: `http://localhost:5001`

### CORS Policy

| Route group | Allowed origins |
|---|---|
| `/api/admin/*` | `ADMIN_PANEL_ORIGIN` only (env var) — any other origin receives HTTP 403 |
| All other `/api/*` | Origins listed in `APP_ORIGINS` env var (comma-separated) — any other origin receives HTTP 403 |
| Socket.IO (Chat) | Same `APP_ORIGINS` allowlist |

> **Note:** Both services require an `APP_ORIGINS` environment variable listing permitted frontend origins (e.g. `http://localhost:3000,http://localhost:5173` or your production Vercel/Netlify URLs). Requests from unlisted origins are rejected with CORS policy errors.

---

## 1.1. Quick Integration Guide for Frontend Developers

### A. How to Authenticate & Pass the Token
To make integration smooth, the API supports two ways to authenticate:

1. **Automatic Cookie-Based (Recommended for Web)**
   - When you call `/api/auth/signup` or `/api/auth/login`, the server automatically sends back a secure `SameSite=Lax` cookie named `token` containing your JWT.
   - For all subsequent requests, make sure your HTTP client includes credentials:
     - **Fetch API**: Pass `{ credentials: 'include' }` in the options.
     - **Axios**: Set `withCredentials: true` in your global config or request options.
   - *Note on local testing:* If you are running the frontend on `localhost` and calling the production Render API, Chrome/Safari may block cross-origin cookies. If that happens, use the Authorization header fallback below.

2. **Authorization Header Fallback (Recommended for Testing & Native Apps)**
   - After signing up or logging in, the server returns the user object. Although the HTTP-only cookie is set, you can also authenticate on subsequent requests by sending the token manually:
     - Header: `Authorization: Bearer <your_jwt_token>`
   - For admins, **only** the Authorization header is accepted (using `Authorization: Bearer <admin_token>`).

### B. Testing your requests locally
You can use tools like Postman, Thunder Client, or cURL to query the endpoints. Since cURL/Postman do not enforce browser CORS policies, you can query directly.
Example login:
```bash
curl -X POST https://frnd-api-n3hv.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identity": "arjun_s", "password": "Password@123"}'
```

---

## 2. Authentication Model

### Regular Users
- JWT delivered as an **HTTP-only `SameSite=Lax` cookie** named `token`.
- Set automatically on signup and login; cleared on logout.
- Expires in 7 days.
- All protected routes read this cookie — no `Authorization` header needed.

### Admin Users
- Separate identity model — no overlap with regular `users` collection.
- JWT delivered as a **bearer token** in the response body (held in SPA memory).
- All admin routes require `Authorization: Bearer <admin_token>` header.
- Admin tokens carry `aud: 'admin-panel'` claim — rejected on all regular user routes.
- Expires in 24 hours.

---

## 3. Regular User REST API

### Authentication (`/api/auth`)

#### POST `/api/auth/signup`

Create a new user account.

**Headers:** `Content-Type: application/json`

**Body:**
```json
{
  "email": "student@stu.adamasuniversity.ac.in",
  "username": "johndoe",
  "password": "securepassword123",
  "name": "John Doe",
  "age": 20,
  "gender": "male",
  "lookingFor": "dating",
  "bio": "Optional bio text"
}
```

| Field | Required | Rules |
|---|---|---|
| `email` | Yes | Any valid email |
| `username` | Yes | Max 50 chars, must be unique |
| `password` | Yes | 8–128 chars |
| `name` | Yes | Max 100 chars |
| `age` | Yes | Integer, minimum 18 |
| `gender` | No | `"male"` \| `"female"` \| `"other"` |
| `lookingFor` | No | `"friends"` \| `"dating"` |
| `bio` | No | Max 500 chars |

**Response (201 Created):**
```json
{
  "message": "Signup successful",
  "user": {
    "id": "651a2b3c4d5e6f7a8b9c0d1e",
    "email": "student@stu.adamasuniversity.ac.in",
    "username": "johndoe",
    "name": "John Doe",
    "emailVerified": false,
    "identityStatus": "not_submitted"
  },
  "otpSent": true
}
```

> If the email matches `/@stu\.adamasuniversity\.ac\.in$/i`, a 6-digit OTP is sent for college email verification. The session cookie is set immediately after signup.

---

#### POST `/api/auth/verify-otp`

Confirm the email OTP sent at signup. Requires authentication cookie.

**Body:**
```json
{ "otp": "123456" }
```

**Response (200 OK):**
```json
{ "message": "Email verified successfully", "emailVerified": true }
```

- OTP expires after 10 minutes.
- Max **5 incorrect attempts** before the code is locked (request a new one with resend-otp).

---

#### POST `/api/auth/resend-otp`

Request a fresh OTP. Requires authentication cookie.

**Response (200 OK):**
```json
{ "message": "Verification code sent successfully" }
```

- Rate-limited to **1 request per 60 seconds**.

---

#### POST `/api/auth/login`

Log in with email or username.

**Body:**
```json
{
  "identity": "johndoe",
  "password": "securepassword123"
}
```

**Response (200 OK):**
```json
{
  "message": "Login successful",
  "user": {
    "id": "651a2b3c4d5e6f7a8b9c0d1e",
    "email": "student@stu.adamasuniversity.ac.in",
    "username": "johndoe",
    "name": "John Doe",
    "emailVerified": true,
    "identityStatus": "verified"
  }
}
```

> Sets an HTTP-only secure cookie named `token`. After 5 consecutive failed login attempts for an account, a `login_brute_force` flag is raised for admin review.

---

#### POST `/api/auth/logout`

Clear the session cookie. Requires authentication cookie.

**Response (200 OK):**
```json
{ "message": "Logout successful" }
```

---

### Own Profile (`/api/users`)

#### GET `/api/users/me`

Fetch the authenticated user's own full profile. Requires authentication cookie.

**Response (200 OK):**
```json
{
  "user": {
    "_id": "651a2b3c4d5e6f7a8b9c0d1e",
    "email": "student@stu.adamasuniversity.ac.in",
    "username": "johndoe",
    "name": "John Doe",
    "age": 20,
    "gender": "male",
    "school": "Adamas University",
    "course": "CSE",
    "bio": "My bio",
    "hobbies": ["Coding", "Chess"],
    "skills": ["JavaScript"],
    "pictures": [{ "url": "https://...", "fileId": "file_123" }],
    "lookingFor": "dating",
    "emailVerified": true,
    "identityStatus": "verified",
    "isPremium": false,
    "badges": [],
    "openFlagCount": 0
  }
}
```

---

#### PUT `/api/users/me`

Update the authenticated user's own profile. Requires authentication cookie.

> Only the fields listed below can be updated. Fields like `email`, `username`, `password`, `banned`, `isPremium`, and `badges` are immutable through this endpoint.

**Body (all fields optional — send only what you want to update):**
```json
{
  "name": "John Updated",
  "bio": "New bio text",
  "school": "Adamas University",
  "course": "CSE",
  "height": 175,
  "hobbies": ["Coding", "Chess"],
  "skills": ["JavaScript", "Python"],
  "lookingFor": "dating",
  "sexualOrientation": "straight",
  "tags": { "smoke": false, "drink": false, "pets": true },
  "pictures": [
    { "url": "https://...", "fileId": "imagekit_file_id" }
  ]
}
```

| Field | Rules |
|---|---|
| `name` | Max 100 chars |
| `bio` | Max 500 chars |
| `school` | Max 150 chars |
| `course` | Max 150 chars |
| `height` | Number (cm) |
| `hobbies` | Array, max 20 items |
| `skills` | Array, max 20 items |
| `lookingFor` | `"friends"` \| `"dating"` |
| `pictures` | Array, max 4 items; each must have `url` and `fileId` |

**Response (200 OK):**
```json
{ "message": "Profile updated successfully", "user": { ... } }
```

---

### Identity Verification (`/api/verification`)

#### POST `/api/verification/identity/submit`

Submit ID card and face images for identity verification. Requires authentication cookie.

**Headers:** `Content-Type: multipart/form-data`

**Multipart fields:**

| Field | Required | Rules |
|---|---|---|
| `idCard` | Yes | JPEG, PNG, or WebP only — max 5 MB |
| `face` | Yes | JPEG, PNG, or WebP only — max 5 MB |

**Response (201 Created):**
```json
{
  "message": "Identity verification request submitted successfully",
  "status": "pending"
}
```

> - Only callable when `identityStatus` is `"not_submitted"`.
> - Perceptual hash is computed on both images and checked against all existing submissions. A match on another user's account raises a `duplicate_identity_document` flag immediately.
> - Images are uploaded to Cloudinary with `authenticated` (private) delivery.

---

#### POST `/api/verification/identity/resubmit`

Resubmit after a rejection. Same body as submit. Only callable when `identityStatus` is `"unverified"`.

> If the account has 2 or more prior rejections, a `repeated_verification_rejection` flag (medium severity) is automatically raised.

---

#### GET `/api/verification/identity/status`

Check own verification status. Requires authentication cookie.

**Response (200 OK):**
```json
{
  "identityStatus": "pending",
  "requestDetails": {
    "status": "pending",
    "submittedAt": "2026-07-19T11:00:00.000Z",
    "reviewedAt": null,
    "reason": null
  }
}
```

---

### Discovery & Social (`/api`)

#### GET `/api/discover`

Paginated discovery feed. Requires authentication cookie.

**Query params:** `?page=1&limit=10` (limit capped at 50)

**Response (200 OK):**
```json
{
  "profiles": [
    {
      "_id": "651a2b3c4d5e6f7a8b9c0d2f",
      "name": "Jane Smith",
      "age": 20,
      "school": "Adamas University",
      "course": "CSE",
      "gender": "female",
      "pictures": [{ "url": "https://...", "fileId": "file_123" }],
      "bio": "Loves coding",
      "hobbies": ["Coding", "Chess"],
      "skills": ["JavaScript"],
      "identityStatus": "verified",
      "badges": []
    }
  ],
  "page": 1,
  "limit": 10
}
```

> Automatically excludes: blocked users (both directions), already-liked users, and existing matches.

---

#### POST `/api/like/:targetId`
#### POST `/api/superlike/:targetId`

Like or superlike another user. Requires authentication cookie.

**Response (200 OK):**
```json
{
  "success": true,
  "matchFormed": true,
  "conversationId": "conv_651a...1e_651a...2f"
}
```

**Daily quotas (UTC midnight reset):**

| Account type | Likes/day | Superlikes/day |
|---|---|---|
| College-verified (`emailVerified: true`) | Unlimited | 5 |
| Outsider — female | 5 | 5 |
| Outsider — male | 5 | 1 |

> > 5 like/superlike actions within a 10-second window triggers a `like_velocity_spike` flag (low severity).

---

#### GET `/api/matches`

List all mutual matches. Requires authentication cookie.

**Response (200 OK):**
```json
{
  "matches": [
    {
      "id": "651a2b3c4d5e6f7a8b9c0d3a",
      "matchedAt": "2026-07-19T11:10:00.000Z",
      "conversationId": "conv_651a...1e_651a...2f",
      "partner": {
        "name": "Jane Smith",
        "age": 20,
        "gender": "female",
        "identityStatus": "verified"
      }
    }
  ]
}
```

> Partners that have since blocked you (or whom you have blocked) are automatically filtered out of the response.

---

#### POST `/api/block/:targetId`

Block a user. Requires authentication cookie.

**Response (200 OK):**
```json
{ "message": "User blocked successfully" }
```

> Receiving more than 10 blocks in an hour triggers a `mass_block_target` flag (medium severity) on the blocked user's account.

---

#### DELETE `/api/block/:targetId`

Unblock a user. Requires authentication cookie.

**Response (200 OK):**
```json
{ "message": "User unblocked successfully" }
```

---

#### POST `/api/report`

Report a user or an anonymous post. Requires authentication cookie.

**Body:**
```json
{
  "targetUserId": "651a2b3c4d5e6f7a8b9c0d2f",
  "reason": "Harassment"
}
```

| Field | Rules |
|---|---|
| `targetUserId` | ObjectId — provide either this or `targetPostId` |
| `targetPostId` | ObjectId — provide either this or `targetUserId` |
| `reason` | Required, max 1000 chars |

**Response (201 Created):**
```json
{ "message": "Report submitted successfully" }
```

> Receiving more than 5 reports in an hour triggers a `mass_report_target` flag (high severity).

---

#### POST `/api/posts`

Create an anonymous post. Requires authentication cookie.

**Body:**
```json
{ "content": "Post content here" }
```

| Field | Rules |
|---|---|
| `content` | Required, max 1000 chars |

**Response (201 Created):**
```json
{
  "message": "Post created successfully",
  "post": {
    "_id": "651a2b3c4d5e6f7a8b9c0d4b",
    "content": "Post content here",
    "postedAt": "2026-07-19T12:00:00.000Z"
  }
}
```

> More than 5 posts in an hour triggers a `post_spam` flag (low severity).

---

#### GET `/api/posts`

List anonymous posts. Requires authentication cookie.

**Query params:** `?page=1&limit=20` (limit capped at 50)

**Response (200 OK):**
```json
{
  "posts": [
    {
      "_id": "651a2b3c4d5e6f7a8b9c0d4b",
      "content": "Post content here",
      "postedAt": "2026-07-19T12:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 142
}
```

---

#### POST `/api/feedback`

Submit feedback. Requires authentication cookie.

**Body:**
```json
{ "content": "The app is great but I'd love a dark mode." }
```

| Field | Rules |
|---|---|
| `content` | Required, max 2000 chars |

**Response (201 Created):**
```json
{ "message": "Feedback submitted successfully" }
```

---

#### GET `/api/health`

Service health check. No authentication required.

**Response (200 OK):**
```json
{
  "status": "healthy",
  "timestamp": "2026-07-19T12:00:00.000Z",
  "redis": { "isMock": false, "connected": true },
  "mongo": "connected"
}
```

---

## 4. Real-Time Chat Service (Socket.IO — Port 5001)

### Connection Handshake

Connect to the Socket.IO service at port 5001 (or the production endpoint `https://frnd-chat-a2cm.onrender.com`). The JWT cookie is picked up automatically by the browser for same-site connections; alternatively pass the token in `auth` or `query`.

```javascript
// Option A: cookie is sent automatically by the browser (production endpoint example)
const socket = io("https://frnd-chat-a2cm.onrender.com", { transports: ['websocket'] });

// Option B: explicit auth (cross-origin SPA or native apps)
const socket = io("https://frnd-chat-a2cm.onrender.com", {
  auth: { token: jwtToken },
  transports: ['websocket']
});
```

Connection is rejected with an error event if the token is missing, invalid, or is an admin token.

---

### Client → Server Events

#### `join_conversation`

Join a conversation room before sending or receiving messages.

```json
{ "conversationId": "conv_651a...1e_651a...2f" }
```

Access is verified server-side — the user must be one of the two matched parties.

---

#### `send_message`

Send an AES-GCM encrypted message.

```json
{
  "conversationId": "conv_651a...1e_651a...2f",
  "ciphertext": "a1f2b3e4...",
  "iv": "x9y8z7w6..."
}
```

The server stores and relays only the `ciphertext` and `iv` — plaintext is never visible to the server.

---

#### `heartbeat`

Renew presence (keeps the user marked online for 2 minutes).

---

### Server → Client Events

#### `message_received`

Emitted to the other participant in a conversation.

```json
{
  "conversationId": "conv_...",
  "senderId": "651a2b3c4d5e6f7a8b9c0d1e",
  "ciphertext": "a1f2b3e4...",
  "iv": "x9y8z7w6...",
  "timestamp": "2026-07-19T11:12:00.000Z",
  "delivered": false
}
```

---

#### `message_sent`

Acknowledgment to the sender after the message is accepted.

```json
{
  "conversationId": "conv_...",
  "timestamp": "2026-07-19T11:12:00.000Z"
}
```

---

#### `chat_error`

Emitted when a validation or access error occurs.

```json
{ "error": "Access denied to this conversation" }
```

---

## 5. Admin API (`/api/admin/*`)

> **All admin routes** require:
> - `Authorization: Bearer <admin_token>` header
> - Request must originate from the configured `ADMIN_PANEL_ORIGIN`

### Admin Authentication

#### POST `/api/admin/auth/signup`

One-time admin account creation (per email).

**Body:**
```json
{
  "email": "admin@stu.adamasuniversity.ac.in",
  "password": "strongAdminPassword123!"
}
```

- Password must be **at least 12 characters**.
- `email` must be present in the `ADMIN_EMAILS` environment variable allowlist.
- A given email can only sign up once — subsequent attempts are rejected.

**Response (201 Created):**
```json
{ "message": "Admin account registered successfully" }
```

---

#### POST `/api/admin/auth/login`

Three-factor admin login: email + personal password + shared common password.

**Body:**
```json
{
  "email": "admin@stu.adamasuniversity.ac.in",
  "password": "adminPersonalPassword",
  "commonPass": "sharedTeamCommonPassword"
}
```

**Response (200 OK):**
```json
{
  "message": "Admin login successful",
  "token": "<admin_scoped_jwt_token>",
  "email": "admin@stu.adamasuniversity.ac.in"
}
```

Store this `token` in SPA memory and send it as `Authorization: Bearer <token>` on all subsequent admin API calls.

---

#### POST `/api/admin/auth/logout`

Invalidate the current session (client-side token discard).

**Response (200 OK):**
```json
{ "message": "Admin logged out successfully" }
```

---

### Flags Queue

#### GET `/api/admin/flags`

List account flags, optionally filtered by status.

**Query params:** `?status=open&page=1&limit=50`

- `status`: `open` (default) | `reviewed` | `dismissed` | `actioned`

**Response:**
```json
{
  "flags": [
    {
      "_id": "...",
      "userId": { "name": "Jane", "email": "jane@...", "openFlagCount": 2 },
      "flagType": "login_brute_force",
      "severity": "medium",
      "details": { "attempts": 6 },
      "status": "open",
      "createdAt": "2026-07-19T10:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 50,
  "total": 12
}
```

---

#### GET `/api/admin/flags/user/:userId`

All flags for a specific user account (history view).

**Query params:** `?page=1&limit=50`

---

#### POST `/api/admin/flags/:id/dismiss`

Dismiss a flag as a false positive. Decrements `openFlagCount` on the user.

#### POST `/api/admin/flags/:id/review`

Mark flag as reviewed/acknowledged with no action.

#### POST `/api/admin/flags/:id/action`

Action flag — bans the user and sets `banned: true` with an automatic reason.

**Response (all three):**
```json
{ "message": "Flag resolved with status: dismissed", "flag": { ... } }
```

---

### User Management

#### GET `/api/admin/users`

List all users sorted by highest open flag count first.

**Query params:** `?page=1&limit=50`

**Response:**
```json
{
  "users": [
    {
      "_id": "...",
      "name": "John",
      "email": "john@...",
      "username": "johndoe",
      "gender": "male",
      "age": 20,
      "openFlagCount": 3,
      "banned": false,
      "identityStatus": "verified",
      "isPremium": false
    }
  ],
  "page": 1,
  "limit": 50,
  "total": 1000
}
```

---

#### GET `/api/admin/users/:id`

Full profile of a specific user (without `passwordHash`).

---

#### POST `/api/admin/users/:id/ban`

Ban a user with a required reason.

**Body:**
```json
{ "reason": "Harassment and inappropriate content" }
```

**Response:**
```json
{ "message": "User banned successfully", "user": { ... } }
```

---

#### POST `/api/admin/users/:id/unban`

Unban a user.

**Response:**
```json
{ "message": "User unbanned successfully", "user": { ... } }
```

---

#### POST `/api/admin/users/:id/premium`

Grant or revoke premium status.

**Body:**
```json
{ "isPremium": true }
```

---

#### POST `/api/admin/users/:id/badge`

Set profile badges (replaces all existing badges).

**Body:**
```json
{ "badges": ["Verified", "Early Adopter"] }
```

---

### Reports

#### GET `/api/admin/reports`

List all reports.

**Query params:** `?page=1&limit=50`

**Response:**
```json
{
  "reports": [
    {
      "_id": "...",
      "reporterId": { "username": "johndoe", "email": "john@..." },
      "targetUserId": { "username": "janedoe", "openFlagCount": 2 },
      "reason": "Harassment",
      "status": "open",
      "createdAt": "2026-07-19T11:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 50,
  "total": 34
}
```

---

### Identity Verification Queue

#### GET `/api/admin/verification-requests`

Pending identity verification queue. Includes short-lived (10-min) signed Cloudinary preview URLs.

**Query params:** `?page=1&limit=50`

**Response:**
```json
{
  "requests": [
    {
      "_id": "...",
      "userId": { "name": "John", "email": "john@...", "username": "johndoe" },
      "idCardUrl": "https://res.cloudinary.com/...?signature=...",
      "faceUrl": "https://res.cloudinary.com/...?signature=...",
      "submittedAt": "2026-07-19T11:00:00.000Z",
      "isDuplicate": false
    }
  ],
  "page": 1,
  "limit": 50,
  "total": 5
}
```

`isDuplicate: true` means an open `duplicate_identity_document` flag exists for this user.

---

#### POST `/api/admin/verification-requests/:id/approve`

Approve a pending verification request. Sets the user's `identityStatus` to `"verified"`.

**Response:**
```json
{ "message": "Verification request approved successfully" }
```

---

#### POST `/api/admin/verification-requests/:id/reject`

Reject with a reason. Sets the user's `identityStatus` to `"unverified"`.

**Body:**
```json
{ "reason": "ID card image is too blurry to verify" }
```

**Response:**
```json
{ "message": "Verification request rejected successfully" }
```

---

### Content & Communication

#### GET `/api/admin/feedback`

List all user feedback submissions.

**Query params:** `?page=1&limit=50`

---

#### POST `/api/admin/announce`

Publish a system announcement.

**Body:**
```json
{
  "title": "New Feature Launch",
  "content": "We've launched anonymous posts! Check it out."
}
```

| Field | Rules |
|---|---|
| `title` | Required, max 200 chars |
| `content` | Required, max 5000 chars |

**Response (201 Created):**
```json
{ "message": "Announcement posted successfully", "announcement": { ... } }
```

---

## 6. Unusual Activity Flags Reference

| Flag type | Trigger | Severity | Where raised |
|---|---|---|---|
| `login_brute_force` | ≥ 5 failed logins for one account in 15 min | medium | `/api/auth/login` |
| `signup_cluster` | > 5 signups from same IP in 1 hour | medium | `/api/auth/signup` |
| `like_velocity_spike` | > 5 like/superlike actions in 10 seconds | low | `/api/like`, `/api/superlike` |
| `mass_report_target` | > 5 reports against one user in 1 hour | high | `/api/report` |
| `mass_block_target` | > 10 blocks against one user in 1 hour | medium | `/api/block/:targetId` |
| `message_spam_pattern` | > 5 distinct new conversations messaged in 1 hour | medium | Chat service |
| `duplicate_identity_document` | Perceptual hash matches another user's submission | high | `/api/verification/identity/submit` |
| `repeated_verification_rejection` | ≥ 2 prior `unverified` outcomes on resubmit | medium | `/api/verification/identity/resubmit` |
| `post_spam` | > 5 posts in 1 hour | low | `/api/posts` |

---

## 7. Common Error Responses

| HTTP Status | When |
|---|---|
| 400 | Validation failure, missing required field, or invalid input |
| 401 | Missing, invalid, or expired authentication token |
| 403 | CORS origin not allowed; admin token used on user route; banned account |
| 404 | Resource not found |
| 429 | Quota exceeded (daily likes/superlikes, OTP resend rate limit) |
| 500 | Unexpected server error |

All error responses follow the format:
```json
{ "error": "Human-readable error message" }
```
