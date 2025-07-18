// utils/keyframeUtils.js
const fsPromises = require('fs').promises;
const fs = require('fs'); // Import regular fs for sync operations
const path = require('path');
const { spawn } = require('child_process');
const { FFPROBE_PATH, FFMPEG_PATH, HLS_OUTPUT_DIR } = require('../config/config');
const { safeFilename, ensureDir } = require('./files');
const { getMediaInfo, getVideoFps, getVideoDuration } = require('./ffprobe');
const { timestampToSeconds, getSegmentBoundaries } = require('./timestampUtils');
const { getSegmentExtensionForVariant } = require('./codecReferenceUtils');
const findVideoFile = require('./findVideoFile');

// Keep track of in-progress keyframe extractions to prevent duplicate work
const inProgressExtractions = new Map();

/**
 * Extract keyframe timestamps from a video file using FFprobe packet inspection
 * This method is much more efficient as it doesn't require decoding the video
 * @param {string} videoPath - Path to the source video
 * @returns {Promise<Array<Object>>} - Array of keyframe objects with timestamps
 */
async function extractKeyframes(videoPath) {
  return new Promise((resolve, reject) => {
    // Default value for file size
    let fileSizeGB = 0;
    
    // Check file size just for logging purposes
    try {
      const stats = fs.statSync(videoPath);
      fileSizeGB = stats.size / (1024 * 1024 * 1024);
      console.log(`File size: ${fileSizeGB.toFixed(2)}GB`);
    } catch (err) {
      console.log(`Could not check file size: ${err.message}`);
    }

    // Set a timeout to prevent hanging
    const timeout = setTimeout(() => {
      if (ffprobe) {
        ffprobe.kill('SIGTERM');
      }
      reject(new Error('FFprobe keyframe extraction timed out after 60 seconds'));
    }, 60000); // 60 second timeout should be plenty for packet inspection
    
    // Use FFprobe to extract packet information without decoding the video
    // This is MUCH faster than decoding each frame
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_packets',
      '-show_entries', 'packet=pts_time,dts_time,pos,size,flags',
      '-of', 'json',
      videoPath
    ];

    console.log(`Extracting keyframes with packet inspection: ${FFPROBE_PATH} ${args.join(' ')}`);
    
    const ffprobe = spawn(FFPROBE_PATH, args);
    let stdout = '';
    let stderr = '';
    
    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code !== 0) {
        return reject(
          new Error(`FFprobe process exited with code ${code}. Error: ${stderr}`)
        );
      }
      
      try {
        // Parse the JSON output
        const result = JSON.parse(stdout);
        
        // Check if packets exists and isn't empty
        if (!result.packets || !Array.isArray(result.packets) || result.packets.length === 0) {
          console.log('No packets found in FFprobe output, creating default keyframes');
          const defaultKeyframes = createDefaultKeyframes();
          return resolve(defaultKeyframes);
        }
        
        // Filter packets to get only keyframes (those with K flag)
        const keyframePackets = result.packets.filter(packet => 
          packet.flags && packet.flags.includes('K')
        );
        
        console.log(`Found ${keyframePackets.length} keyframe packets out of ${result.packets.length} total packets`);
        
        if (keyframePackets.length === 0) {
          console.log('No keyframe packets found, creating default keyframes');
          const defaultKeyframes = createDefaultKeyframes();
          return resolve(defaultKeyframes);
        }
        
        // Convert packets to keyframe objects
        const keyframes = keyframePackets.map((packet, index) => {
          // Use the most reliable timestamp available (pts_time or dts_time)
          const timestamp = packet.pts_time ? parseFloat(packet.pts_time) : 
                           (packet.dts_time ? parseFloat(packet.dts_time) : index * 5.0);
          
          return {
            index,
            timestamp,
            position: packet.pos ? parseInt(packet.pos) : index * 1000000,
            size: packet.size ? parseInt(packet.size) : 10000
          };
        });
        
        // Sort by timestamp to ensure they're in chronological order
        keyframes.sort((a, b) => a.timestamp - b.timestamp);
        
        // Filter out keyframes with duplicate or very close timestamps (within 0.1s)
        const uniqueKeyframes = keyframes.filter((kf, i, arr) => 
          i === 0 || kf.timestamp - arr[i-1].timestamp > 0.1
        );
        
        if (uniqueKeyframes.length < keyframes.length) {
          console.log(`Filtered out ${keyframes.length - uniqueKeyframes.length} duplicate keyframes`);
        }
        
        // Calculate duration between keyframes
        for (let i = 0; i < uniqueKeyframes.length - 1; i++) {
          uniqueKeyframes[i].duration = uniqueKeyframes[i + 1].timestamp - uniqueKeyframes[i].timestamp;
        }
        
        // Set duration for the last keyframe (use average duration as estimate)
        if (uniqueKeyframes.length > 1) {
          const avgDuration = uniqueKeyframes.slice(0, -1).reduce((sum, kf) => sum + kf.duration, 0) / (uniqueKeyframes.length - 1);
          uniqueKeyframes[uniqueKeyframes.length - 1].duration = avgDuration;
        } else if (uniqueKeyframes.length === 1) {
          // Just one keyframe, use a default duration
          uniqueKeyframes[0].duration = 5.0;
        }
        
        // Generate intermediate keyframes if needed for very sparse keyframes
        const finalKeyframes = generateIntermediateKeyframesIfNeeded(uniqueKeyframes);
        
        console.log(`Successfully extracted ${finalKeyframes.length} keyframes using FFprobe packet inspection`);
        resolve(finalKeyframes);
      } catch (error) {
        reject(new Error(`Failed to parse FFprobe output: ${error.message}`));
      }
    });
    
    ffprobe.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Create default keyframes for cases where extraction fails
 * @returns {Array<Object>} - Array of default keyframe objects
 */
