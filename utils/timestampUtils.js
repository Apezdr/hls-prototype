// utils/timestampUtils.js
const { HLS_SEGMENT_TIME } = require('../config/config');
const { getVideoFps } = require('./ffprobe');
const { getOptimalSegmentDuration } = require('./gopUtils');

// Cache for aligned segment durations to avoid recalculating
// key: videoId, value: {duration: number, timestamp: number}
const alignedDurationCache = new Map();

/**
 * Get the aligned segment duration for a video
 * @param {string} videoPath - Path to the video file (optional)
 * @param {string} videoId - Video identifier (optional, for cache lookup)
 * @returns {Promise<number>} - The aligned segment duration
 */
async function getAlignedSegmentDuration(videoPath, videoId) {
  // Use cached value if available
  if (videoId && alignedDurationCache.has(videoId)) {
    return alignedDurationCache.get(videoId).duration;
  }

  // Calculate aligned duration if video path provided
  if (videoPath) {
    try {
      const alignedDuration = await getOptimalSegmentDuration(videoPath, HLS_SEGMENT_TIME);
      
      // Cache the result if we have a videoId
      if (videoId) {
        alignedDurationCache.set(videoId, {
          duration: alignedDuration,
          timestamp: Date.now()
        });
      }
      
      return alignedDuration;
    } catch (error) {
      console.error('Error calculating aligned segment duration:', error);
    }
  }
  
  // Fall back to config value if calculation fails or no path provided
  return HLS_SEGMENT_TIME;
}

/**
 * Calculate segment number from a timestamp using aligned duration if available
 * @param {number} timestamp - Time in seconds
 * @param {number} alignedDuration - Aligned segment duration (optional)
 * @returns {number} - The segment number corresponding to this timestamp
 */
function calculateSegmentNumber(timestamp, alignedDuration = HLS_SEGMENT_TIME) {
  return Math.floor(timestamp / alignedDuration);
}

/**
 * Calculate the timestamp for the start of a segment using aligned duration if available
 * @param {number} segmentNumber - The segment number
 * @param {number} alignedDuration - Aligned segment duration (optional)
 * @returns {number} - The timestamp in seconds for the start of this segment
 */
function calculateSegmentTimestamp(segmentNumber, alignedDuration = HLS_SEGMENT_TIME) {
  return segmentNumber * alignedDuration;
}

/**
 * Convert a timestamp to seconds from HH:MM:SS.ms format
 * @param {string} timestamp - Timestamp in HH:MM:SS.ms format
 * @returns {number} - Time in seconds
 */
function timestampToSeconds(timestamp) {
  if (!timestamp) return 0;
  
  // Handle various timestamp formats
  if (typeof timestamp === 'number') return timestamp;
  
  // Parse HH:MM:SS.ms format
  const parts = timestamp.split(':');
  if (parts.length === 3) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  
  // Try parsing as a simple float
  return parseFloat(timestamp) || 0;
}

/**
 * Find the nearest keyframe timestamp before the requested timestamp
 * This is important for clean segment boundaries
 * @param {Object} mediaInfo - FFprobe output for the video file
 * @param {number} timestamp - Target timestamp in seconds
 * @returns {number} - Adjusted timestamp that aligns with a keyframe
 */
function findNearestKeyframeTimestamp(mediaInfo, timestamp) {
  // If the video has keyframe information, use it for precise seeking
  const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
  
  if (videoStream && videoStream.has_keyframes) {
    // Extract keyframe timestamps if available
    const keyframes = videoStream.keyframes || [];
    // Find the closest keyframe before the requested timestamp
    const nearestKeyframe = keyframes
      .filter(kf => kf.timestamp <= timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    
    if (nearestKeyframe) {
      return nearestKeyframe.timestamp;
    }
  }
  
  // If we don't have keyframe data, calculate based on GOP size
  const fps = getVideoFps(mediaInfo);
  const estimatedGopFrames = HLS_SEGMENT_TIME * fps;
  const targetFrame = Math.floor(timestamp * fps);
  const nearestGopStart = Math.floor(targetFrame / estimatedGopFrames) * estimatedGopFrames;
  return nearestGopStart / fps;
}

/**
 * Calculate segment filename from segment number
 * @param {number} segmentNumber - The segment number
 * @returns {string} - Segment filename (e.g., "000.ts")
 */
function segmentNumberToFilename(segmentNumber) {
  return `${segmentNumber.toString().padStart(3, '0')}.ts`;
}

/**
 * Extract segment number from segment filename
 * @param {string} filename - Segment filename (e.g., "000.ts")
 * @returns {number} - The segment number
 */
function filenameToSegmentNumber(filename) {
  const match = filename.match(/^(\d+)\.ts$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return NaN;
}

module.exports = {
  calculateSegmentNumber,
  calculateSegmentTimestamp,
  findNearestKeyframeTimestamp,
  segmentNumberToFilename,
  filenameToSegmentNumber,
  getAlignedSegmentDuration,
  timestampToSeconds
};
