// utils/manifest.js
const fs = require('fs');
const path = require('path');
const { waitForFileStability } = require('./files');
const { getMediaInfo } = require('./ffprobe');

/**
 * Ensure that an info file exists for a given variant.
 * If not, wait for the first segment (e.g. "000.ts") to be stable,
 * run ffprobe on it, and write an info.json file in the variant output directory.
 *
 * @param {string} videoId - The video identifier.
 * @param {object} variant - The variant configuration object.
 * @param {string} variantOutputDir - The absolute path to the variant's output folder.
 * @returns {Promise<object>} - Resolves with the parsed info object.
 */
async function ensureVariantInfo(videoId, variant, variantOutputDir) {
  const infoFile = path.join(variantOutputDir, 'info.json');
  if (fs.existsSync(infoFile)) {
    try {
      const data = fs.readFileSync(infoFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
        console.error('Error reading info file, regenerating:', err);
    }
  }
  
  // Assume the first segment is named '000.ts'
  const segmentFile = path.join(variantOutputDir, '000.ts');
  try {
    // Wait for the segment to be fully written.
    await waitForFileStability(segmentFile, 200, 10);
  } catch (err) {
    throw new Error(`Segment file ${segmentFile} did not stabilize: ${err.message}`);
  }
  
  // Get FFprobe info for the segment.
  let segmentInfo;
  try {
    segmentInfo = await getMediaInfo(segmentFile);
  } catch (err) {
    throw new Error(`Error running FFprobe on ${segmentFile}: ${err.message}`);
  }
  
  // Find the video stream.
  const videoStream = (segmentInfo.streams || []).find(s => s.codec_type === 'video');
  if (!videoStream) {
    throw new Error(`No video stream found in ${segmentFile}`);
  }
  
  // Attempt to get the bit_rate from FFprobe. If it’s missing or zero, compute it.
  let measuredBitrate = videoStream.bit_rate ? parseInt(videoStream.bit_rate, 10) : 0;
  if (!measuredBitrate || isNaN(measuredBitrate) || measuredBitrate === 0) {
    // Use the file size and the duration from FFprobe.
    const stats = fs.statSync(segmentFile);
    const fileSizeBytes = stats.size;
    // Duration may be provided as a string; convert it to a float.
    const duration = parseFloat(videoStream.duration);
    if (!duration || duration <= 0) {
      throw new Error(`Invalid duration (${videoStream.duration}) for ${segmentFile}`);
    }
    // Compute average bitrate in bits per second.
    measuredBitrate = Math.round((fileSizeBytes * 8) / duration);
  }
  
  // Create the info object.
  const info = {
    measuredBitrate, // in bits per second
    width: videoStream.width,
    height: videoStream.height
  };
  
  // Write the info object to file.
  try {
    fs.writeFileSync(infoFile, JSON.stringify(info, null, 2));
    console.log(`Wrote variant info to ${infoFile}`);
  } catch (err) {
    console.error(`Error writing info file to ${infoFile}:`, err);
  }
  
  return info;
}

module.exports = { ensureVariantInfo };
