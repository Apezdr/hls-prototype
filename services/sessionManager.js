// services/sessionManager.js
const fs = require('fs');
const path = require('path');
const { HLS_OUTPUT_DIR } = require('../config/config');
const { ensureDir, safeFilename } = require('../utils/files');
const fsPromises = fs.promises;

/**
 * Returns the path to the session lock file for a given video and variant.
 */
function getSessionLockPath(videoId, variantLabel) {
  return path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variantLabel, 'session.lock');
}

/**
 * Checks if a session is active by verifying the existence of the lock file.
 */
async function isSessionActive(videoId, variantLabel) {
  const lockPath = getSessionLockPath(videoId, variantLabel);
  await ensureDir(path.dirname(lockPath));
  try {
    await fsPromises.access(lockPath);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Creates a session lock file to indicate that a transcoding session is active.
 */
async function createSessionLock(videoId, variantLabel) {
  const lockPath = getSessionLockPath(videoId, variantLabel);
  await ensureDir(path.dirname(lockPath));
  await fsPromises.writeFile(lockPath, new Date().toISOString());
}

/**
 * Updates the access and modification time of the lock file.
 */
async function updateSessionLock(videoId, variantLabel) {
  const lockPath = getSessionLockPath(videoId, variantLabel);
  try {
    // Check if file exists by trying to get its stats.
    await fsPromises.stat(lockPath);
    const now = new Date();
    await fsPromises.utimes(lockPath, now, now);
  } catch (err) {
    // File does not exist; nothing to update.
  }
}

/**
 * Optionally, remove the session lock file when a session is ended.
 */
async function removeSessionLock(videoId, variantLabel) {
  const lockPath = getSessionLockPath(videoId, variantLabel);
  try {
    await fsPromises.unlink(lockPath);
  } catch (err) {
    // Ignore error if file does not exist.
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

module.exports = {
  isSessionActive,
  createSessionLock,
  updateSessionLock,
  removeSessionLock,
};
