const admin = require('firebase-admin');

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const serviceAccountJson = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(serviceAccountJson);
    
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('[FIREBASE] Admin SDK initialized successfully in API.');
    }
  } else {
    console.warn('[FIREBASE] FIREBASE_SERVICE_ACCOUNT_BASE64 is not set in .env');
  }
} catch (error) {
  console.error('[FIREBASE] Failed to initialize Admin SDK:', error);
}

module.exports = admin;
