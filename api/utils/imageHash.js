const crypto = require('crypto');

/**
 * Computes a 64-bit Average Hash (aHash) for perceptual duplicate detection.
 * Uses the 'sharp' library which is a required production dependency.
 *
 * For local/dev environments without sharp installed, throws a clear error
 * rather than silently falling back to MD5 (which defeats perceptual dedup).
 */
async function computeImageHash(buffer) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    throw new Error(
      'sharp is required for perceptual image hashing. Install it with: npm install sharp\n' +
      'Original error: ' + e.message
    );
  }

  const { data } = await sharp(buffer)
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (let i = 0; i < 64; i++) {
    sum += data[i];
  }
  const avg = sum / 64;

  let hashBits = '';
  for (let i = 0; i < 64; i++) {
    hashBits += data[i] >= avg ? '1' : '0';
  }

  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(hashBits.substring(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Calculates Hamming-distance-based similarity between two perceptual hashes.
 * Returns percentage similarity (0 to 100).
 * Two images are considered duplicates at >= 90% similarity.
 */
function calculateSimilarity(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return 0;
  let matches = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] === hash2[i]) matches++;
  }
  return (matches / hash1.length) * 100;
}

module.exports = {
  computeImageHash,
  calculateSimilarity
};
