const fs = require('fs');
const path = require('path');

function findVideoFile(videoId, videoSourceDir) {
  const videoFiles = fs.readdirSync(videoSourceDir);
  const videoFile = videoFiles.find(file => path.basename(file, path.extname(file)) === videoId);

  if (!videoFile) {
    return null;
  }

  return path.join(videoSourceDir, videoFile);
}

module.exports = findVideoFile;