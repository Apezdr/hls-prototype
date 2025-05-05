// services/segmentManager.js
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const findVideoFile = require('../utils/findVideoFile');
const { processTsSegment } = require('../utils/tsProcessor');
const {
  HLS_OUTPUT_DIR,
  FFMPEG_PATH,
  HLS_SEGMENT_TIME,
  JIT_SEGMENT_BUFFER,
  HARDWARE_ENCODING_ENABLED,
  VIDEO_SOURCE_DIR,
  WEB_SUPPORTED_CODECS,
  TRANSCODING_PAUSE_THRESHOLD,
  PRESERVE_SEGMENTS,
  PRESERVE_FFMPEG_PLAYLIST,
} = require('../config/config');
const { safeFilename, ensureDir, waitForFileStability } = require('../utils/files');
const { getMediaInfo, getVideoFps, detectHdrType } = require('../utils/ffprobe');
const { buildFfmpegArgs } = require('./ffmpegUtils');
const { getOptimalSegmentDuration, getOptimalGopSize } = require('../utils/gopUtils');
const { acquireSlot, releaseSlot } = require('./hardwareTranscoderLimiter');
const { isSessionActive, createSessionLock, updateSessionLock } = require('./sessionManager');
const {
  calculateSegmentNumber,
  calculateSegmentTimestamp,
  findNearestKeyframeTimestamp,
  segmentNumberToFilename,
  timestampToSeconds, // Import this utility
  getAlignedSegmentDuration
} = require('../utils/timestampUtils');
const { getAudioFilterArgs } = require('../utils/audio');

// Map to track active transcoding processes
// key: videoId_variantLabel
// value: { process: ffmpeg, startSegment: number, latestSegment: number, adjustedTimestamp: number, outputPlaylistPath: string, finished: boolean }
const activeTranscodingProcesses = new Map();

// Map to track active viewers by resolution - key: videoId_variantLabel, value: {lastAccessTime, lastSegmentRequested}
const activeViewers = new Map();
// Time threshold in milliseconds to consider a viewer inactive (3 minutes)
const VIEWER_INACTIVITY_THRESHOLD = 3 * 60 * 1000;
// Check interval for viewer activity
const VIEWER_CHECK_INTERVAL = 10 * 1000;
// Start the viewer activity monitors
setInterval(pauseInactiveTranscoding, VIEWER_CHECK_INTERVAL);
setInterval(cleanupInactiveViewers, VIEWER_CHECK_INTERVAL * 6); // Less frequent complete cleanup

/**
 * Check if a segment file exists
 * @param {string} segmentPath - Full path to the segment file
 * @returns {Promise<boolean>} - True if the segment exists
 */
