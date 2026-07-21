const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');

// Configure Cloudinary if credentials exist
const isCloudinaryConfigured = 
  process.env.CLOUDINARY_CLOUD_NAME && 
  !process.env.CLOUDINARY_CLOUD_NAME.startsWith('your_') &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} else {
  console.warn('Cloudinary not configured. Falling back to local disk storage for uploaded files.');
}

/**
 * Uploads a file buffer/file to Cloudinary or falls back to local storage.
 * @param {Object} file - The file object from multer (buffer and originalname)
 * @returns {Promise<{url: String, publicId: String}>}
 */
async function uploadVerificationImage(file) {
  if (isCloudinaryConfigured) {
    return new Promise((resolve, reject) => {
      // Upload using stream to avoid writing file to disk
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'identity_verifications',
          type: 'authenticated', // private delivery
          access_control: [{ access_type: 'token' }] // restrict access
        },
        (error, result) => {
          if (error) return reject(error);
          resolve({
            url: result.secure_url,
            publicId: result.public_id
          });
        }
      );
      uploadStream.end(file.buffer);
    });
  } else {
    // Local fallback
    const uploadsDir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    const filePath = path.join(uploadsDir, filename);
    
    fs.writeFileSync(filePath, file.buffer);
    
    return {
      url: `/uploads/${filename}`,
      publicId: filename
    };
  }
}

/**
 * Generates a signed preview URL for an image.
 * Gated and short-lived for admin review.
 */
function getSignedPreviewUrl(publicId) {
  if (isCloudinaryConfigured) {
    // Generate authenticated URL valid for 10 minutes (600 seconds)
    return cloudinary.url(publicId, {
      type: 'authenticated',
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + 600
    });
  } else {
    // Local fallback: return local relative URL
    return `/uploads/${publicId}`;
  }
}

/**
 * Uploads a public profile picture to Cloudinary or falls back to local storage.
 * @param {Object} file - The file object from multer (buffer and originalname)
 * @returns {Promise<{url: String, fileId: String}>}
 */
async function uploadProfilePicture(file) {
  if (isCloudinaryConfigured) {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'user_pictures',
          resource_type: 'image'
        },
        (error, result) => {
          if (error) return reject(error);
          resolve({
            url: result.secure_url,
            fileId: result.public_id
          });
        }
      );
      uploadStream.end(file.buffer);
    });
  } else {
    // Local fallback
    const uploadsDir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const filename = `pic_${Date.now()}_${Math.round(Math.random() * 1e9)}${path.extname(file.originalname || '.jpg')}`;
    const filePath = path.join(uploadsDir, filename);
    
    fs.writeFileSync(filePath, file.buffer);
    
    return {
      url: `/uploads/${filename}`,
      fileId: filename
    };
  }
}

module.exports = {
  uploadVerificationImage,
  uploadProfilePicture,
  getSignedPreviewUrl
};
