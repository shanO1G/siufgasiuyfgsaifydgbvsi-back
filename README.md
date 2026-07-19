# College Dating App Backend

This repository is structured as a monorepo containing the REST API service, the Socket.IO Chat service, and the Admin Panel frontend.

---

## 1. Project Directory Structure
```
/
├── API_DOCUMENTATION.md      # API details & Socket.IO events guide
├── README.md                 # Deployment & setup instructions
├── .env                      # Shared local development environment config
├── api/                      # Self-Contained REST API Service (Port 5000)
│   ├── package.json          # API service dependencies & start scripts
│   ├── server.js             # API server entrypoint
│   ├── public/               # Local static uploads fallback folder
│   ├── models/               # Self-contained Mongoose models
│   ├── utils/                # DB, Redis, and Uploader utilities
│   ├── middleware/           # Auth middlewares
│   └── routes/               # REST API endpoints (auth, verification, social, admin)
├── chat/                     # Self-Contained Socket.IO Chat Service (Port 5001)
│   ├── package.json          # Chat service dependencies & start scripts
│   ├── server.js             # Socket.IO chat entrypoint
│   ├── models/               # Self-contained Mongoose models
│   └── utils/                # DB and Redis utilities
└── admin/                    # Self-Contained Admin Panel Frontend
    ├── index.html            # Dashboard markup
    ├── style.css             # Responsive Claude-style interface design
    └── app.js                # Client dashboard logic
```

---

## 2. Render Deployment Strategy

Each component is deployed to Render as an independent service from this single repository using Render's **Root Directory** or **Publish Directory** options.

### Web Service 1: API Backend
- **Service Type**: Web Service
- **Root Directory**: `api`
- **Environment**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Port**: `5000` (or set via `PORT` environment variable)

### Web Service 2: Chat Backend
- **Service Type**: Web Service
- **Root Directory**: `chat`
- **Environment**: `Node`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Port**: `5001` (or set via `PORT` environment variable)

### Web Service 3: Admin Frontend
- **Service Type**: Static Site
- **Build Command**: *(Leave completely empty)*
- **Publish Directory**: `admin`
- **Environment Variables**: Configure the browser backend connection in the client script if needed.


---

## 3. Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure `.env` variables at the root.
3. Run test suites:
   - Validate Database schemas: `npm run test:db`
   - Validate Auth routes: `npm run test:auth`
   - Validate Verification flow: `npm run test:verification`
   - Validate Social flow: `npm run test:social`
   - Validate Chat Socket flow: `npm run test:chat`
   - Validate Admin portal flow: `npm run test:admin`