async function segmentExists(segmentPath) {
  try {
    await fs.access(segmentPath, fs.constants.F_OK);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Get all existing segments for a variant
 * @param {string} outputDir - Directory containing segments
 * @returns {Promise<Array<number>>} - Array of segment numbers that exist
 */
async function getExistingSegments(outputDir) {
  try {
    const files = await fs.readdir(outputDir);
    return files
      .filter(file => file.match(/^\d+\.ts$/))
      .map(file => parseInt(file, 10))
      .sort((a, b) => a - b);
  } catch (err) {
    return [];
  }
}

/**
// NOTE: updateVariantPlaylist is no longer needed with the -f hls approach
// FFmpeg manages its own playlist file.

// Maximum number of segments to generate ahead of current playback position
const MAX_SEGMENTS_AHEAD = 50;
// Threshold to resume transcoding when user approaches end of available segments
const RESUME_THRESHOLD = 20;

/**
 * Start transcoding from a specific timestamp
 * @param {string} videoPath - Path to the source video
 * @param {string} videoId - Video identifier
 * @param {object} variant - Variant information
 * @param {number} startTimestamp - Timestamp to start transcoding from
 * @param {number} startSegment - Starting segment number
 * @returns {Promise<void>}
 */
async function startTranscodingFromTimestamp(videoPath, videoId, variant, startTimestamp, startSegment) {
  const processKey = `${videoId}_${variant.label}`; // Key is now just videoId_variantLabel

  // --- Check for Existing Process ---
  const existingProcessInfo = activeTranscodingProcesses.get(processKey);
  if (existingProcessInfo) {
    console.log(`Transcoding already active for ${processKey}. StartSegment: ${existingProcessInfo.startSegment}, LatestSegment: ${existingProcessInfo.latestSegment}`);
    // No need to start a new one if one is already running for this variant
    return;
  }
  
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variant.label);
  await ensureDir(outputDir);
  
  // Get media info for accurate seeking and HDR detection
  const mediaInfo = await getMediaInfo(videoPath);
  
  // Find nearest keyframe for clean seeking
  const adjustedTimestamp = findNearestKeyframeTimestamp(mediaInfo, startTimestamp);
  console.log(`Adjusted seek point from ${startTimestamp}s to ${adjustedTimestamp}s for clean keyframe alignment`);
  
  // Parse the intended width and height
  const [w, h] = variant.resolution.split('x');
  const hdrType = detectHdrType(mediaInfo);
  const isSourceHDR = hdrType !== 'SDR';
  const variantForcedSDR = variant.isSDR && isSourceHDR;
  
  // Remove segment range calculation - HLS muxer handles this
  // const segmentsToGenerate = calculateExtendedSegmentRange(startSegment, MAX_SEGMENTS_AHEAD);
  // const segmentDuration = segmentsToGenerate.length * HLS_SEGMENT_TIME;
  
  // Calculate priority based on viewer activity
  let priority = 1;
  const viewerKey = `${videoId}_${variant.label}`;
  const viewerActivity = activeViewers.get(viewerKey);
  
  // Higher priority for actively viewed content
  if (viewerActivity) {
    priority += 2; // Base increase for active viewers
    
    // Calculate segment urgency (how close is this to current playback position)
    const distanceToPlayback = Math.abs(startSegment - viewerActivity.lastSegmentRequested);
    if (distanceToPlayback < 10) {
      // Higher priority for segments close to playback position
      priority += Math.max(0, 10 - distanceToPlayback);
    }
  }
  
  // Higher priority for higher quality variants
  const qualityFactor = variant.label.includes('1080p') ? 2 : 
                       variant.label.includes('720p') ? 1 : 0;
  priority += qualityFactor;
  
  // Get hardware encoding slot if available
  const useHardware = HARDWARE_ENCODING_ENABLED === "true" ? 
    await acquireSlot({
      taskId: processKey,
      priority,
      metadata: {
        videoId,
        variant: variant.label,
        startSegment,
        timestamp: Date.now()
      }
    }) : false;
  
  if (useHardware) {
    console.log(`Hardware slot acquired for ${processKey} with priority ${priority}, using hardware encoding if compatible with source.`);
  }
  
  // Get optimal GOP size for perfect alignment
  const gopSize = await getOptimalGopSize(videoPath, HLS_SEGMENT_TIME);
  const segmentDuration = await getOptimalSegmentDuration(videoPath, HLS_SEGMENT_TIME);
  
  // Define the path where FFmpeg will write its playlist
  const ffmpegPlaylistPath = path.join(outputDir, 'ffmpeg_playlist.m3u8');
  
  console.log(`GOP analysis: Video FPS=${getVideoFps(mediaInfo)}, Audio sample rate=48000Hz`);
  console.log(`Optimal GOP size for ${HLS_SEGMENT_TIME}s segments: ${gopSize} frames (actual duration: ${segmentDuration.toFixed(6)}s)`);

  // Use HLS muxer
  const args = await buildFfmpegArgs({
    videoPath,
    outputDir,
    width: w,
    height: h,
    bitrate: variant.bitrate,
    useHardware,
    variantForcedSDR,
    muxer: "hls", // Use HLS muxer
    startNumber: startSegment, // Tell HLS muxer where to start numbering
    outputPlaylistPath: ffmpegPlaylistPath // Tell FFmpeg where to write its playlist
  });

  // Add seek parameter and -copyts BEFORE input for more efficient seeking and consistent timestamps
  const inputIndex = args.indexOf('-i');
  if (inputIndex !== -1) {
    // Make sure -copyts comes before -ss for correct timestamp handling
    if (args[inputIndex - 2] === '-copyts') {
      // -copyts is already there, just add -ss
      args.splice(inputIndex - 1, 0, '-ss', adjustedTimestamp.toString());
    } else {
      // Add both -copyts and -ss
      args.splice(inputIndex, 0, '-ss', adjustedTimestamp.toString());
    }
  } else {
    // No input found (unlikely), add everything
    args.unshift('-copyts', '-ss', adjustedTimestamp.toString());
  }

  // Remove duration limit (-t), HLS muxer handles this
  
  // Ensure GOP size and force_key_frames use the exact same aligned segment duration
  const gopIndex = args.indexOf('-g');
  if (gopIndex !== -1 && gopIndex + 1 < args.length) {
    args[gopIndex + 1] = gopSize.toString();
  } else {
    args.push('-g', gopSize.toString());
  }
  
  // Find and update force_key_frames to use exact segment duration
  const keyframesIndex = args.indexOf('-force_key_frames');
  if (keyframesIndex !== -1 && keyframesIndex + 1 < args.length) {
    args[keyframesIndex + 1] = `expr:gte(t,n_forced*${segmentDuration.toFixed(6)})`;
  } else {
    args.push('-force_key_frames', `expr:gte(t,n_forced*${segmentDuration.toFixed(6)})`);
  }
  
  console.log(`Starting FFmpeg JIT transcoding for ${variant.label} from ${adjustedTimestamp}s (segment ${startSegment}) with args:`);
  console.log(args.join(' '));
  
  // Spawn FFmpeg process
  const ffmpeg = spawn(FFMPEG_PATH, args);
  
  // Store process info
  const processInfo = {
    process: ffmpeg,
    startSegment: startSegment,
    latestSegment: startSegment - 1, // Initialize to one before start
    adjustedTimestamp: adjustedTimestamp,
    outputPlaylistPath: ffmpegPlaylistPath,
    finished: false
  };
  activeTranscodingProcesses.set(processKey, processInfo);
  
  // --- Event Handlers ---
  let ffmpegErrorMessage = '';

  // Capture all stderr output for better error diagnosis
  ffmpeg.stderr.on('data', (data) => {
    const stderrString = data.toString();
    
    // Log only if it's not a progress line (reduce noise)
    if (!stderrString.match(/frame=\s*\d+/)) {
      console.log(`FFmpeg JIT (${variant.label} from ${adjustedTimestamp}s) stderr: ${stderrString.trim()}`);
    }
    
    // Check for error messages in stderr
    if (stderrString.includes('Error') || 
        stderrString.includes('Invalid') || 
        stderrString.includes('Unsupported') || 
        stderrString.includes('Failed') ||
        stderrString.includes('Cannot')) {
      ffmpegErrorMessage += stderrString.trim() + '\n';
    }
  });

  ffmpeg.on('progress', async (progress) => {
    // Calculate latest completed segment based on timemark and adjustedTimestamp
    try {
      const timemarkSeconds = timestampToSeconds(progress.timemark);
      // Add back the time we skipped with -ss
      const totalSecondsProcessed = processInfo.adjustedTimestamp + timemarkSeconds;
      
      // Get the aligned segment duration for accurate segment calculation
      const alignedDuration = await getAlignedSegmentDuration(videoPath, videoId);
      
      // Calculate the segment number corresponding to this time using aligned duration
      const currentLatestSegment = Math.max(0, Math.floor(totalSecondsProcessed / alignedDuration) - 1); // -1 because segment N finishes *after* N*duration

      if (currentLatestSegment > processInfo.latestSegment) {
        processInfo.latestSegment = currentLatestSegment;
        // console.log(`[Progress] ${processKey}: Latest completed segment: ${processInfo.latestSegment}`);
      }
    } catch (e) {
      console.warn(`Error parsing progress timemark: ${progress.timemark}`, e);
    }
  });

  ffmpeg.on('end', () => {
    console.log(`FFmpeg JIT process for ${processKey} finished successfully.`);
    processInfo.finished = true;
    // No need to delete from map here, keep info for segment checks
    // activeTranscodingProcesses.delete(processKey);
    if (useHardware) {
      // Release hardware slot with task ID
      releaseSlot(processKey);
    }
  });

  // Handle explicit error events
  ffmpeg.on('error', (err, stdout, stderr) => {
    if (err.message.includes('SIGTERM') || err.message.includes('SIGKILL')) {
      console.log(`FFmpeg process for ${processKey} terminated as expected.`);
    } else {
      console.error(`FFmpeg JIT process for ${processKey} failed with error: ${err.message}`);
      if (stderr) console.error(`FFmpeg stderr: ${stderr}`);
      
      // Capture any error details from captured stderr
      if (ffmpegErrorMessage) {
        console.error(`Accumulated FFmpeg error details:\n${ffmpegErrorMessage}`);
      }
      
      processInfo.errorMessage = err.message;
      processInfo.finished = true;
    }
    if (useHardware) {
      releaseSlot(processKey);
    }
  });

  // Handle process exit (covers errors and normal exit)
  ffmpeg.on('exit', (code, signal) => {
    console.log(`FFmpeg process for ${processKey} exited with code ${code}, signal ${signal}`);
    
    // Analyze non-zero exit codes
    if (code !== 0 && code !== null) {
      // Convert to signed 32-bit integer if it's a large value
      // (FFmpeg error codes are often negative values that Node returns as large unsigned values)
      if (code > 0x7FFFFFFF) {
        const signedCode = code - 0x100000000;
        console.error(`FFmpeg exited with error code ${signedCode} (0x${code.toString(16)})`);
      } else {
        console.error(`FFmpeg exited with error code ${code}`);
      }
      
      // Log accumulated stderr for error diagnosis
      if (ffmpegErrorMessage) {
        console.error(`FFmpeg error details:\n${ffmpegErrorMessage}`);
      }
      
      // Store error info in process info
      processInfo.errorCode = code;
      processInfo.errorMessage = ffmpegErrorMessage || `Exited with code ${code}`;
    }
    
    // Ensure it's marked finished
    processInfo.finished = true;
    
    // Clean up process entry if appropriate
    // Keeping it for finished check & error reporting
    
    // Release hardware slot if used
    if (useHardware) {
      releaseSlot(processKey);
    }
  });
  
  // Register this transcoding session
  await createSessionLock(videoId, variant.label);
  
  // No need to wait here, the ensureSegment logic will handle waiting
}

// Remove calculateSegmentRangeToGenerate and calculateExtendedSegmentRange
// as FFmpeg HLS muxer handles segment generation duration

// Remove shouldContinueTranscoding - the seek detection logic replaces this

/**
 * Ensure a segment is available, starting transcoding if needed
 * @param {string} videoId - Video identifier
 * @param {object} variant - Variant information
 * @param {string} videoPath - Path to source video
 * @param {number} segmentNumber - Segment number to ensure
 * @returns {Promise<string>} - Path to the segment file when it's ready
 */
async function ensureSegment(videoId, variant, videoPath, segmentNumber) {
  const processKey = `${videoId}_${variant.label}`;
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variant.label);
  const segmentFile = segmentNumberToFilename(segmentNumber);
  const segmentPath = path.join(outputDir, segmentFile);

  // Get the aligned segment duration for this video
  const alignedDuration = await getAlignedSegmentDuration(videoPath, videoId);

  // --- 1. Update Viewer Activity ---
  trackViewerActivity(videoId, variant.label, segmentNumber);

  // --- 2. Check for Active Process & Seek Detection ---
  let processInfo = activeTranscodingProcesses.get(processKey);
  let needsRestart = false;

  if (processInfo) {
    const { startSegment, latestSegment, finished } = processInfo;
    const segmentExistsOnDisk = await segmentExists(segmentPath);

    // Check for seek ahead (requested segment is far beyond latest processed)
    if (!finished && segmentNumber > latestSegment + 10) { // Use a threshold like 10 segments
      console.log(`[Seek Ahead] Detected for ${processKey}. Requested: ${segmentNumber}, Latest: ${latestSegment}. Restarting.`);
      needsRestart = true;
    }
    // Check for seek behind (requested segment is before start and doesn't exist)
    else if (segmentNumber < startSegment && !segmentExistsOnDisk) {
      console.log(`[Seek Behind] Detected for ${processKey}. Requested: ${segmentNumber}, Start: ${startSegment}. Restarting.`);
      needsRestart = true;
    }

    if (needsRestart) {
      await stopActiveTranscoding(videoId, variant.label); // Stop the current process
      processInfo = null; // Clear processInfo so we start a new one below
    }
  }

  // --- 3. Start Transcoding if Necessary ---
  if (!processInfo) {
    console.log(`No active process for ${processKey} or restart needed. Starting transcoding.`);
    // Use aligned duration for timestamp calculation
    const ts = calculateSegmentTimestamp(segmentNumber, alignedDuration);
    // Ensure we get media info for keyframe seeking
    const mediaInfo = await getMediaInfo(videoPath);
    const adjustedTimestamp = findNearestKeyframeTimestamp(mediaInfo, ts);
    // Recalculate segment number using aligned duration
    const adjustedStartSegment = calculateSegmentNumber(adjustedTimestamp, alignedDuration);

    await startTranscodingFromTimestamp(videoPath, videoId, variant, adjustedTimestamp, adjustedStartSegment);
    processInfo = activeTranscodingProcesses.get(processKey); // Get the newly started process info

    // If starting failed somehow
    if (!processInfo) {
       throw new Error(`Failed to start transcoding process for ${processKey}`);
    }
  }

  // --- 4. Wait for Segment Availability ---
  const { latestSegment, finished } = processInfo;

  // Check if the segment should already be available based on progress
  const isSegmentProcessed = finished || segmentNumber <= latestSegment + 1; // Add buffer

  if (isSegmentProcessed) {
    try {
      // Wait for the file to exist and be stable
      await waitForFileStability(segmentPath, 200, 9000); // Wait up to 9 seconds
      console.log(`Segment ${segmentNumber} for ${processKey} is available.`);
      // --- 5. (Optional) TS Continuity Check/Fix ---
      // If needed, re-introduce processTsSegment here, but test without first
      // await processTsSegment(videoId, variant.label, segmentPath, segmentNumber);
      return segmentPath;
    } catch (err) {
      // File didn't appear or stabilize in time
      console.error(`Timeout or error waiting for segment ${segmentNumber} for ${processKey}:`, err);
      // Check if the process errored out
      if (processInfo.finished && !err.message.includes('Timeout')) { // Check if finished due to error
         throw new Error(`Transcoding process for ${processKey} failed.`);
      }
      // If process is still running but segment didn't appear, maybe it's slow
      throw new Error(`Timeout waiting for segment ${segmentNumber} for ${processKey}.`);
    }
  } else {
    // Segment is requested ahead of what's processed, wait might be long
    console.log(`Segment ${segmentNumber} for ${processKey} requested ahead of progress (latest: ${latestSegment}). Waiting...`);
    // Implement a longer wait or a retry mechanism if needed, or just timeout
    try {
      await waitForFileStability(segmentPath, 500, 15000); // Wait longer
       console.log(`Segment ${segmentNumber} for ${processKey} became available after waiting.`);
       // await processTsSegment(videoId, variant.label, segmentPath, segmentNumber); // Optional
       return segmentPath;
    } catch (err) {
       console.error(`Long wait timeout for segment ${segmentNumber} for ${processKey}:`, err);
       throw new Error(`Segment ${segmentNumber} not available yet for ${processKey}.`);
    }
  }
}

