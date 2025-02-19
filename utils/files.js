const fs = require('fs');
const fsPromises = fs.promises;
/**
 * Ensures that a directory exists; if not, creates it.
 */
async function ensureDir(dir) {
  try {
    await fsPromises.access(dir);
  } catch (err) {
    await fsPromises.mkdir(dir, { recursive: true });
  }
}

/**
 * Waits for a file to become stable (i.e. its size stops changing).
 * @param {string} filePath - Path to the file.
 * @param {number} interval - How long to wait between checks (in ms).
 * @param {number} maxTries - Maximum number of checks before giving up.
 * @returns {Promise<void>}
 */
async function waitForFileStability(filePath, interval = 200, maxTries = 5) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    let lastSize = -1;

    const check = () => {
      // If the file does not exist yet, wait a bit.
      if (!fs.existsSync(filePath)) {
        tries++;
        if (tries >= maxTries) {
          return reject(new Error(`File ${filePath} did not appear in time`));
        }
        return setTimeout(check, interval);
      }
      
      // The file exists; get its stats.
      const stats = fs.statSync(filePath);
      
      // If we have a previous size and the size is unchanged (and nonzero), consider it stable.
      if (lastSize !== -1 && stats.size === lastSize && stats.size > 0) {
        return resolve();
      }
      
      // Otherwise, update our recorded size and try again.
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

function safeFilename(filename) {
  // Remove any invalid characters
  const safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '-');

  // Remove leading and trailing periods
  const noLeadingPeriods = safeFilename.replace(/^\.+/, '');
  const noTrailingPeriods = noLeadingPeriods.replace(/\.+$/, '');

  // Remove leading and trailing whitespace
  const trimmedFilename = noTrailingPeriods.trim();

  return trimmedFilename;
}

module.exports = { ensureDir, waitForFileStability, safeFilename };