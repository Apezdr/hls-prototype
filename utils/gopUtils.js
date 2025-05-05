// utils/gopUtils.js
const { getMediaInfo, getVideoFps } = require('./ffprobe');
const config = require('../config/config');

/**
 * Finds the best rational approximation using continued fractions
 * @param {number} value - The decimal value to approximate
 * @param {number} maxDenominator - Maximum denominator to consider
 * @returns {Array<Object>} - Array of rational approximations ordered by accuracy
 */
function findRationalApproximations(value, maxDenominator = 10000) {
  // Convert to continued fraction
  const continuedFraction = [];
  let a = Math.floor(value);
  continuedFraction.push(a);
  
  let x = value - a;
  while (x > 0.0000001 && continuedFraction.length < 20) {
    x = 1 / x;
    a = Math.floor(x);
    continuedFraction.push(a);
    x = x - a;
  }
  
  // Generate convergents
  let n1 = 1, n2 = 0;
  let d1 = 0, d2 = 1;
  
  const convergents = [];
  for (let i = 0; i < continuedFraction.length; i++) {
    const a = continuedFraction[i];
    const n = a * n1 + n2;
    const d = a * d1 + d2;
    
    if (d > maxDenominator) break;
    
    // Calculate the actual value this fraction represents
    const approxValue = n / d;
    const error = Math.abs(value - approxValue);
    
    convergents.push({
      numerator: n,
      denominator: d,
      value: approxValue,
      error: error
    });
    
    n2 = n1; n1 = n;
    d2 = d1; d1 = d;
  }
  
  // Sort by error (most accurate first)
  return convergents.sort((a, b) => a.error - b.error);
}

/**
 * Calculates a GOP size that ensures alignment between video frames and AAC audio frames
 * using continued fraction approximation for better handling of non-integer frame rates
 * 
 * @param {number} fps - Video frames per second 
 * @param {number} audioSampleRate - Audio sample rate in Hz (default: 48000)
 * @param {number} aacFrameSize - AAC frame size in samples (default: 1024)
 * @param {number} targetDuration - Approximate target segment duration in seconds
 * @return {Object} - Contains GOP size, actual segment duration, and AAC frames per segment
 */
function calculateAlignedGopSize(fps, audioSampleRate = 48000, aacFrameSize = 1024, targetDuration = 5) {
  // Audio frame duration in seconds
  const aacFrameDuration = aacFrameSize / audioSampleRate;
  
  // Calculate the ratio between audio and video frame durations
  const videoFrameDuration = 1 / fps;
  const durationRatio = aacFrameDuration / videoFrameDuration;
  
  // Find best rational approximations to this ratio
  const approximations = findRationalApproximations(durationRatio, 10000);
  
  // Choose the approximation that yields a segment duration closest to target
  let bestApproximation = null;
  let bestError = Infinity;
  let bestGopSize = Math.ceil(targetDuration * fps); // Fallback value
  
  for (const approx of approximations) {
    // For ratio N/M ≈ audioFrameDuration/videoFrameDuration
    // We need M video frames ≈ N audio frames
    const videoFrames = approx.denominator;
    const audioFrames = approx.numerator;
    
    // Calculate actual segment duration if we used this ratio
    const segmentDuration = videoFrames / fps;
    
    // How many of these segments would we need to get close to target?
    // Find a multiple that gives us closest to target duration
    for (let multiple = 1; multiple <= 10; multiple++) {
      const actualDuration = segmentDuration * multiple;
      const gopSize = videoFrames * multiple;
      
      // If we've exceeded our target by too much, no need to check more multiples
      if (actualDuration > targetDuration * 1.5) break;
      
      // Calculate error relative to target
      const durationError = Math.abs(actualDuration - targetDuration);
      
      if (durationError < bestError) {
        bestError = durationError;
        bestApproximation = {
          gopSize: gopSize,
          segmentDuration: actualDuration,
          aacFramesPerSegment: audioFrames * multiple,
          actualDuration: actualDuration,
          error: durationError,
          alignmentError: approx.error,
          multipleUsed: multiple,
          fps,
          audioSampleRate
        };
      }
    }
  }
  
  // If no good approximation found, use the fallback
  if (!bestApproximation) {
    console.warn(`Could not find reasonable alignment, using approximation`);
    return {
      gopSize: bestGopSize,
      segmentDuration: bestGopSize / fps,
      aacFramesPerSegment: Math.ceil((bestGopSize / fps) / aacFrameDuration),
      actualDuration: bestGopSize / fps,
      fps,
      audioSampleRate,
      note: "Using simple approximation"
    };
  }
  
  // Report on the quality of alignment
  const errorPpm = bestApproximation.alignmentError * 1000000;
  if (errorPpm < 1) {
    console.log(`Perfect alignment achieved (error: <1 ppm)`);
  } else if (errorPpm < 100) {
    console.log(`Near-perfect alignment (error: ${errorPpm.toFixed(2)} ppm)`);
  } else if (errorPpm < 1000) {
    console.log(`Good alignment (error: ${errorPpm.toFixed(2)} ppm)`);
  } else if (errorPpm < 10000) {
    console.log(`Acceptable alignment (error: ${errorPpm.toFixed(2)} ppm)`);
  } else {
    console.log(`Approximate alignment (error: ${errorPpm.toFixed(2)} ppm)`);
  }
  
  return bestApproximation;
}

