const fs = require('fs');

/**
 * Ensures that a directory exists; if not, creates it.
 */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Waits for a file to become stable (i.e. its size stops changing).
 * @param {string} filePath - Path to the file.
 * @param {number} interval - How long to wait between checks (in ms).
 * @param {number} maxTries - Maximum number of checks before giving up.
 * @returns {Promise<void>}
 */
function waitForFileStability(filePath, interval = 200, maxTries = 5) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    let lastSize = -1;

    const check = () => {
      if (!fs.existsSync(filePath)) {
        return reject(new Error('File does not exist'));
      }
      const stats = fs.statSync(filePath);
      // If file size is nonzero and hasn’t changed from last check, consider it stable.
      if (stats.size > 0 && stats.size === lastSize) {
        return resolve();
      }
      lastSize = stats.size;
      tries++;
      if (tries >= maxTries) {
        return reject(new Error('File did not become stable in time'));
      }
      setTimeout(check, interval);
    };

    check();
  });
}

module.exports = { ensureDir, waitForFileStability };