function createDefaultKeyframes() {
  const defaultKeyframes = [];
  // Create keyframes at 5-second intervals for a 2-minute video
  for (let i = 0; i < 24; i++) {
    defaultKeyframes.push({
      index: i,
      timestamp: i * 5.0,
      position: i * 1000000,
      size: 10000,
      duration: 5.0,
      isGenerated: true
    });
  }
  return defaultKeyframes;
}

/**
 * Generate intermediate keyframes for sparse keyframe sets
 * @param {Array<Object>} keyframes - Original keyframes
 * @returns {Array<Object>} - Keyframes with intermediates added if needed
 */
function generateIntermediateKeyframesIfNeeded(keyframes) {
  // Don't process if we have enough keyframes already
  if (keyframes.length >= 10 || keyframes.length <= 1) {
    return keyframes;
  }
  
  console.log(`Only ${keyframes.length} keyframes found, generating intermediate frames...`);
  
  const supplementaryKeyframes = [];
  
  // Generate intermediate keyframes between actual keyframes
  for (let i = 0; i < keyframes.length - 1; i++) {
    const current = keyframes[i];
    const next = keyframes[i + 1];
    const gap = next.timestamp - current.timestamp;
    
    // If gap is more than 10 seconds, add intermediate keyframes
    if (gap > 10) {
      const numIntermediate = Math.floor(gap / 5); // One every 5 seconds
      for (let j = 1; j < numIntermediate; j++) {
        const intermediateTime = current.timestamp + (j * (gap / numIntermediate));
        supplementaryKeyframes.push({
          index: -1, // Will be fixed after merging
          timestamp: intermediateTime,
          position: Math.round(current.position + (j * (next.position - current.position) / numIntermediate)),
          size: 10000,
          isGenerated: true
        });
      }
    }
  }
  
  // Merge and sort keyframes
  const mergedKeyframes = [...keyframes, ...supplementaryKeyframes].sort((a, b) => a.timestamp - b.timestamp);
  
  // Fix indices
  const finalKeyframes = mergedKeyframes.map((kf, idx) => ({
    ...kf,
    index: idx
  }));
  
  console.log(`Added ${supplementaryKeyframes.length} intermediate keyframes, total now: ${finalKeyframes.length}`);
  return finalKeyframes;
}

/**
 * Legacy fallback method using FFprobe frame-based extraction
 * This is slower but may work for some files if packet inspection fails
 * @param {string} videoPath - Path to the source video
 * @returns {Promise<Array<Object>>} - Array of keyframe objects with timestamps
 */
