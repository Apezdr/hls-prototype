// services/requestManager/helpers.js
const path = require('path');
const fs = require('fs').promises;
const { 
  segmentExists, 
  trackViewerActivity,
  stopActiveTranscoding
} = require('../segmentManager');
const { safeFilename } = require('../../utils/files');
const { HLS_OUTPUT_DIR } = require('../../config/config');
const { segmentNumberToFilename } = require('../../utils/timestampUtils');

// Reference to the main module for accessing shared state
// This will be set by the main module to avoid circular dependencies
let requestManagerRef;

/**
 * Initialize this module with a reference to the main requestManager module
 * @param {object} requestManager - The main requestManager module
 */
function init(requestManager) {
  requestManagerRef = requestManager;
}

/**
 * Compute the segment file path based on variant type and segment number
 * @param {string} videoId - Video identifier
 * @param {object} variant - Variant information
 * @param {number} segment - Segment number
 * @returns {Promise<string>} - Path to the segment file
 */
async function computeSegmentPath(videoId, variant, segment) {
  const base = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variant.label);
  
  // Check if this is an audio variant
  if (variant.trackIndex != null) {
    // Audio variant path
    return path.join(base, segmentNumberToFilename(segment));
  } else {
    // Video variant path - need to determine file extension based on codec
    let extension = 'ts'; // Default extension
    try {
      const { getSegmentExtensionForVariant } = require('../../utils/codecReferenceUtils');
      extension = await getSegmentExtensionForVariant(videoId, variant.label);
    } catch (err) {
      console.warn(`Could not determine extension for ${videoId}/${variant.label}, using default .ts: ${err.message}`);
    }
    
    const segmentFile = `${segment.toString().padStart(3, '0')}.${extension}`;
    return path.join(base, segmentFile);
  }
}

/**
 * Check if segment exists and serve it if it does
 * @param {string} clientId - Client identifier
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @param {number} segment - Segment number
 * @param {string} segmentPath - Path to the segment file
 * @param {boolean} isAudio - Whether this is an audio segment
 * @returns {Promise<boolean>} - True if segment exists and is ready to serve
 */
async function serveIfExists(clientId, videoId, variantLabel, segment, segmentPath, isAudio) {
  const exists = await segmentExists(segmentPath);
  if (!exists) return false;
  
  console.log(`${isAudio ? 'Audio segment' : 'Segment'} ${segment} for ${videoId}/${variantLabel} already exists, serving without transcoding`);
  requestManagerRef.updateClientSession(clientId, videoId, variantLabel, segment);
  trackViewerActivity(videoId, variantLabel, segment);
  return true;
}

/**
 * Determine if we should restart an existing transcoding task
 * @param {object} params - Parameters
 * @param {string} params.clientId - Client identifier
 * @param {string} params.variantTaskKey - Task key in the format videoId_variantLabel
 * @param {object} params.clientSession - Client session data
 * @param {object} params.activeTask - The current active task or null if none
 * @param {object} params.analysis - Request analysis result
 * @param {number} params.segment - Segment number
 * @param {boolean} params.isAudio - Whether this is an audio segment
 * @returns {Promise<boolean>} - True if we should restart transcoding
 */
async function shouldRestartTask({ clientId, variantTaskKey, clientSession, activeTask, analysis, segment, isAudio }) {
  // If no active task, we definitely need to start
  if (!activeTask) return true;
  
  // Check if this client already owns this task
  const isClientOwner = activeTask && activeTask.clientId === clientId;
  
  // If it's a user-initiated seek, we're much more aggressive about restarting
  if (analysis.type === 'user_seek') {
    console.log(`User-initiated seek detected for ${clientId} to ${isAudio ? 'audio ' : ''}segment ${segment}, prioritizing immediate restart`);
    return true;
  } 
  
  // If client owns the task, give them more control over restarting it
  if (isClientOwner) {
    // Be more permissive for the owner even for normal player behavior
    const distance = Math.abs(segment - activeTask.segmentStart);
    if (distance > requestManagerRef.NORMAL_PLAYBACK_RANGE) {
      console.log(`Client ${clientId} owns this ${isAudio ? 'audio ' : ''}transcoding task and requested a different range, allowing restart`);
      return true;
    }
  }
  
  // Check our general decision logic which considers segment ranges on disk
  const [videoId, variantLabel] = variantTaskKey.split('_');
  const standardDecision = await requestManagerRef.shouldStartNewTranscoding(
    clientId, 
    clientSession, 
    videoId, 
    variantLabel, 
    segment, 
    analysis
  );
  
  if (standardDecision) return true;
  
  // For user-initiated seeks or large jumps, consider restarting
  const existingDistance = Math.abs(segment - (activeTask.segmentStart || 0));
  if (existingDistance > requestManagerRef.NORMAL_PLAYBACK_RANGE * 2) {
    // Only force restart in specific cases to prevent unnecessary thrashing
    if (analysis.type === 'user_seek' || !analysis.isNormalPlayerBehavior) {
      console.log(`Distance to current process (${existingDistance} segments) exceeds threshold, forcing restart (user-initiated seek)`);
      return true;
    } else if (activeTask.latestSegment !== undefined && segment > activeTask.latestSegment + 10) {
      // If this is a buffer request for ahead of current transcoding progress (by a significant amount)
      console.log(`Request for future segment ${segment} is far ahead of current transcoding (latest: ${activeTask.latestSegment}), allowing restart`);
      return true;
    } else {
      console.log(`Request for segment ${segment} is outside normal range but appears to be player buffering behavior, not restarting`);
    }
  }
  
  // If task exists but has been marked for restart, force a restart
  if (activeTask.needsRestart) {
    console.log(`${isAudio ? 'Audio' : 'Video'} task for ${variantTaskKey} was marked for restart due to previous issues`);
    // Clear the flag
    activeTask.needsRestart = false;
    return true;
  }
  
  return false;
}