/**
 * Calculates exact segment duration based on video frame rate and audio frame alignment
 * @param {string} videoPath - Path to video file
 * @returns {Promise<string>} - Formatted segment duration for playlist (e.g., "5.005000")
 */
async function calculateExactSegmentDuration(videoPath) {
  try {
    // Use GOP utility to calculate optimal segment duration with AAC frame alignment
    const segmentDuration = await getOptimalSegmentDuration(videoPath, HLS_SEGMENT_TIME);
    
    // Format to 6 decimal places as seen in example
    return segmentDuration.toFixed(6);
  } catch (error) {
    console.error('Error calculating aligned segment duration:', error);
    
    // Fall back to the old calculation method if GOP utility fails
    try {
      const mediaInfo = await getMediaInfo(videoPath);
      const fps = getVideoFps(mediaInfo);
      
      // Calculate frames per segment
      const framesPerSegment = Math.round(HLS_SEGMENT_TIME * fps);
      
      // Calculate exact segment duration from frames
      const exactDuration = framesPerSegment / fps;
      
      return exactDuration.toFixed(6);
    } catch (fallbackError) {
      console.error('Fallback segment duration calculation failed:', fallbackError);
      // Last resort: use config value with standard formatting
      return HLS_SEGMENT_TIME.toFixed(6);
    }
  }
}