async function extractKeyframesWithFrameInspection(videoPath) {
  return new Promise((resolve, reject) => {
    console.log('Falling back to FFprobe frame inspection for keyframe extraction');
    
    // Set a timeout to prevent hanging
    const timeout = setTimeout(() => {
      if (ffprobe) {
        ffprobe.kill('SIGTERM');
      }
      reject(new Error('FFprobe keyframe extraction timed out after 120 seconds'));
    }, 120000); // 2 minute timeout

    // FFprobe command to extract keyframe info using frame inspection
    const args = [
      '-v', 'error',
      '-skip_frame', 'nokey',
      '-select_streams', 'v:0',
      '-show_entries', 'frame=pkt_pts_time,pkt_dts_time,best_effort_timestamp_time,pkt_pos,pkt_size',
      '-of', 'json',
      videoPath
    ];

    console.log(`Extracting keyframes with FFprobe frame inspection: ${FFPROBE_PATH} ${args.join(' ')}`);
    
    const ffprobe = spawn(FFPROBE_PATH, args);
    let output = '';
    let errorOutput = '';

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ffprobe.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code !== 0) {
        return reject(
          new Error(`FFprobe process exited with code ${code}. Error: ${errorOutput}`)
        );
      }

      try {
        const result = JSON.parse(output);
        
        // Check if frames exists and isn't empty
        if (!result.frames || !Array.isArray(result.frames) || result.frames.length === 0) {
          console.log('No keyframes found in FFprobe frame output, creating default keyframes');
          return resolve(createDefaultKeyframes());
        }
        
        const keyframes = result.frames.map((frame, index) => {
          // Use the most reliable timestamp available in order of preference
          const timestamp = frame.best_effort_timestamp_time || frame.pkt_pts_time || frame.pkt_dts_time;
          return {
            index,
            timestamp: parseFloat(timestamp),
            position: parseInt(frame.pkt_pos) || 0,
            size: parseInt(frame.pkt_size) || 0
          };
        });

        // Sort by timestamp to ensure they're in chronological order
        keyframes.sort((a, b) => a.timestamp - b.timestamp);
        
        // Calculate duration between keyframes
        for (let i = 0; i < keyframes.length - 1; i++) {
          keyframes[i].duration = keyframes[i + 1].timestamp - keyframes[i].timestamp;
        }
        
        // Set duration for the last keyframe (use average duration as estimate)
        if (keyframes.length > 1) {
          const avgDuration = keyframes.slice(0, -1).reduce((sum, kf) => sum + kf.duration, 0) / (keyframes.length - 1);
          keyframes[keyframes.length - 1].duration = avgDuration;
        } else if (keyframes.length === 1) {
          // Just one keyframe, use a default duration
          keyframes[0].duration = 5.0;
        }

        resolve(keyframes);
      } catch (error) {
        reject(new Error(`Failed to parse FFprobe frame output: ${error.message}`));
      }
    });

    ffprobe.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Generate a keyframe reference file for a video
 * @param {string} videoId - Video identifier
 * @param {string} videoPath - Path to the source video
 * @returns {Promise<string>} - Path to the generated keyframe reference file
 */
