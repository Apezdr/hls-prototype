// utils/timestampUtils.js
const path = require('path');
const fs = require('fs').promises;
const { HLS_SEGMENT_TIME, HLS_OUTPUT_DIR } = require('../config/config');
const { getVideoFps, getMediaInfo } = require('./ffprobe');
const { getOptimalSegmentDuration } = require('./gopUtils');
const { safeFilename, ensureDir } = require('./files');

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
 * @param {string} format - Segment format ('ts' or 'm4s')
 * @returns {string} - Segment filename (e.g., "000.ts" or "000.m4s")
 */
function segmentNumberToFilename(segmentNumber, format = 'ts') {
  return `${segmentNumber.toString().padStart(3, '0')}.${format}`;
}

/**
 * Extract segment number from segment filename
 * @param {string} filename - Segment filename (e.g., "000.ts" or "000.m4s")
 * @returns {number} - The segment number
 */
function filenameToSegmentNumber(filename) {
  const match = filename.match(/^(\d+)\.(ts|m4s)$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return NaN;
}

/**
 * Get segment file extension based on codec
 * @param {string} codec - Codec name (e.g., 'hevc', 'h264')
 * @returns {string} - File extension ('m4s' for HEVC, 'ts' for others)
 */
function getSegmentExtensionForCodec(codec) {
  return codec === 'hevc' ? 'm4s' : 'ts';
}

/**
 * Precompute and store segment boundaries for a video
 * @param {string} videoId - Video identifier
 * @param {string} videoPath - Path to video file
 * @returns {Promise<Array>} - Array of segment boundary objects
 */
async function precomputeSegmentBoundaries(videoId, videoPath) {
  console.log(`Precomputing segment boundaries for ${videoId}`);
  
  // Get media info
  const mediaInfo = await getMediaInfo(videoPath);
  const segmentDuration = await getOptimalSegmentDuration(videoPath, HLS_SEGMENT_TIME);
  const videoStream = mediaInfo.streams.find(s => s.codec_type === 'video');
  const totalDuration = parseFloat(videoStream.duration || 0);
  
  if (!totalDuration) {
    throw new Error('Unable to determine media duration');
  }
  
  const segmentCount = Math.ceil(totalDuration / segmentDuration);
  console.log(`Media duration: ${totalDuration}s, segment duration: ${segmentDuration}s, segment count: ${segmentCount}`);
  
  const segments = [];
  
  for (let i = 0; i < segmentCount; i++) {
    const startTime = i * segmentDuration;
    const actualDuration = Math.min(segmentDuration, totalDuration - startTime);
    
    segments.push({
      index: i,
      runtimeTicks: Math.floor(startTime * 10000000), // Convert to ticks (100ns units)
      actualSegmentLengthTicks: Math.floor(actualDuration * 10000000),
      startTimeSeconds: startTime,
      durationSeconds: actualDuration
    });
  }
  
  // Store this information for future use
  const segmentBoundariesDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId));
  await ensureDir(segmentBoundariesDir);
  const boundariesPath = path.join(segmentBoundariesDir, 'segment_boundaries.json');
  await fs.writeFile(boundariesPath, JSON.stringify(segments, null, 2));
  
  return segments;
}

/**
 * Get precomputed segment boundaries for a video
 * @param {string} videoId - Video identifier
 * @param {string} videoPath - Path to video file (needed if boundaries don't exist yet)
 * @returns {Promise<Array>} - Array of segment boundary objects
 */
async function getSegmentBoundaries(videoId, videoPath) {
  const boundariesPath = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), 'segment_boundaries.json');
  
  try {
    const data = await fs.readFile(boundariesPath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    // If boundaries don't exist, compute them now
    return await precomputeSegmentBoundaries(videoId, videoPath);
  }
}

module.exports = {
  calculateSegmentNumber,
  calculateSegmentTimestamp,
  findNearestKeyframeTimestamp,
  segmentNumberToFilename,
  filenameToSegmentNumber,
  getAlignedSegmentDuration,
  timestampToSeconds,
  getSegmentExtensionForCodec,
  precomputeSegmentBoundaries,
  getSegmentBoundaries
};
