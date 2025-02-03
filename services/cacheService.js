// services/cacheService.js
const redis = require('redis');
const { REDIS } = require('../config/config');

const client = redis.createClient({
  socket: {
    host: REDIS.host,
    port: REDIS.port,
  }
});

client.connect().catch(console.error);

/**
 * Check if a transcoding session for a video variant is active.
 * If not, mark it as active with an expiration.
 *
 * @param {string} videoId
 * @param {string} variantLabel
 * @returns {Promise<boolean>} true if session exists, false otherwise.
 */
async function checkOrStartSession(videoId, variantLabel) {
  const key = `transcode:${videoId}:${variantLabel}`;
  const exists = await client.get(key);

  if (!exists) {
    // Mark session active for 30 minutes (1800 seconds)
    await client.set(key, 'active', { EX: 1800 });
    return false; // Session did not exist; caller should start transcoding.
  }

  return true; // Session exists, use the existing transcoding process/segments.
}

module.exports = { checkOrStartSession };