async function generateKeyframeReference(videoId, videoPath) {
  // First create the root output directory for this media if it doesn't exist
  const mediaDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId));
  await ensureDir(mediaDir);
  
  const keyframeReferencePath = path.join(mediaDir, 'keyframe_reference.json');
  
  // Check if a generation is already in progress for this videoId
  if (inProgressExtractions.has(videoId)) {
    console.log(`Keyframe extraction already in progress for ${videoId}, waiting for completion...`);
    try {
      // Wait for the existing extraction to complete
      await inProgressExtractions.get(videoId);
      console.log(`Existing keyframe extraction for ${videoId} completed, returning reference path`);
      return keyframeReferencePath;
    } catch (err) {
      console.error(`Error waiting for existing keyframe extraction: ${err.message}`);
      // Continue to try again
    }
  }
  
  // Use a more robust check for file existence and validity
  try {
    const stats = await fsPromises.stat(keyframeReferencePath);
    if (stats.size > 0) {
      try {
        // Try to parse the existing file to make sure it's valid
        const data = await fsPromises.readFile(keyframeReferencePath, 'utf8');
        const existingReference = JSON.parse(data);
        
        // Verify the file has the expected structure and data
        if (existingReference && 
            existingReference.keyframes && 
            Array.isArray(existingReference.keyframes) && 
            existingReference.keyframes.length > 0) {
          console.log(`Using existing keyframe reference with ${existingReference.keyframes.length} keyframes`);
          return keyframeReferencePath;
        }
      } catch (parseErr) {
        console.log(`Existing keyframe reference file is invalid, regenerating: ${parseErr.message}`);
      }
    }
  } catch (err) {
    // File doesn't exist or can't be accessed, generate it
    console.log(`Keyframe reference file not found: ${err.message}`);
  }
  
  // Create a promise for this extraction and register it
  const extractionPromise = (async () => {
    try {
      console.log(`Generating keyframe reference file for ${videoId} at ${keyframeReferencePath}`);
      
      let keyframes;
      try {
        // Try the new packet-based extraction first (much faster)
        keyframes = await extractKeyframes(videoPath);
      } catch (primaryError) {
        console.error(`Error with packet-based extraction: ${primaryError.message}`);
        console.log(`Falling back to frame inspection method...`);
        
        // If packet inspection fails, fall back to frame inspection
        keyframes = await extractKeyframesWithFrameInspection(videoPath);
      }
      
      console.log(`Extracted ${keyframes.length} keyframes from ${videoPath}`);
      
      // Get media info for additional context
      const mediaInfo = await getMediaInfo(videoPath);
      const fps = getVideoFps(mediaInfo);
      
      // Create the reference object
      const reference = {
        videoId,
        sourceFile: videoPath,
        fps,
        generatedAt: new Date().toISOString(),
        keyframeCount: keyframes.length,
        keyframes
      };
      
      // Write the reference file
      await fsPromises.writeFile(keyframeReferencePath, JSON.stringify(reference, null, 2));
      console.log(`Keyframe reference file generated at ${keyframeReferencePath}`);
      
      return keyframeReferencePath;
    } catch (err) {
      console.error(`Error generating keyframe reference: ${err.message}`);
      throw err;
    } finally {
      // Always clean up the in-progress tracking, even if there was an error
      inProgressExtractions.delete(videoId);
    }
  })();
  
  // Register this extraction
  inProgressExtractions.set(videoId, extractionPromise);
  
  // Wait for extraction to complete and return the result
  return await extractionPromise;
}

/**
 * Read the keyframe reference file for a video
 * @param {string} videoId - Video identifier
 * @returns {Promise<Object>} - The keyframe reference object
 */
async function getKeyframeReference(videoId) {
  const keyframeReferencePath = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), 'keyframe_reference.json');
  
  // If there's an extraction in progress, wait for it
  if (inProgressExtractions.has(videoId)) {
    try {
      await inProgressExtractions.get(videoId);
    } catch (err) {
      console.error(`Error waiting for in-progress extraction: ${err.message}`);
      // Continue to try reading the file anyway
    }
  }
  
  try {
    const data = await fsPromises.readFile(keyframeReferencePath, 'utf8');
    const reference = JSON.parse(data);
    
    // Basic validation
    if (!reference.keyframes || !Array.isArray(reference.keyframes) || reference.keyframes.length === 0) {
      throw new Error(`Invalid keyframe reference format for ${videoId}`);
    }
    
    return reference;
  } catch (err) {
    throw new Error(`Keyframe reference file not found or invalid for ${videoId}: ${err.message}`);
  }
}

/**
 * Generate a keyframe command argument for FFmpeg using the reference file
 * Note: This returns the full FFmpeg -force_key_frames option string, not a file path
 * 
 * @param {string} videoId - Video identifier
 * @returns {Promise<string>} - FFmpeg force_key_frames argument (e.g., "expr:gte(t,5)")
 */