/**
 * Restart an existing task or enqueue a new one based on resource availability
 * @param {object} params - Parameters
 * @param {string} params.clientId - Client identifier
 * @param {string} params.videoId - Video identifier
 * @param {object} params.variant - Variant information
 * @param {object} params.analysis - Request analysis result
 * @param {number} params.segment - Segment number
 * @param {object} params.clientSession - Client session data
 * @param {boolean} params.isAudio - Whether this is an audio segment
 */
async function restartOrEnqueueTask({ clientId, videoId, variant, analysis, segment, clientSession, isAudio }) {
  const variantLabel = variant.label;
  const variantTaskKey = `${videoId}_${variantLabel}`;
  
  console.log(`Starting new ${isAudio ? 'audio ' : ''}transcoding for ${variantTaskKey} at segment ${segment} (type: ${analysis.type})`);
  
  // Make a copy of the existing task in case we need to restore it
  const existingTask = requestManagerRef.activeTranscodingTasks.get(variantTaskKey);
  
  // Check transcoding limits BEFORE stopping the current task
  const canStart = await requestManagerRef.enforceTranscodingLimits(clientId, videoId, variantLabel);
  if (!canStart) {
    console.warn(`Cannot start new ${isAudio ? 'audio ' : ''}transcoding for ${clientId} due to resource limits, will use existing processes if available`);
    
    // Update the existing task if we have one, but don't stop it
    if (existingTask) {
      console.log(`Keeping existing ${isAudio ? 'audio ' : ''}transcoding task for ${variantTaskKey}`);
      existingTask.lastActivity = Date.now();
      
      // Add this client to the set of clients using this task
      if (existingTask.clientIds && !existingTask.clientIds.has(clientId)) {
        existingTask.clientIds.add(clientId);
      }
      
      // If this client isn't the owner but the task needs a restart, transfer ownership
      if (existingTask.needsRestart && existingTask.clientId !== clientId) {
        console.log(`Transferring ownership of ${isAudio ? 'audio ' : ''}task ${variantTaskKey} to client ${clientId}`);
        existingTask.clientId = clientId;
      }
    } else {
      // Create a new task entry even if we can't start the actual process yet
      // This prevents multiple restart attempts for the same variant
      console.log(`Creating placeholder ${isAudio ? 'audio ' : ''}transcoding task for ${variantTaskKey}`);
      
      // Calculate priority - audio gets lower base priority but multi-channel gets a boost
      let priority = requestManagerRef.VARIANT_PRIORITY[variantLabel] || 1;
      if (isAudio && variant.channels > 2) {
        priority = 2; // Higher priority for multi-channel audio
      }
      
      requestManagerRef.activeTranscodingTasks.set(variantTaskKey, {
        clientId: clientId,
        segmentStart: segment,
        latestSegment: segment - 1,
        lastActivity: Date.now(),
        priority: priority,
        clientIds: new Set([clientId]),
        pendingStart: true, // Mark as pending actual process start
        isAudio: isAudio,
        channels: isAudio ? variant.channels : undefined,
        analysisType: analysis.type
      });
    }
  } else {
    // Only stop existing transcoding if we're allowed to start a new one
    try {
      await stopActiveTranscoding(videoId, variantLabel);
    } catch (err) {
      console.warn(`Error stopping existing ${isAudio ? 'audio ' : ''}transcoding for ${variantTaskKey}:`, err);
    }
    
    // Calculate priority - audio gets lower base priority but multi-channel gets a boost
    let priority = requestManagerRef.VARIANT_PRIORITY[variantLabel] || 1;
    if (isAudio && variant.channels > 2) {
      priority = 2; // Higher priority for multi-channel audio
    }
    
    // Record this transcoding task - do this BEFORE deleting the old one
    requestManagerRef.activeTranscodingTasks.set(variantTaskKey, {
      clientId: clientId,
      segmentStart: segment,
      latestSegment: segment - 1,
      lastActivity: Date.now(),
      priority: priority,
      clientIds: new Set([clientId]), // Track all clients using this transcoding
      isAudio: isAudio,
      channels: isAudio ? variant.channels : undefined,
      clientSpecific: true, // Flag this as a client-specific process
      analysisType: analysis.type // Store what triggered this transcoding
    });
  
    // Update client session
    if (clientSession.variants[variantLabel]) {
      clientSession.variants[variantLabel].transcodingPosition = segment;
      clientSession.variants[variantLabel].lastSeekTime = Date.now();
    }
  }
}