/**
 * Creates a playlist file with properly formatted segment entries if it doesn't exist
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label 
 * @param {object} options - Optional parameters
 * @param {number} options.mediaTrackIndex - For audio, the Nth audio-stream index to get duration
 * @returns {Promise<string>} - Path to the playlist
 */
async function ensureVariantPlaylist(videoId, variantLabel, options = {}) {
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variantLabel);
  await ensureDir(outputDir);

  const playlistPath = path.join(outputDir, 'playlist.m3u8');

  try {
    await fs.access(playlistPath, fs.constants.F_OK);
  } catch {
    // 1) Locate source
    const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);
    if (!videoPath) throw new Error(`Video file not found for ${videoId}`);

    // 2) Probe container for durations
    const mediaInfo = await getMediaInfo(videoPath);
    const exactDuration = await calculateExactSegmentDuration(videoPath);

    // 3) Default to the overall format duration
    const videoStream = (mediaInfo.streams || [])
      .find(s => s.codec_type === 'video');
    let mediaDuration = parseFloat(videoStream?.duration || 0);
    const audioStreams = (mediaInfo.streams || [])
    .filter(s => s.codec_type === 'audio');

    // 4) If user wants a specific audio track, pick the Nth audio stream
    if (options.mediaTrackIndex !== undefined) {
      const chosen = audioStreams[options.mediaTrackIndex];
      if (chosen && chosen.duration) {
        mediaDuration = parseFloat(chosen.duration);
        console.log(`Using audio stream ${options.mediaTrackIndex} duration: ${mediaDuration}s`);
      }
    }
    // 5) Fallback to first video stream if still unknown
    else if (mediaDuration <= 0) {
      if (videoStream && videoStream.duration) {
        mediaDuration = parseFloat(videoStream.duration);
        console.log(`Using video stream duration: ${mediaDuration}s`);
      }
    }

    // 6) Cap at 24h
    const maxDuration = 24 * 60 * 60;
    if (mediaDuration > maxDuration) {
      console.log(`Media duration (${mediaDuration}s) exceeds 24h; capping at ${maxDuration}s`);
      mediaDuration = maxDuration;
    }

    // 7) Compute segment count
    const defaultDuration = 2 * 60 * 60;
    const initialSegmentCount = mediaDuration > 0
      ? Math.ceil(mediaDuration / HLS_SEGMENT_TIME)
      : Math.ceil(defaultDuration / HLS_SEGMENT_TIME);

    const isAudio = variantLabel.startsWith('audio_');
    console.log(`${isAudio ? 'Audio' : 'Video'} duration: ${mediaDuration}s, ` +
                `creating playlist with ${initialSegmentCount} segments`);

    // 8) Build proper VOD playlist structure with placeholders for all segments
    let initialPlaylist =
      '#EXTM3U\n' +
      '#EXT-X-VERSION:3\n' +
      `#EXT-X-TARGETDURATION:${Math.ceil(HLS_SEGMENT_TIME)}\n` +
      '#EXT-X-MEDIA-SEQUENCE:0\n' +
      '#EXT-X-PLAYLIST-TYPE:VOD\n';
      //'#EXT-X-INDEPENDENT-SEGMENTS\n' +
    
    // Include all placeholder segments - this is important for proper seeking
    // in VOD content, even though the segments may not exist yet
    for (let i = 0; i < initialSegmentCount; i++) {
      initialPlaylist += `#EXTINF:${exactDuration},\n` +
                         `${segmentNumberToFilename(i)}\n`;
    }
    
    // Add the ENDLIST tag to signal it's a proper VOD
    initialPlaylist += '#EXT-X-ENDLIST\n';

    await fs.writeFile(playlistPath, initialPlaylist);
    console.log(`Created initial playlist at ${playlistPath} ` +
                `with ${initialSegmentCount} placeholder segments`);
  }

  return playlistPath;
}