async function generateKeyframeTimestampsFileForFfmpeg(videoId) {
  try {
    // Get the keyframe reference
    const reference = await getKeyframeReference(videoId);
    
    // For stability, we'll use the expr format with keyframe times from reference
    // This is more reliable than file-based approach
    
    if (!reference.keyframes || reference.keyframes.length === 0) {
      // Fallback to standard expression if no keyframes
      console.log('No keyframes found in reference, using standard 5-second expression');
      return 'expr:gte(t,n_forced*5)';
    }
    
    // Generate an expression that forces keyframes at specific times
    // We'll use "expr:eq(t,10)+eq(t,15)+eq(t,20)" format for specific timestamps
    // This works for videos up to reasonable length without command line limits
    
    // Get first 40 keyframes only to keep command size reasonable
    // The rest will still follow GOP size pattern established by these
    const keyframeSample = reference.keyframes.slice(0, 40);
    
    const timeExpressions = keyframeSample.map(kf => {
      // Ensure timestamp is valid and at least 0.1s (avoid forcing at 0)
      const ts = Math.max(kf.timestamp, 0.1).toFixed(3);
      return `eq(t,${ts})`;
    });
    
    // Join with + operator (OR in FFmpeg expr)
    const forceKeyframesExpr = `expr:${timeExpressions.join('+')}`;
    
    console.log(`Generated keyframe expression with ${timeExpressions.length} timestamps`);
    return forceKeyframesExpr;
    
  } catch (err) {
    console.error(`Error generating keyframe expression: ${err.message}`);
    // Fallback to standard 5-second keyframes
    return 'expr:gte(t,n_forced*5)';
  }
}

/**
 * Find the nearest keyframe timestamp for seeking
 * @param {string} videoId - Video identifier
 * @param {number} targetTimestamp - Target seek timestamp
 * @returns {Promise<number>} - Nearest keyframe timestamp suitable for seeking
 */
async function findNearestReferenceKeyframe(videoId, targetTimestamp) {
  try {
    const reference = await getKeyframeReference(videoId);
    
    // Find the nearest keyframe before or at the target timestamp
    const keyframe = reference.keyframes
      .filter(kf => kf.timestamp <= targetTimestamp)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    
    if (keyframe) {
      return keyframe.timestamp;
    }
    
    // If no earlier keyframe found, return the first keyframe
    if (reference.keyframes.length > 0) {
      return reference.keyframes[0].timestamp;
    }
  } catch (err) {
    console.error(`Error finding nearest keyframe: ${err.message}`);
    // Fall back to the target timestamp if we can't get keyframe reference
  }
  
  // Fallback: return the target timestamp if no keyframes found or on error
  return targetTimestamp;
}

/**
 * Generate an accurate HLS variant playlist using keyframe reference
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @param {Object} options - Additional options 
 * @returns {Promise<string>} - Path to the generated playlist
 */
