// utils/ffprobe.js
const { spawn } = require('child_process');
const { FFPROBE_PATH } = require('../config/config');

/**
 * Retrieves media metadata by executing the ffprobe command-line tool.
 *
 * This function spawns a process to run ffprobe with specified options and captures its output,
 * which is then parsed as JSON. It returns a promise that either resolves with the media metadata 
 * or rejects with an error if the parsing fails or another issue occurs during execution.
 *
 * @param {string} filePath - The path to the media file.
 * @returns {Promise<Object>} A promise that resolves to the media metadata object in JSON format.
 */
function getMediaInfo(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(FFPROBE_PATH, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      filePath
    ]);

    let output = '';
    ffprobe.stdout.on('data', (data) => { output += data; });
    ffprobe.stderr.on('data', (data) => console.error(`ffprobe error: ${data}`));

    ffprobe.on('close', () => {
      try {
        const metadata = JSON.parse(output);
        resolve(metadata);
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = { getMediaInfo };
