const fs = require('fs');
const path = require('path');
const { safeFilename } = require('./files');

function findVideoFile(videoId, videoSourceDir) {
  const videoFiles = fs.readdirSync(videoSourceDir);
  // First, try to find an exact match using the original videoId
  let videoFile = videoFiles.find(
    file => path.basename(file, path.extname(file)) === videoId
  );

  if (!videoFile) {
    // No direct match found; sanitize the videoId for a looser match.
    const sanitizedVideoId = safeFilename(videoId);

    // Try to find a file that loosely matches the sanitized videoId.
    // For example, check if the base filename starts with or includes the sanitized id.
    videoFile = videoFiles.find(file => {
      const baseName = path.basename(file, path.extname(file));
      return baseName.startsWith(sanitizedVideoId) || baseName.includes(sanitizedVideoId);
    });

    // If still no match, return null.
    if (!videoFile) {
      return null;
    }
  }

  return path.join(videoSourceDir, videoFile);
}

module.exports = findVideoFile;