/**
 * Track viewer activity when requesting a segment
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @param {number} segmentNumber - Segment number being requested
 */
function trackViewerActivity(videoId, variantLabel, segmentNumber) {
  const viewerKey = `${videoId}_${variantLabel}`;
  
  // Update or create viewer activity record
  activeViewers.set(viewerKey, {
    lastAccessTime: Date.now(),
    lastSegmentRequested: segmentNumber
  });
  
  console.log(`Tracked activity for ${viewerKey}, segment ${segmentNumber}`);
}

/**
 * Check if a viewer has skipped ahead
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @param {number} requestedSegment - Currently requested segment number
 * @returns {boolean} - True if viewer has skipped ahead
 */
function hasViewerSkippedAhead(videoId, variantLabel, requestedSegment) {
  const viewerKey = `${videoId}_${variantLabel}`;
  const viewer = activeViewers.get(viewerKey);
  
  // No previous activity for this viewer
  if (!viewer) return false;
  
  // Check if the requested segment is significantly ahead of the last one
  // (allowing for normal playback progression)
  const lastSegment = viewer.lastSegmentRequested;
  const segmentDiff = requestedSegment - lastSegment;
  
  // Consider it a skip ahead if more than 3 segments ahead (15 seconds with 5s segments)
  return segmentDiff > 3;
}

/**
 * Stop active transcoding processes for a specific variant or segment range
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @param {number} fromSegment - Optional segment number to start from (if skipping ahead)
 * @returns {Promise<void>}
 */
async function stopActiveTranscoding(videoId, variantLabel, fromSegment = null) {
  const processKey = `${videoId}_${variantLabel}`;
  const processInfo = activeTranscodingProcesses.get(processKey);

  if (!processInfo) {
    // console.log(`No active transcoding process found for ${processKey} to stop.`);
    return;
  }

  // Check if we should stop based on fromSegment (seek detection)
  // If fromSegment is provided, we only stop if the current process started *before* it.
  // This logic might need refinement depending on exact seek behavior desired.
  if (fromSegment !== null && processInfo.startSegment >= fromSegment) {
     console.log(`Not stopping process for ${processKey} as it started at or after the seek point ${fromSegment}`);
     return; // Don't stop if the existing process covers the seek point
  }

  console.log(`Stopping transcoding process for ${processKey}`);

  try {
    // Kill the FFmpeg process
    processInfo.process.kill('SIGTERM');
    console.log(`Successfully sent SIGTERM to process for ${processKey}`);
  } catch (err) {
    // Ignore errors if process already exited
    if (!err.message.includes('ESRCH')) { // ESRCH: No such process
       console.error(`Error sending SIGTERM to process for ${processKey}:`, err);
    }
  }

  // Remove from active processes map immediately
  activeTranscodingProcesses.delete(processKey);

  // --- Optionally Cleanup Generated Files ---
  if (!PRESERVE_SEGMENTS || !PRESERVE_FFMPEG_PLAYLIST) {
    const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variantLabel);
    try {
      console.log(`Cleaning up files in ${outputDir} for stopped process ${processKey} (preserveSegments: ${PRESERVE_SEGMENTS}, preservePlaylist: ${PRESERVE_FFMPEG_PLAYLIST})`);
      const files = await fs.readdir(outputDir);
      const cleanupPromises = [];

      for (const file of files) {
        // Only delete segments if not preserving them
        if (!PRESERVE_SEGMENTS && file.endsWith('.ts')) {
          const filePath = path.join(outputDir, file);
          cleanupPromises.push(
            fs.unlink(filePath).catch(err => {
              // Log errors but don't fail the whole cleanup
              console.warn(`Failed to delete file ${filePath}: ${err.message}`);
            })
          );
        } 
        // Only delete FFmpeg playlist if not preserving it
        else if (!PRESERVE_FFMPEG_PLAYLIST && file === 'ffmpeg_playlist.m3u8') {
          const filePath = path.join(outputDir, file);
          cleanupPromises.push(
            fs.unlink(filePath).catch(err => {
              console.warn(`Failed to delete file ${filePath}: ${err.message}`);
            })
          );
        }
      }
      
      if (cleanupPromises.length > 0) {
        await Promise.all(cleanupPromises);
        console.log(`Finished cleanup for ${processKey}`);
      } else {
        console.log(`No files to clean up for ${processKey} (all files preserved)`);
      }
    } catch (err) {
      // Log error if reading directory fails, but don't block
      console.error(`Error reading directory for cleanup ${outputDir}: ${err.message}`);
    }
  } else {
    console.log(`Skipping file cleanup for ${processKey} (preserving all files)`);
  }
}