/**
 * Update existing task with current activity
 * @param {object} activeTask - The active transcoding task
 * @param {string} clientId - Client identifier
 * @param {number} segment - Segment number
 * @param {boolean} isAudio - Whether this is an audio segment
 * @param {string} variantTaskKey - Task key
 */
function touchExistingTask(activeTask, clientId, segment, isAudio, variantTaskKey) {
  if (!activeTask) return;
  
  // Update the activity timestamp for this task
  activeTask.lastActivity = Date.now();
  
  // Add this client to the set of clients using this task
  if (activeTask.clientIds && !activeTask.clientIds.has(clientId)) {
    activeTask.clientIds.add(clientId);
    console.log(`Client ${clientId} added to existing ${isAudio ? 'audio ' : ''}transcoding task ${variantTaskKey}`);
  }
  
  // If this segment is further along than our latest tracked segment,
  // update our understanding of the transcoding progress
  if (segment > activeTask.latestSegment) {
    activeTask.latestSegment = segment;
  }
  
  console.log(`Using existing ${isAudio ? 'audio ' : ''}transcoding for ${variantTaskKey}, progress: segments ${activeTask.segmentStart} to ${activeTask.latestSegment}`);
}

/**
 * Ensure segment is available, preventing duplicate concurrent calls
 * @param {object} params - Parameters
 * @param {string} params.videoId - Video identifier
 * @param {object} params.variant - Variant information
 * @param {string} params.videoPath - Path to source video
 * @param {number} params.segment - Segment number
 * @param {Function} params.ensureFn - Function to call to ensure segment
 * @param {string} params.variantTaskKey - Task key
 * @returns {Promise<string>} - Path to the segment file when it's ready
 */
async function ensureSegmentUnique({ videoId, variant, videoPath, segment, ensureFn, variantTaskKey }) {
  const key = `${variantTaskKey}_${segment}`;
  
  if (!requestManagerRef.pendingSegmentEnsures.has(key)) {
    const ensurePromise = ensureFn(videoId, variant, videoPath, segment)
      .then(async resultPath => {
        // Update our tracking of generated segments after successful creation
        const taskAfterGeneration = requestManagerRef.activeTranscodingTasks.get(variantTaskKey);
        if (taskAfterGeneration) {
          // Record this segment in our generated segments tracking
          requestManagerRef.updateGeneratedSegments(taskAfterGeneration, segment);
          
          // Additional verification: wait for next segment to start generating before serving
          // this one, if it's not the last segment in the video
          if (!taskAfterGeneration.finished && segment < taskAfterGeneration.latestSegment) {
            // Check for existence of next segment (additional validation)
            try {
              const nextSegPath = await computeSegmentPath(videoId, variant, segment + 1);
              console.log(`Checking for next segment at ${nextSegPath} to verify segment ${segment} is complete`);
              await fs.access(nextSegPath);
              console.log(`Verified segment ${segment} via next segment existence`);
            } catch (err) {
              // Next segment doesn't exist yet, but that's ok if this is the latest
              console.log(`Next segment ${segment + 1} not found yet, but current segment appears complete`);
            }
          }
        }
        return resultPath;
      })
      .catch(error => {
        const isAudio = !!variant.trackIndex;
        if (error.message.includes('Timeout waiting for segment')) {
          // If we time out waiting for a segment, mark for restart next time
          console.log(`Timeout waiting for ${isAudio ? 'audio ' : ''}segment ${segment}, marking for restart on next request`);
          const existingTask = requestManagerRef.activeTranscodingTasks.get(variantTaskKey);
          if (existingTask) {
            existingTask.needsRestart = true;
          }
        }
        
        console.error(`Error ensuring ${isAudio ? 'audio ' : ''}segment ${segment} for ${videoId}/${variant.label}:`, error);
        throw error;
      })
      .finally(() => {
        // Always clean up the pending map
        requestManagerRef.pendingSegmentEnsures.delete(key);
      });
      
    requestManagerRef.pendingSegmentEnsures.set(key, ensurePromise);
  }
  
  // Return the pending promise (either one we just created or an existing one)
  return requestManagerRef.pendingSegmentEnsures.get(key);
}

module.exports = {
  init,
  computeSegmentPath,
  serveIfExists,
  shouldRestartTask,
  restartOrEnqueueTask,
  touchExistingTask,
  ensureSegmentUnique
};
