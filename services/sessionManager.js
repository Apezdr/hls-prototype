const fs = require('fs');
const path = require('path');
const { HLS_OUTPUT_DIR } = require('../config/config');
const { ensureDir, safeFilename } = require('../utils/files');
const fsPromises = fs.promises;

class SessionManager {
  constructor(outputDir) {
    this.outputDir = outputDir;
  }

  /**
   * Internal: computes the lock file path for a video variant
   */
  getLockPath(videoId, variantLabel) {
    return path.join(this.outputDir, safeFilename(videoId), variantLabel, 'session.lock');
  }

  /**
   * Check if a session lock exists
   */
  async isSessionActive(videoId, variantLabel) {
    const lockPath = this.getLockPath(videoId, variantLabel);
    await ensureDir(path.dirname(lockPath));
    try {
      await fsPromises.access(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create or refresh a session lock
   */
  async createSessionLock(videoId, variantLabel) {
    const lockPath = this.getLockPath(videoId, variantLabel);
    await ensureDir(path.dirname(lockPath));
    await fsPromises.writeFile(lockPath, new Date().toISOString());
  }

  /**
   * Update the timestamps on the existing lock (keep it alive)
   */
  async updateSessionLock(videoId, variantLabel) {
    const lockPath = this.getLockPath(videoId, variantLabel);
    try {
      const now = new Date();
      await fsPromises.utimes(lockPath, now, now);
    } catch {
      // no-op if lock does not exist
    }
  }

  /**
   * Remove the session lock when session ends
   */
  async removeSessionLock(videoId, variantLabel) {
    const lockPath = this.getLockPath(videoId, variantLabel);
    try {
      await fsPromises.unlink(lockPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

// Export a singleton instance
const sessionManager = new SessionManager(HLS_OUTPUT_DIR);

module.exports = {
  isSessionActive: sessionManager.isSessionActive.bind(sessionManager),
  createSessionLock: sessionManager.createSessionLock.bind(sessionManager),
  updateSessionLock: sessionManager.updateSessionLock.bind(sessionManager),
  removeSessionLock: sessionManager.removeSessionLock.bind(sessionManager),
};