/**
 * Clean up inactive viewers and stop their transcoding processes
 */
async function cleanupInactiveViewers() {
  const now = Date.now();
  const inactiveViewers = [];
  
  // Identify inactive viewers
  for (const [viewerKey, data] of activeViewers.entries()) {
    const timeSinceLastAccess = now - data.lastAccessTime;
    
    if (timeSinceLastAccess > VIEWER_INACTIVITY_THRESHOLD) {
      inactiveViewers.push(viewerKey);
    }
  }
  
  // Process inactive viewers
  for (const viewerKey of inactiveViewers) {
    console.log(`Viewer ${viewerKey} inactive for more than ${VIEWER_INACTIVITY_THRESHOLD/1000} seconds, cleaning up...`);
    
    // Extract videoId and variantLabel from the key
    const [videoId, variantLabel] = viewerKey.split('_');
    
    // Stop active transcoding processes for this viewer
    await stopActiveTranscoding(videoId, variantLabel);
    
    // Remove the viewer from the tracking map
    activeViewers.delete(viewerKey);
    
    console.log(`Cleanup complete for inactive viewer ${viewerKey}`);
  }
  
  if (inactiveViewers.length > 0) {
    console.log(`Cleaned up ${inactiveViewers.length} inactive viewers`);
  }
}

/**
 * Pause a single transcoding process without full cleanup
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label 
 * @returns {Promise<boolean>} - Whether the process was successfully paused
 */
async function pauseTranscodingProcess(videoId, variantLabel) {
  const processKey = `${videoId}_${variantLabel}`;
  const processInfo = activeTranscodingProcesses.get(processKey);
  
  if (!processInfo || processInfo.finished) {
    return false;
  }
  
  try {
    // Kill the FFmpeg process
    processInfo.process.kill('SIGTERM');
    console.log(`Paused transcoding process for ${processKey}`);
    
    // Remove from active processes map but retain the info for future reference
    const { startSegment, latestSegment } = processInfo;
    processInfo.finished = true;
    processInfo.pausedAt = Date.now();
    
    // Keep the process info in the map but mark as finished
    // This allows future requests to know what segments already exist
    console.log(`Process info preserved: segments ${startSegment} to ${latestSegment}`);
    
    return true;
  } catch (err) {
    console.error(`Error pausing transcoding process for ${processKey}:`, err);
    return false;
  }
}

/**
 * Pause transcoding for viewers who haven't requested segments recently
 * This is more aggressive than cleanupInactiveViewers - it stops transcoding
 * after a pause in activity but keeps viewer data and segments
 */
async function pauseInactiveTranscoding() {
  const now = Date.now();
  
  // Check all active transcoding processes
  for (const [key, process] of activeTranscodingProcesses.entries()) {
    // Skip already finished processes
    if (process.finished) continue;
    
    // Extract videoId and variant from the process key
    const parts = key.split('_');
    if (parts.length >= 2) {
      const videoId = parts[0];
      const variantLabel = parts[1];
      const viewerKey = `${videoId}_${variantLabel}`;
      
      const viewer = activeViewers.get(viewerKey);
      
      // If no recent activity for this variant, pause transcoding
      if (!viewer || (now - viewer.lastAccessTime > TRANSCODING_PAUSE_THRESHOLD)) {
        console.log(`No recent activity for ${viewerKey} (last activity: ${viewer ? Math.floor((now - viewer.lastAccessTime)/1000) + 's ago' : 'never'}), pausing transcoding`);
        
        await pauseTranscodingProcess(videoId, variantLabel);
      }
    }
  }
}

/**
 * Start transcoding audio from a specific timestamp
 * @param {string} videoPath - Path to the source video
 * @param {string} videoId - Video identifier
 * @param {object} audioVariant - Audio variant information
 * @param {number} startTimestamp - Timestamp to start transcoding from
 * @param {number} startSegment - Starting segment number
 * @returns {Promise<void>}
 */
