// services/sessionManager.js
const fs = require('fs');
const path = require('path');
const { HLS_OUTPUT_DIR } = require('../config/config');
const { ensureDir } = require('../utils/files');

/**
 * Returns the path to the session lock file for a given video and variant.
 */
function getSessionLockPath(videoId, variantLabel) {
  return path.join(HLS_OUTPUT_DIR, videoId, variantLabel, 'session.lock');
}

/**
 * Checks if a session is active by verifying the existence of the lock file.
 */
function isSessionActive(videoId, variantLabel) {
  const lockPath = getSessionLockPath(videoId, variantLabel);
  ensureDir(path.dirname(lockPath));
  return fs.existsSync(lockPath);
}

/**
 * Creates a session lock file to indicate that a transcoding session is active.
 */
function createSessionLock(videoId, variantLabel) {
  const lockPath = getSessionLockPath(videoId, variantLabel);
  fs.writeFileSync(lockPath, new Date().toISOString());
}

/**
 * Updates the access and modification time of the lock file.
 */
function updateSessionLock(videoId, variantLabel) {
  const lockPath = getSessionLockPath(videoId, variantLabel);
  if (fs.existsSync(lockPath)) {
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
  }
}

/**
 * Optionally, remove the session lock file when a session is ended.
 */
function removeSessionLock(videoId, variantLabel) {
  const lockPath = getSessionLockPath(videoId, variantLabel);
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
}

module.exports = {
  isSessionActive,
  createSessionLock,
  updateSessionLock,
  removeSessionLock,
};