async function generateAccurateVariantPlaylist(videoId, variantLabel, options = {}) {
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variantLabel);
  await ensureDir(outputDir);
  
  const playlistPath = path.join(outputDir, 'playlist.m3u8');
  
  // Get segment boundaries using the new explicit offsets model
  const segments = await getSegmentBoundaries(videoId, findVideoFile(videoId));
  
  try {
    // Check if playlist already exists and is valid
    try {
      const stats = await fsPromises.stat(playlistPath);
      if (stats.size > 0) {
        const content = await fsPromises.readFile(playlistPath, 'utf8');
        if (content.includes('#EXTM3U') && content.includes('#EXT-X-ENDLIST')) {
          console.log(`Using existing variant playlist at ${playlistPath}`);
          return playlistPath;
        }
      }
    } catch (err) {
      // File doesn't exist or isn't valid, continue to generate it
    }
    
    // Get the keyframe reference
    const reference = await getKeyframeReference(videoId);
    
    // Make sure we have keyframes
    if (!reference.keyframes || reference.keyframes.length === 0) {
      throw new Error(`No keyframes found in reference for ${videoId}`);
    }
    
    // Calculate max duration for target duration (rounded up)
    const maxDuration = Math.ceil(
      Math.max(...reference.keyframes.map(kf => kf.duration || 0))
    );
    
    // Create playlist header
    let playlist = '#EXTM3U\n' +
                  '#EXT-X-VERSION:3\n' +
                  `#EXT-X-TARGETDURATION:${maxDuration}\n` +
                  '#EXT-X-MEDIA-SEQUENCE:0\n' +
                  '#EXT-X-PLAYLIST-TYPE:VOD\n';
    
    // Get the appropriate file extension for this variant based on codec
    let extension = 'ts'; // Default extension
    let isHevcFmp4 = false; // Flag to check if we're dealing with HEVC/fMP4
    try {
      extension = await getSegmentExtensionForVariant(videoId, variantLabel);
      
      // Check if this is HEVC (using m4s extension indicates we're using fMP4)
      isHevcFmp4 = (extension === 'm4s');
      
      console.log(`Using segment extension ${extension} for variant ${variantLabel} based on codec reference (isHevcFmp4: ${isHevcFmp4})`);
    } catch (err) {
      console.warn(`Could not determine extension for ${videoId}/${variantLabel}, using default .ts: ${err.message}`);
    }
    
    // For HEVC content using fMP4, we need to include the initialization segment
    if (isHevcFmp4) {
      playlist += '#EXT-X-MAP:URI="init.mp4"\n';
    }
    
    // Use precomputed segment boundaries for explicit offsets
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentFilename = `${i.toString().padStart(3, '0')}.${extension}`;
      // Use actual segment duration from precomputed boundaries
      playlist += `#EXTINF:${segment.durationSeconds.toFixed(6)},\n`;
      playlist += `${segmentFilename}?runtimeTicks=${segment.runtimeTicks}&actualSegmentLengthTicks=${segment.actualSegmentLengthTicks}\n`;
    }
    
    // Add end marker
    playlist += '#EXT-X-ENDLIST\n';
    
    // Write the playlist file
    await fsPromises.writeFile(playlistPath, playlist);
    console.log(`Generated accurate variant playlist at ${playlistPath} with ${reference.keyframes.length} segments`);
    
    return playlistPath;
  } catch (err) {
    console.error(`Error generating accurate variant playlist: ${err.message}`);
    
    // Fallback to a simplified playlist with default durations
    console.log(`Falling back to simplified playlist generation`);
    
    // Create a fallback playlist with 5-second segments
    let fallbackPlaylist = '#EXTM3U\n' +
                          '#EXT-X-VERSION:3\n' +
                          '#EXT-X-TARGETDURATION:5\n' +
                          '#EXT-X-MEDIA-SEQUENCE:0\n' +
                          '#EXT-X-PLAYLIST-TYPE:VOD\n';
    
    // Get the appropriate file extension for this variant based on codec
    let fallbackExtension = 'ts'; // Default extension
    let isFallbackHevcFmp4 = false; // Flag to check if we're dealing with HEVC/fMP4
    try {
      fallbackExtension = await getSegmentExtensionForVariant(videoId, variantLabel);
      
      // Check if this is HEVC (using m4s extension indicates we're using fMP4)
      isFallbackHevcFmp4 = (fallbackExtension === 'm4s');
      
      console.log(`Using segment extension ${fallbackExtension} for fallback playlist of variant ${variantLabel} (isFallbackHevcFmp4: ${isFallbackHevcFmp4})`);
    } catch (err) {
      console.warn(`Could not determine extension for fallback playlist of ${videoId}/${variantLabel}, using default .ts: ${err.message}`);
    }
    
    // For HEVC content using fMP4, we need to include the initialization segment
    if (isFallbackHevcFmp4) {
      fallbackPlaylist += '#EXT-X-MAP:URI="init.mp4"\n';
    }
    
    // Generate 24 segments (2 minutes total)
    for (let i = 0; i < 24; i++) {
      const segmentFilename = `${i.toString().padStart(3, '0')}.${fallbackExtension}`;
      fallbackPlaylist += `#EXTINF:5.000000,\n`;
      fallbackPlaylist += `${segmentFilename}\n`;
    }
    
    fallbackPlaylist += '#EXT-X-ENDLIST\n';
    
    await fsPromises.writeFile(playlistPath, fallbackPlaylist);
    console.log(`Generated fallback playlist at ${playlistPath} with 24 segments`);
    
    return playlistPath;
  }
}

module.exports = {
  extractKeyframes,
  generateKeyframeReference,
  getKeyframeReference,
  generateKeyframeTimestampsFileForFfmpeg, // Renamed function
  findNearestReferenceKeyframe,
  generateAccurateVariantPlaylist
};