async function startAudioTranscodingFromTimestamp(videoPath, videoId, audioVariant, startTimestamp, startSegment) {
  const processKey = `${videoId}_${audioVariant.label}`; // Key is now just videoId_variantLabel

  // --- Check for Existing Process ---
  const existingProcessInfo = activeTranscodingProcesses.get(processKey);
  if (existingProcessInfo) {
    console.log(`Audio transcoding already active for ${processKey}. StartSegment: ${existingProcessInfo.startSegment}, LatestSegment: ${existingProcessInfo.latestSegment}`);
    return;
  }
  
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariant.label);
  await ensureDir(outputDir);
  
  // Get media info for accurate seeking
  const mediaInfo = await getMediaInfo(videoPath);
  
  // Find nearest keyframe for clean seeking
  const adjustedTimestamp = findNearestKeyframeTimestamp(mediaInfo, startTimestamp);
  console.log(`Adjusted audio seek point from ${startTimestamp}s to ${adjustedTimestamp}s for clean keyframe alignment`);
  
  // Remove segment range calculation - HLS muxer handles this
  // const segmentsToGenerate = calculateExtendedSegmentRange(startSegment, MAX_SEGMENTS_AHEAD);
  // const segmentDuration = segmentsToGenerate.length * HLS_SEGMENT_TIME;

  // Calculate priority based on viewer activity
  let priority = 1;
  const viewerKey = `${videoId}_${audioVariant.label}`;
  const viewerActivity = activeViewers.get(viewerKey);
  
  // Higher priority for actively viewed content
  if (viewerActivity) {
    priority += 2; // Base increase for active viewers
    
    // Calculate segment urgency
    const distanceToPlayback = Math.abs(startSegment - viewerActivity.lastSegmentRequested);
    if (distanceToPlayback < 10) {
      // Higher priority for segments close to playback position
      priority += Math.max(0, 10 - distanceToPlayback);
    }
  }
  
  // Higher priority for multi-channel audio
  if (audioVariant.channels > 2) {
    priority += 1; // Prioritize surround sound
  }
  
  // Get hardware encoding slot if available
  const useHardware = HARDWARE_ENCODING_ENABLED === "true" ? 
    await acquireSlot({
      taskId: processKey,
      priority,
      metadata: {
        videoId,
        variant: audioVariant.label,
        startSegment,
        isAudio: true,
        channels: audioVariant.channels,
        timestamp: Date.now()
      }
    }) : false;
  
  if (useHardware) {
    console.log(`Hardware slot acquired for audio ${processKey} with priority ${priority}`);
  }

  // GOP calculation might still be relevant for keyframe placement if not copying
  const fps = getVideoFps(mediaInfo);
  const gopSize = Math.ceil(HLS_SEGMENT_TIME * fps);
  
  // Determine audio codec and bitrate
  const audioTrackIndex = audioVariant.trackIndex;
  let audioCodecArg = audioVariant.codec;
  const originalCodec = audioVariant.originalCodec;
  const channels = audioVariant.channels;
  
  // Decide whether to copy or transcode
  let codecOpts = [];
  let bitRate = '128k';
  
  if (channels > 2) {
    bitRate = '384k';
  }
  
  if (audioCodecArg && audioCodecArg.toLowerCase() === originalCodec.toLowerCase()) {
    // Use copy if requested codec matches source
    audioCodecArg = 'copy';
    codecOpts = [];
  } else {
    // Check if requested codec is supported
    if (audioCodecArg && WEB_SUPPORTED_CODECS.includes(audioCodecArg.toLowerCase())) {
      audioCodecArg = audioCodecArg.toLowerCase();
    } else {
      audioCodecArg = 'aac';
    }
    
    // Apply audio channel options and filters
    const audioChannelOption = ['-ac', channels.toString()];
    const filterArgs = getAudioFilterArgs(channels, true);
    
    codecOpts = [
      ...audioChannelOption,
      '-b:a', bitRate,
      ...filterArgs,
    ];
  }
  
  // Define the path where FFmpeg will write its playlist
  const ffmpegPlaylistPath = path.join(outputDir, 'ffmpeg_playlist.m3u8');

  const segmentDuration = await getOptimalSegmentDuration(videoPath, HLS_SEGMENT_TIME);

  // Build FFmpeg args for audio transcoding using HLS muxer
  const args = [
    // Input options
    '-copyts', // Copy timestamps - maintain this BEFORE seek (-ss)
    '-ss', adjustedTimestamp.toString(), // Seek
    '-i', videoPath,

    // Mapping & Codec
    '-map', `0:a:${audioTrackIndex}`, // Map the correct audio stream
    '-c:a', audioCodecArg, // 'copy' or specific codec (e.g., 'aac')
    ...codecOpts, // Bitrate, channel mapping filters etc.

    // HLS Output options
    '-f', 'hls',
    '-copyts', // Copy timestamps for output too
    // Use aligned segment duration for audio segments too
    // Format to 6 decimal places for precision
    '-hls_time', `${segmentDuration.toFixed(6)}`,
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'independent_segments',
    '-start_number', startSegment.toString(),
    '-hls_segment_filename', path.join(outputDir, '%03d.ts'), // Segment naming
    ffmpegPlaylistPath // FFmpeg managed playlist output path
  ];

  // Add GOP size if not copying codec
  if (audioCodecArg !== 'copy') {
     args.push('-g', `${gopSize}`);
     // Consider adding force_key_frames for audio if needed, though less common
     // args.push("-force_key_frames", `expr:gte(t,n_forced*${HLS_SEGMENT_TIME})`);
  }
  
  console.log(`Starting FFmpeg audio JIT transcoding for ${audioVariant.label} from ${adjustedTimestamp}s (segment ${startSegment}) with args:`);
  console.log(args.join(' '));
  
  // Spawn FFmpeg process
  const ffmpeg = spawn(FFMPEG_PATH, args);
  
  // Store process info
  const processInfo = {
    process: ffmpeg,
    startSegment: startSegment,
    latestSegment: startSegment - 1,
    adjustedTimestamp: adjustedTimestamp,
    outputPlaylistPath: ffmpegPlaylistPath,
    finished: false
  };
  activeTranscodingProcesses.set(processKey, processInfo);
  
  // --- Event Handlers (Mirroring video implementation) ---
  ffmpeg.stderr.on('data', (data) => {
    // console.log(`FFmpeg Audio JIT (${audioVariant.label} from ${adjustedTimestamp}s) stderr: ${data}`);
  });

  ffmpeg.on('progress', async (progress) => {
    try {
      const timemarkSeconds = timestampToSeconds(progress.timemark);
      const totalSecondsProcessed = processInfo.adjustedTimestamp + timemarkSeconds;
      
      // Get the aligned segment duration for accurate segment calculation
      const alignedDuration = await getAlignedSegmentDuration(videoPath, videoId);
      
      // Calculate using aligned duration instead of fixed HLS_SEGMENT_TIME
      const currentLatestSegment = Math.max(0, Math.floor(totalSecondsProcessed / alignedDuration) - 1);
      
      if (currentLatestSegment > processInfo.latestSegment) {
        processInfo.latestSegment = currentLatestSegment;
        // console.log(`[Progress] ${processKey} Audio: Latest completed segment: ${processInfo.latestSegment}`);
      }
    } catch (e) {
      console.warn(`Error parsing audio progress timemark: ${progress.timemark}`, e);
    }
  });

  ffmpeg.on('end', () => {
    console.log(`FFmpeg Audio JIT process for ${processKey} finished successfully.`);
    processInfo.finished = true;
  });

  ffmpeg.on('error', (err, stdout, stderr) => {
    if (err.message.includes('SIGTERM') || err.message.includes('SIGKILL')) {
      console.log(`FFmpeg audio process for ${processKey} terminated as expected.`);
    } else {
      console.error(`FFmpeg Audio JIT process for ${processKey} failed: ${err.message}`);
      console.error(`FFmpeg stderr: ${stderr}`);
      processInfo.finished = true;
    }
  });

   ffmpeg.on('exit', (code, signal) => {
    console.log(`FFmpeg audio process for ${processKey} exited with code ${code}, signal ${signal}`);
    processInfo.finished = true;
  });
  
  // Register this transcoding session
  await createSessionLock(videoId, audioVariant.label);
  
  // No need to wait here
}