/**
 * Find multiple viable GOP sizes for a range of segment durations
 * @param {number} fps - Video frames per second
 * @param {number} audioSampleRate - Audio sample rate in Hz
 * @param {number} minDuration - Minimum segment duration to consider
 * @param {number} maxDuration - Maximum segment duration to consider
 * @param {number} step - Approximate step size between returned options
 * @returns {Array<Object>} - Array of viable GOP options
 */
function findViableGopSizes(fps, audioSampleRate = 48000, minDuration = 1, maxDuration = 6, step = 0.5) {
  const results = [];
  let lastDuration = 0;
  
  for (let target = minDuration; target <= maxDuration; target += 0.01) {
    const result = calculateAlignedGopSize(fps, audioSampleRate, 1024, target);
    
    // Only add if it's significantly different from the last one we added
    if (result.segmentDuration - lastDuration >= step || target === minDuration) {
      results.push(result);
      lastDuration = result.segmentDuration;
    }
    
    // If we've found enough options, stop
    if (results.length >= Math.ceil((maxDuration - minDuration) / step) + 1) {
      break;
    }
  }
  
  return results;
}

/**
 * Analyzes a video file and calculates the optimal GOP size based on
 * its frame rate and audio sample rate to ensure segment alignment
 * 
 * @param {string} videoPath - Path to the video file
 * @param {Object} options - Additional options
 * @param {number} options.targetDuration - Target segment duration (defaults to HLS_SEGMENT_TIME)
 * @param {boolean} options.findAlternatives - Whether to return multiple GOP size options
 * @returns {Promise<Object|Array>} - GOP calculation result(s)
 */
async function analyzeVideoForGop(videoPath, options = {}) {
  const targetDuration = options.targetDuration || config.HLS_SEGMENT_TIME;
  const findAlternatives = options.findAlternatives || false;
  
  // Get media info for frame rate and audio sample rate
  const mediaInfo = await getMediaInfo(videoPath);
  const fps = getVideoFps(mediaInfo);
  
  // Get audio sample rate from first audio stream
  const audioStream = (mediaInfo.streams || [])
    .find(s => s.codec_type === 'audio');
  const audioSampleRate = audioStream?.sample_rate ? parseInt(audioStream.sample_rate) : 48000;
  
  console.log(`GOP analysis: Video FPS=${fps}, Audio sample rate=${audioSampleRate}Hz`);
  
  if (findAlternatives) {
    return findViableGopSizes(fps, audioSampleRate, targetDuration * 0.5, targetDuration * 1.5, 0.2);
  } else {
    return calculateAlignedGopSize(fps, audioSampleRate, 1024, targetDuration);
  }
}

/**
 * Gets or calculates the optimal GOP size for a video
 * This is a convenience function that handles all the details
 * and returns just the GOP size for use in FFmpeg.
 * 
 * @param {string} videoPath - Path to the video file
 * @param {number} targetDuration - Target segment duration
 * @returns {Promise<number>} - The calculated GOP size
 */
async function getOptimalGopSize(videoPath, targetDuration = config.HLS_SEGMENT_TIME) {
  const result = await analyzeVideoForGop(videoPath, { targetDuration });
  console.log(`Optimal GOP size for ${targetDuration}s segments: ${result.gopSize} frames (actual duration: ${result.segmentDuration.toFixed(6)}s)`);
  return result.gopSize;
}

/**
 * Gets or calculates the optimal segment duration for a video
 * based on aligned GOP size calculation
 * 
 * @param {string} videoPath - Path to the video file
 * @param {number} targetDuration - Target segment duration
 * @returns {Promise<number>} - The calculated segment duration
 */
async function getOptimalSegmentDuration(videoPath, targetDuration = config.HLS_SEGMENT_TIME) {
  const result = await analyzeVideoForGop(videoPath, { targetDuration });
  return result.segmentDuration;
}

module.exports = {
  calculateAlignedGopSize,
  findViableGopSizes,
  analyzeVideoForGop,
  getOptimalGopSize,
  getOptimalSegmentDuration
};