/**
 * Ensure an audio segment is available, starting transcoding if needed
 * @param {string} videoId - Video identifier
 * @param {object} audioVariant - Audio variant information
 * @param {string} videoPath - Path to source video
 * @param {number} segmentNumber - Segment number to ensure
 * @returns {Promise<string>} - Path to the segment file when it's ready
 */
async function ensureAudioSegment(videoId, audioVariant, videoPath, segmentNumber) {
  // This function will now mirror the logic of ensureSegment,
  // but use startAudioTranscodingFromTimestamp
  const processKey = `${videoId}_${audioVariant.label}`;
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariant.label);
  const segmentFile = segmentNumberToFilename(segmentNumber);
  const segmentPath = path.join(outputDir, segmentFile);

  // Get the aligned segment duration for this video
  const alignedDuration = await getAlignedSegmentDuration(videoPath, videoId);

  // --- 1. Update Viewer Activity ---
  trackViewerActivity(videoId, audioVariant.label, segmentNumber);

  // --- 2. Check for Active Process & Seek Detection ---
  let processInfo = activeTranscodingProcesses.get(processKey);
  let needsRestart = false;

  if (processInfo) {
    const { startSegment, latestSegment, finished } = processInfo;
    const segmentExistsOnDisk = await segmentExists(segmentPath);

    if (!finished && segmentNumber > latestSegment + 10) {
      console.log(`[Seek Ahead] Detected for ${processKey} audio. Requested: ${segmentNumber}, Latest: ${latestSegment}. Restarting.`);
      needsRestart = true;
    } else if (segmentNumber < startSegment && !segmentExistsOnDisk) {
      console.log(`[Seek Behind] Detected for ${processKey} audio. Requested: ${segmentNumber}, Start: ${startSegment}. Restarting.`);
      needsRestart = true;
    }

    if (needsRestart) {
      await stopActiveTranscoding(videoId, audioVariant.label);
      processInfo = null;
    }
  }

  // --- 3. Start Transcoding if Necessary ---
  if (!processInfo) {
    console.log(`No active process for ${processKey} audio or restart needed. Starting transcoding.`);
    // Use aligned duration for timestamp calculation
    const ts = calculateSegmentTimestamp(segmentNumber, alignedDuration);
    const mediaInfo = await getMediaInfo(videoPath);
    const adjustedTimestamp = findNearestKeyframeTimestamp(mediaInfo, ts);
    // Recalculate segment number using aligned duration
    const adjustedStartSegment = calculateSegmentNumber(adjustedTimestamp, alignedDuration);

    await startAudioTranscodingFromTimestamp(videoPath, videoId, audioVariant, adjustedTimestamp, adjustedStartSegment);
    processInfo = activeTranscodingProcesses.get(processKey);

    if (!processInfo) {
       throw new Error(`Failed to start audio transcoding process for ${processKey}`);
    }
  }

  // --- 4. Wait for Segment Availability ---
  const { latestSegment, finished } = processInfo;
  const isSegmentProcessed = finished || segmentNumber <= latestSegment + 1;

  if (isSegmentProcessed) {
    try {
      await waitForFileStability(segmentPath, 200, 9000);
      console.log(`Audio segment ${segmentNumber} for ${processKey} is available.`);
      // await processTsSegment(videoId, audioVariant.label, segmentPath, segmentNumber); // Optional TS fix
      return segmentPath;
    } catch (err) {
      console.error(`Timeout or error waiting for audio segment ${segmentNumber} for ${processKey}:`, err);
      if (processInfo.finished && !err.message.includes('Timeout')) {
         throw new Error(`Audio transcoding process for ${processKey} failed.`);
      }
      throw new Error(`Timeout waiting for audio segment ${segmentNumber} for ${processKey}.`);
    }
  } else {
    console.log(`Audio segment ${segmentNumber} for ${processKey} requested ahead of progress (latest: ${latestSegment}). Waiting...`);
    try {
      await waitForFileStability(segmentPath, 500, 15000);
       console.log(`Audio segment ${segmentNumber} for ${processKey} became available after waiting.`);
       // await processTsSegment(videoId, audioVariant.label, segmentPath, segmentNumber); // Optional TS fix
       return segmentPath;
    } catch (err) {
       console.error(`Long wait timeout for audio segment ${segmentNumber} for ${processKey}:`, err);
       throw new Error(`Audio segment ${segmentNumber} not available yet for ${processKey}.`);
    }
  }
}

module.exports = {
  ensureSegment,
  ensureAudioSegment,
  ensureVariantPlaylist,
  // updateVariantPlaylist, // Removed
  segmentExists,
  getExistingSegments,
  trackViewerActivity,
  stopActiveTranscoding
};
