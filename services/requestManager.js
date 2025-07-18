// services/requestManager.js
const path = require('path');
const fs = require('fs').promises;
const { 
  ensureSegment, 
  ensureAudioSegment, 
  segmentExists, 
  trackViewerActivity,
  stopActiveTranscoding
} = require('./segmentManager');
const { safeFilename } = require('../utils/files');
const { HLS_OUTPUT_DIR } = require('../config/config');
const { segmentNumberToFilename } = require('../utils/timestampUtils');

// Import helper functions
const helpers = require('./requestManager/helpers');

// Store client sessions and their request patterns
// key: clientId (IP + user agent hash)
// value: {
//   lastRequestTime: timestamp,
//   videoId: string,
//   variants: {
//     variantLabel: {
//       requestHistory: [{segment, timestamp}],
//       primaryPosition: number, // Estimated current playback position
//       transcodingPosition: number // Current segment being transcoded
//     }
//   }
// }
const clientSessions = new Map();

// Track active transcoding tasks by variant
// key: clientId_videoId_variantLabel
// value: {
//   clientId: string, // Client that initiated this transcoding
//   segmentStart: number,
//   latestSegment: number, // Current progress of transcoding
//   lastActivity: timestamp,
//   priority: number,
//   clientIds: Set<string>, // All clients using this transcoding task
//   generatedSegments: { // Tracks which segments are already generated
//     ranges: [{ start: number, end: number }], // Array of segment ranges that exist
//     lastVerifiedTime: number // When we last scanned the disk
//   }
// }
const activeTranscodingTasks = new Map();

// How frequently to rescan for existing segments (ms)
const SEGMENT_SCAN_INTERVAL = 60 * 1000; // 1 minute

// Configuration constants
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const REQUEST_HISTORY_SIZE = 30; // Number of requests to keep in history per variant
const NORMAL_PLAYBACK_RANGE = 20; // Segments considered within normal playback range (reduced from 40)
const SEEK_COOLDOWN = 2000; // Minimum ms between transcoding restarts (reduced from 10 seconds to 2 seconds)
const PRELOAD_THRESHOLD = 10; // Segments to preload ahead of playback
const VARIANT_SWITCH_TIMEOUT = 20 * 1000; // Time to wait before stopping abandoned variant transcoding (increased from 5 to 20 seconds - at least 3x segment duration)
const VARIANT_PRIORITY = { // Higher number = higher priority
  '4k': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1
};
// Transcoding process "momentum" - longer running processes are harder to stop
const TRANSCODING_MIN_SEGMENTS = 5; // Minimum segments to produce before considering a restart (reduced from 10)
const TRANSCODING_MOMENTUM_FACTOR = 0.3; // How much to increase restart threshold per segment transcoded (reduced from 0.5)

// Maximum number of concurrent transcoding processes allowed system-wide
const MAX_CONCURRENT_TRANSCODINGS = parseInt(process.env.MAX_CONCURRENT_TRANSCODINGS) || 8;
// Maximum number of transcodings per client (prevents client from using all system resources)
const MAX_TRANSCODINGS_PER_CLIENT = parseInt(process.env.MAX_TRANSCODINGS_PER_CLIENT) || 3;

// Clean up stale sessions periodically
setInterval(cleanupStaleSessions, 60 * 1000);

// Map to track pending segment ensure operations to prevent duplicate work
const pendingSegmentEnsures = new Map();

/**
 * Create a unique client ID from request information
 * @param {object} req - Express request object
 * @returns {string} - Unique client identifier
 */
function getClientId(req) {
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'unknown';
  // Simple hash function for combining ip and user agent
  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(31, h) + s.charCodeAt(i) | 0;
    }
    return h.toString(16);
  };
  return `${ip}_${hash(userAgent)}`;
}

/**
 * Clean up inactive client sessions
 */
function cleanupStaleSessions() {
  const now = Date.now();
  const staleClientIds = [];
  
  for (const [clientId, session] of clientSessions.entries()) {
    if (now - session.lastRequestTime > SESSION_TIMEOUT) {
      staleClientIds.push(clientId);
    }
  }
  
  for (const clientId of staleClientIds) {
    console.log(`Cleaning up stale session for client ${clientId}`);
    // Clean up any transcoding tasks associated with this client
    const session = clientSessions.get(clientId);
    if (session) {
      // Check each task owned by this client
      for (const [taskKey, task] of activeTranscodingTasks.entries()) {
        if (task.clientId === clientId) {
          // Check if other clients are using this task
          const hasOtherClients = task.clientIds && 
            task.clientIds.size > 1 && 
            Array.from(task.clientIds).some(id => id !== clientId);
          
          if (hasOtherClients) {
            // Transfer ownership to another client rather than stopping
            console.log(`Transferring ownership of ${taskKey} from stale client ${clientId} to another active client`);
            
            // Find another client to transfer ownership to
            const newOwner = Array.from(task.clientIds).find(id => id !== clientId);
            if (newOwner) {
              task.clientId = newOwner;
              console.log(`Task ${taskKey} ownership transferred to client ${newOwner}`);
              
              // Remove the stale client from the client set
              task.clientIds.delete(clientId);
            }
          } else {
            // No other clients using this task, safe to stop
            console.log(`Stopping transcoding task ${taskKey} owned by stale client ${clientId}`);
            const [videoId, variantLabel] = taskKey.split('_');
            stopActiveTranscoding(videoId, variantLabel)
              .catch(err => console.error(`Error stopping transcoding for ${taskKey}:`, err));
            activeTranscodingTasks.delete(taskKey);
          }
        } else if (task.clientIds && task.clientIds.has(clientId)) {
          // Client is using but not owning this task, just remove from clientIds
          console.log(`Removing stale client ${clientId} from users of task ${taskKey}`);
          task.clientIds.delete(clientId);
        }
      }
    }
    
    clientSessions.delete(clientId);
  }
  
  if (staleClientIds.length > 0) {
    console.log(`Cleaned up ${staleClientIds.length} stale client sessions`);
  }
}

/**
 * Analyze client request pattern to determine if this is normal playback, seeking, buffering, or initial loading
 * @param {array} requestHistory - Array of {segment, timestamp} objects
 * @param {number} currentSegment - Currently requested segment
 * @returns {object} - Analysis result {type, position, confidence}
 */
function analyzeRequestPattern(requestHistory, currentSegment) {
  // If this is one of the first few requests, it's probably initial loading
  if (requestHistory.length < 3) {
    return { 
      type: 'initial_loading', 
      position: currentSegment, 
      confidence: 1.0,
      isNormalPlayerBehavior: true  // Mark as normal behavior
    };
  }
  
  // Sort history by timestamp (newest first)
  const sortedHistory = [...requestHistory].sort((a, b) => b.timestamp - a.timestamp);
  
  // Get recent requests
  const recentRequests = sortedHistory.slice(0, 10); // Look at more history
  const lastPosition = recentRequests[0].segment;
  
  // Calculate segment distance
  const distance = Math.abs(currentSegment - lastPosition);
  
  // Analyze the general pattern over time
  let forwardJumps = 0;
  let backwardJumps = 0;
  let sequentialMoves = 0;
  let largeJumps = 0;
  
  for (let i = 0; i < recentRequests.length - 1; i++) {
    const current = recentRequests[i].segment;
    const prev = recentRequests[i + 1].segment;
    const gap = current - prev;
    
    if (gap > 0 && gap <= 3) sequentialMoves++;
    else if (gap > 3 && gap < NORMAL_PLAYBACK_RANGE) forwardJumps++;
    else if (gap < 0 && Math.abs(gap) < NORMAL_PLAYBACK_RANGE) backwardJumps++;
    else if (Math.abs(gap) >= NORMAL_PLAYBACK_RANGE) largeJumps++;
  }
  
  // Check for initial buffering pattern (requests at multiples of small ranges)
  // HLS clients often request segments in a pattern like 0,1,2,8,9,10,16,17,18...
  const isInitialBufferingPattern = requestHistory.length < 15 && 
    (forwardJumps > 0 || largeJumps > 0) && 
    sequentialMoves > 0;
  
  if (isInitialBufferingPattern) {
    return {
      type: 'initial_buffering',
      position: currentSegment,
      distance: distance,
      confidence: 0.85,
      isNormalPlayerBehavior: true
    };
  }
  
  // If we've detected many large jumps, this might be a player that prefetches
  // segments far ahead (common in some HLS implementations)
  const isPrefetchingPattern = largeJumps > 2 && requestHistory.length < 20;
  if (isPrefetchingPattern) {
    return {
      type: 'prefetching',
      position: currentSegment,
      distance: distance,
      confidence: 0.8,
      isNormalPlayerBehavior: true
    };
  }
  
  // If distance is very large but we've been playing for a while,
  // this is likely a user-initiated seek
  if (distance > NORMAL_PLAYBACK_RANGE && requestHistory.length > 15) {
    return { 
      type: 'user_seek', 
      position: currentSegment,
      fromPosition: lastPosition,
      distance: distance,
      confidence: 0.95,
      isNormalPlayerBehavior: false  // This is user-initiated, not automatic player behavior
    };
  }
  
  // Normal sequential playback
  const isSequential = currentSegment > lastPosition && distance <= 5; // Slightly more forgiving
  if (isSequential) {
    return { 
      type: 'sequential', 
      position: currentSegment,
      confidence: 0.95,
      isNormalPlayerBehavior: true
    };
  }
  
  // Normal buffering behavior (small backwards or forwards jumps)
  return { 
    type: 'buffering', 
    position: Math.max(currentSegment, lastPosition),
    confidence: 0.7,
    isNormalPlayerBehavior: true
  };
}

/**
 * Determine if a new transcoding process should be started
 * @param {string} clientId - Client identifier
 * @param {object} clientSession - Client session data
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @param {number} segmentNumber - Requested segment
 * @param {object} requestAnalysis - Result from analyzeRequestPattern
 * @returns {boolean} - True if new transcoding should start
 */
async function shouldStartNewTranscoding(clientId, clientSession, videoId, variantLabel, segmentNumber, requestAnalysis) {
  const taskKey = `${videoId}_${variantLabel}`;
  const activeTask = activeTranscodingTasks.get(taskKey);
  const now = Date.now();
  
  // Check for existing segment ranges on disk if there's no active task
  // or if it's been a while since we checked
  if (!activeTask || 
      !activeTask.generatedSegments || 
      now - (activeTask.generatedSegments.lastVerifiedTime || 0) > SEGMENT_SCAN_INTERVAL) {
    
    console.log(`Scanning for existing segments for ${videoId}/${variantLabel}`);
    const segmentRanges = await scanExistingSegments(videoId, variantLabel);
    
    // If no active task but we found existing segments, create a task entry
    if (!activeTask && segmentRanges.length > 0) {
      console.log(`Creating task for ${taskKey} based on existing segments on disk`);
      
      // Determine appropriate start and latest segment values
      let startSegment = Infinity;
      let latestSegment = -Infinity;
      
      for (const range of segmentRanges) {
        startSegment = Math.min(startSegment, range.start);
        latestSegment = Math.max(latestSegment, range.end);
      }
      
      // Create a new task entry based on the existing segments
      activeTranscodingTasks.set(taskKey, {
        clientId: clientId,
        segmentStart: startSegment,
        latestSegment: latestSegment,
        lastActivity: Date.now(),
        priority: VARIANT_PRIORITY[variantLabel] || 1,
        clientIds: new Set([clientId]),
        generatedSegments: {
          ranges: segmentRanges,
          lastVerifiedTime: now
        }
      });
      
      // If the requested segment is within the existing ranges, no need to start transcoding
      if (isSegmentInExistingRanges(segmentNumber, segmentRanges)) {
        console.log(`Requested segment ${segmentNumber} already exists on disk, serving without starting transcoding`);
        return false;
      }
      
      // If the requested segment is close to an existing range, don't restart
      const nearestRange = findNearestRange(segmentNumber, segmentRanges, NORMAL_PLAYBACK_RANGE / 2);
      if (nearestRange) {
        console.log(`Requested segment ${segmentNumber} is near existing range (${JSON.stringify(nearestRange)}), using without restart`);
        return false;
      }
    } 
    // Update existing task with segment ranges
    else if (activeTask && segmentRanges.length > 0) {
      activeTask.generatedSegments = {
        ranges: segmentRanges,
        lastVerifiedTime: now
      };
      
      // If requested segment is within existing ranges, don't restart
      if (isSegmentInExistingRanges(segmentNumber, segmentRanges)) {
        console.log(`Requested segment ${segmentNumber} already exists on disk, serving without restart`);
        return false;
      }
    }
  } 
  // Check if requested segment is in existing ranges we already know about
  else if (activeTask && activeTask.generatedSegments && activeTask.generatedSegments.ranges) {
    if (isSegmentInExistingRanges(segmentNumber, activeTask.generatedSegments.ranges)) {
      console.log(`Requested segment ${segmentNumber} exists in known generated ranges, no need to restart`);
      return false;
    }
  }
  
  // No active transcoding after disk checks, start new
  if (!activeTask) {
    return true;
  }
  
  // Calculate how many segments this process has likely completed
  // This creates "momentum" - the longer a process runs, the harder it is to stop
  const segmentsCompleted = Math.max(0, activeTask.latestSegment - activeTask.segmentStart);
  
  // Calculate adjusted threshold based on momentum
  // The more segments we've completed, the higher the threshold to restart
  let adjustedThreshold = NORMAL_PLAYBACK_RANGE + 
    (segmentsCompleted > TRANSCODING_MIN_SEGMENTS ? 
      segmentsCompleted * TRANSCODING_MOMENTUM_FACTOR : 0);
  
  // For normal player behavior (buffering, prefetching), use higher threshold
  // Only user-initiated seeks should have lower threshold
  if (requestAnalysis.isNormalPlayerBehavior) {
    adjustedThreshold *= 1.5;  // 50% higher threshold for normal player behavior
  }
  
  // Special handling for audio variants with multiple channels
  if (activeTask.isAudio && activeTask.channels && activeTask.channels > 2) {
    // Multi-channel audio needs more stability, so increase threshold
    adjustedThreshold *= 1.25;
    console.log(`Using higher threshold for multi-channel audio (${activeTask.channels} channels)`);
  }
  
  // Check if request is in an acceptable range from current transcoding progress
  // Use latestSegment instead of segmentStart to better assess current transcoding progress
  const progressPosition = Math.max(activeTask.segmentStart, activeTask.latestSegment);
  const bufferedPosition = progressPosition + PRELOAD_THRESHOLD; // Account for buffered segments
  const distance = Math.abs(segmentNumber - bufferedPosition);
  
  // Log the distances for debugging
  console.log(`Segment request: ${segmentNumber}, Current position: ${progressPosition}, Buffered position: ${bufferedPosition}, Distance: ${distance}, Threshold: ${adjustedThreshold}`);
  
  // If distance is within adjusted threshold, don't restart
  if (distance < adjustedThreshold) {
    return false;
  }
  
  // If there's a cooldown period active, don't restart
  if (now - activeTask.lastActivity < SEEK_COOLDOWN) {
    console.log(`Seek cooldown active for ${taskKey}, not restarting transcoding`);
    return false;
  }
  
  // For actual user seeks (not normal player behavior), consider restarting
  if (!requestAnalysis.isNormalPlayerBehavior) {
    // If request is from same client that initiated current task or is in the client set
    if (activeTask.clientId === clientId || 
        (activeTask.clientIds && activeTask.clientIds.has(clientId))) {
      console.log(`User-initiated seek detected for ${taskKey}, allowing restart`);
      return true;
    }
  }
  
  // For very distant requests (more than double the adjusted threshold),
  // allow restart even for normal player behavior
  if (distance > adjustedThreshold * 2) {
    console.log(`Request for segment ${segmentNumber} is very far from current transcoding position ${activeTask.segmentStart}, allowing restart`);
    return true;
  }
  
  // Consider the number of clients using this task
  // If multiple clients are using it, be more conservative about restarting
  if (activeTask.clientIds && activeTask.clientIds.size > 1) {
    console.log(`${activeTask.clientIds.size} clients using this task, being conservative about restarting`);
    // Only restart if it's a true user seek from this client
    return !requestAnalysis.isNormalPlayerBehavior && 
           (activeTask.clientId === clientId || activeTask.clientIds.has(clientId));
  }
  
  // Otherwise, don't restart for normal player behavior
  return false;
}

/**
 * Update the client session with a new request
 * @param {string} clientId - Client identifier
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @param {number} segmentNumber - Requested segment
 * @returns {object} - Updated client session
 */
function updateClientSession(clientId, videoId, variantLabel, segmentNumber) {
  const now = Date.now();
  
  // Get or create client session
  let clientSession = clientSessions.get(clientId);
  if (!clientSession) {
    clientSession = {
      lastRequestTime: now,
      videoId: videoId,
      variants: {},
      currentActiveVariant: variantLabel
    };
    clientSessions.set(clientId, clientSession);
  }
  
  // Update last request time
  clientSession.lastRequestTime = now;
  
  // Get or create variant tracking
  if (!clientSession.variants[variantLabel]) {
    clientSession.variants[variantLabel] = {
      requestHistory: [],
      primaryPosition: segmentNumber,
      transcodingPosition: null,
      lastRequestTime: now
    };
  } else {
    // Update last request time for this variant
    clientSession.variants[variantLabel].lastRequestTime = now;
  }
  
  // Check if user has switched to a higher quality variant
  if (variantLabel !== clientSession.currentActiveVariant) {
    const currentPriority = VARIANT_PRIORITY[variantLabel] || 0;
    const previousPriority = VARIANT_PRIORITY[clientSession.currentActiveVariant] || 0;
    
    if (currentPriority >= previousPriority) {
      console.log(`Client ${clientId} switched variant from ${clientSession.currentActiveVariant} to ${variantLabel}`);
      
      // Get the previous variant before updating
      const previousVariant = clientSession.currentActiveVariant;
      
      // Update current active variant
      clientSession.currentActiveVariant = variantLabel;
      
      // Immediately stop all other active transcoding processes
      if (previousVariant) {
        console.log(`Immediately stopping transcoding for previous variant ${previousVariant} after switch to ${variantLabel}`);
        stopActiveTranscoding(videoId, previousVariant)
          .catch(err => console.error(`Error stopping transcoding for previous variant ${previousVariant}:`, err));
        
        // Also stop all other variants to be absolutely sure
        stopAllOtherVariants(clientId, videoId, variantLabel)
          .catch(err => console.error(`Error stopping other variants:`, err));
      }
    }
  }
  
  const variantData = clientSession.variants[variantLabel];
  
  // Add to request history
  variantData.requestHistory.push({
    segment: segmentNumber,
    timestamp: now
  });
  
  // Trim history if needed
  if (variantData.requestHistory.length > REQUEST_HISTORY_SIZE) {
    variantData.requestHistory = variantData.requestHistory.slice(-REQUEST_HISTORY_SIZE);
  }
  
  // Analyze request pattern
  const analysis = analyzeRequestPattern(variantData.requestHistory, segmentNumber);
  
  // Update primaryPosition based on analysis
  if (analysis.type === 'sequential' || 
      analysis.type.includes('initial') || 
      analysis.type === 'prefetching') {
    variantData.primaryPosition = segmentNumber;
  } else if (analysis.type === 'user_seek') {
    variantData.primaryPosition = analysis.position;
  } else if (analysis.type === 'buffering') {
    // For buffering, we want to keep track of the furthest position
    variantData.primaryPosition = Math.max(variantData.primaryPosition || 0, segmentNumber);
  }
  
  return { clientSession, analysis };
}

/**
 * Stop all variant transcodings except the current one
 * @param {string} clientId - Client identifier
 * @param {string} videoId - Video identifier
 * @param {string} currentVariant - Current variant to keep
 */
async function stopAllOtherVariants(clientId, videoId, currentVariant) {
  const session = clientSessions.get(clientId);
  if (!session) return;
  
  console.log(`Client ${clientId} stopping all variants except ${currentVariant} for ${videoId}`);
  
  // Double-check that currentVariant is valid and matches session.currentActiveVariant
  if (currentVariant !== session.currentActiveVariant) {
    console.log(`Warning: currentVariant (${currentVariant}) does not match session.currentActiveVariant (${session.currentActiveVariant})`);
    // Use the current active variant from the session to be safe
    currentVariant = session.currentActiveVariant;
  }
  
  // Update the session's currentActiveVariant explicitly
  session.currentActiveVariant = currentVariant;
  if (session.variants[currentVariant]) {
    session.variants[currentVariant].lastRequestTime = Date.now();
    session.variants[currentVariant].active = true;
  }
  
  const variantLabels = Object.keys(session.variants || {});
  let stoppedCount = 0;
  
  for (const variantLabel of variantLabels) {
    // Skip the current active variant - this is critical!
    if (variantLabel === currentVariant) {
      console.log(`Preserving active variant ${variantLabel} for client ${clientId}`);
      continue;
    }
    
    const taskKey = `${videoId}_${variantLabel}`;
    if (activeTranscodingTasks.has(taskKey)) {
      console.log(`Immediately stopping transcoding for variant ${variantLabel} after switch to ${currentVariant}`);
      
      try {
        await stopActiveTranscoding(videoId, variantLabel);
        activeTranscodingTasks.delete(taskKey);
        stoppedCount++;
        
        // Mark variant as inactive to prevent future confusion
        if (session.variants[variantLabel]) {
          session.variants[variantLabel].active = false;
        }
      } catch (err) {
        console.error(`Error stopping transcoding for variant ${variantLabel}:`, err);
      }
    } else {
      console.log(`No active transcoding process found for ${videoId}_${variantLabel}`);
    }
  }
  
  console.log(`Stopped ${stoppedCount} variant transcoding processes for client ${clientId}`);
}

/**
 * Check and clean up abandoned variants for a client
 * This is called when a client switches to a different variant
 * @param {string} clientId - Client identifier
 * @param {string} videoId - Video identifier
 */
async function cleanupAbandonedVariants(clientId, videoId) {
  const clientSession = clientSessions.get(clientId);
  if (!clientSession) return;
  
  const currentActiveVariant = clientSession.currentActiveVariant;
  const now = Date.now();
  const variantsToCleanup = [];
  
  // Identify abandoned variants, but only collect variants that:
  // 1. Are not the currently active variant
  // 2. Have been idle for longer than the timeout
  // 3. Actually have an active transcoding task running
  for (const [variantLabel, variantData] of Object.entries(clientSession.variants)) {
    // Skip the currently active variant - this is critical to prevent stopping active transcoding
    if (variantLabel === currentActiveVariant) {
      console.log(`Skipping active variant ${variantLabel} in cleanup for client ${clientId}`);
      continue;
    }
    
    // Check if this variant has been abandoned
    const timeSinceLastRequest = now - (variantData.lastRequestTime || 0);
    if (timeSinceLastRequest > VARIANT_SWITCH_TIMEOUT) {
      // Only consider it abandoned if there's an active transcoding task for it
      const taskKey = `${videoId}_${variantLabel}`;
      if (activeTranscodingTasks.has(taskKey)) {
        console.log(`Found abandoned variant ${variantLabel} (${timeSinceLastRequest}ms since last request)`);
        variantsToCleanup.push(variantLabel);
      }
    }
  }
  
  // Stop transcoding for abandoned variants
  for (const variantLabel of variantsToCleanup) {
    const taskKey = `${videoId}_${variantLabel}`;
    console.log(`Cleaning up abandoned variant ${variantLabel} for client ${clientId}`);
    
    try {
      await stopActiveTranscoding(videoId, variantLabel);
      activeTranscodingTasks.delete(taskKey);
      
      // Don't delete from the client session yet to maintain history
      // But mark it as inactive
      if (clientSession.variants[variantLabel]) {
        clientSession.variants[variantLabel].active = false;
      }
      
      console.log(`Successfully stopped transcoding for abandoned variant ${variantLabel}`);
    } catch (err) {
      console.error(`Error stopping transcoding for abandoned variant ${variantLabel}:`, err);
    }
  }
}

/**
 * Count how many active transcoding processes are owned by a specific client
 * @param {string} clientId - Client identifier 
 * @returns {number} - Number of active transcoding processes owned by this client
 */
function countClientTranscodingProcesses(clientId) {
  let count = 0;
  for (const task of activeTranscodingTasks.values()) {
    if (task.clientId === clientId) {
      count++;
    }
  }
  return count;
}

/**
 * Enforce transcoding limits by terminating lower priority processes if needed
 * @param {string} clientId - Client that needs a new transcoding slot
 * @param {string} videoId - Video ID for the new transcoding
 * @param {string} variantLabel - Variant label for the new transcoding
 * @returns {Promise<boolean>} - Whether a slot was successfully freed
 */
async function enforceTranscodingLimits(clientId, videoId, variantLabel) {
  // Check system-wide limit first
  if (activeTranscodingTasks.size >= MAX_CONCURRENT_TRANSCODINGS) {
    console.log(`System-wide transcoding limit reached (${MAX_CONCURRENT_TRANSCODINGS}), looking for processes to terminate`);
    
    // Find the lowest priority task not owned by this client
    let lowestPriorityTask = null;
    let lowestPriority = Infinity;
    let lowestPriorityKey = null;
    
    for (const [taskKey, task] of activeTranscodingTasks.entries()) {
      // Skip tasks owned by this client to avoid terminating the client's own tasks
      if (task.clientId === clientId) continue;
      
      // Skip tasks that are being actively used by multiple clients
      if (task.clientIds && task.clientIds.size > 1) continue;
      
      if (task.priority < lowestPriority) {
        lowestPriority = task.priority;
        lowestPriorityTask = task;
        lowestPriorityKey = taskKey;
      }
    }
    
    if (lowestPriorityKey) {
      const [taskVideoId, taskVariantLabel] = lowestPriorityKey.split('_');
      console.log(`Terminating low priority task ${lowestPriorityKey} to make room for new request`);
      
      try {
        await stopActiveTranscoding(taskVideoId, taskVariantLabel);
        activeTranscodingTasks.delete(lowestPriorityKey);
        return true;
      } catch (err) {
        console.error(`Error terminating low priority task: ${err.message}`);
      }
    }
    
    // If we couldn't free a system-wide slot, check if this client is using too many
    const clientProcessCount = countClientTranscodingProcesses(clientId);
    if (clientProcessCount >= MAX_TRANSCODINGS_PER_CLIENT) {
      console.log(`Client ${clientId} has reached their max transcoding limit (${MAX_TRANSCODINGS_PER_CLIENT})`);
      
      // Find the client's own lowest priority task that's not for this variant
      lowestPriorityKey = null;
      lowestPriority = Infinity;
      
      for (const [taskKey, task] of activeTranscodingTasks.entries()) {
        if (task.clientId !== clientId) continue;
        
        // Don't terminate a task for the same variant we're trying to start
        const [taskVideoId, taskVariantLabel] = taskKey.split('_');
        if (taskVideoId === videoId && taskVariantLabel === variantLabel) continue;
        
        if (task.priority < lowestPriority) {
          lowestPriority = task.priority;
          lowestPriorityKey = taskKey;
        }
      }
      
      if (lowestPriorityKey) {
        const [taskVideoId, taskVariantLabel] = lowestPriorityKey.split('_');
        console.log(`Terminating client's own lower priority task ${lowestPriorityKey} to make room for new request`);
        
        try {
          await stopActiveTranscoding(taskVideoId, taskVariantLabel);
          activeTranscodingTasks.delete(lowestPriorityKey);
          return true;
        } catch (err) {
          console.error(`Error terminating client's task: ${err.message}`);
        }
      }
    }
    
    // If we still can't free a slot, return false
    return false;
  }
  
  // If we're under the system-wide limit, check client-specific limit
  const clientProcessCount = countClientTranscodingProcesses(clientId);
  if (clientProcessCount >= MAX_TRANSCODINGS_PER_CLIENT) {
    console.log(`Client ${clientId} has reached their max transcoding limit (${MAX_TRANSCODINGS_PER_CLIENT})`);
    
    // Try to free up a slot by terminating the client's lowest priority task
    let lowestPriorityKey = null;
    let lowestPriority = Infinity;
    
    for (const [taskKey, task] of activeTranscodingTasks.entries()) {
      if (task.clientId !== clientId) continue;
      
      // Don't terminate a task for the same variant we're trying to start
      const [taskVideoId, taskVariantLabel] = taskKey.split('_');
      if (taskVideoId === videoId && taskVariantLabel === variantLabel) continue;
      
      if (task.priority < lowestPriority) {
        lowestPriority = task.priority;
        lowestPriorityKey = taskKey;
      }
    }
    
    if (lowestPriorityKey) {
      const [taskVideoId, taskVariantLabel] = lowestPriorityKey.split('_');
      console.log(`Terminating client's lower priority task ${lowestPriorityKey} to make room for new request`);
      
      try {
        await stopActiveTranscoding(taskVideoId, taskVariantLabel);
        activeTranscodingTasks.delete(lowestPriorityKey);
        return true;
      } catch (err) {
        console.error(`Error terminating client's task: ${err.message}`);
        return false;
      }
    }
    
    return false;
  }
  
  // No limits exceeded, we can start a new transcoding
  return true;
}

/**
 * Handle a video segment request with intelligent client-aware transcoding
 * @param {object} req - Express request object
 * @param {string} videoId - Video identifier
 * @param {object} variant - Variant information
 * @param {string} videoPath - Path to source video
 * @param {number} segmentNumber - Segment number to ensure
 * @returns {Promise<string>} - Path to the segment file when it's ready
 */
async function handleVideoSegmentRequest(req, videoId, variant, videoPath, segmentNumber) {
  return handleSegment({
    req,
    videoId,
    variant,
    videoPath,
    segment: segmentNumber,
    ensureFn: ensureSegment
  });
}

/**
 * Handle an audio segment request with intelligent client-aware transcoding
 * @param {object} req - Express request object
 * @param {string} videoId - Video identifier
 * @param {object} audioVariant - Audio variant information
 * @param {string} videoPath - Path to source video
 * @param {number} segmentNumber - Segment number to ensure
 * @returns {Promise<string>} - Path to the segment file when it's ready
 */
async function handleAudioSegmentRequest(req, videoId, audioVariant, videoPath, segmentNumber) {
  return handleSegment({
    req,
    videoId,
    variant: audioVariant,
    videoPath,
    segment: segmentNumber,
    ensureFn: ensureAudioSegment
  });
}

/**
 * Get current client session information
 * @param {string} clientId - Client identifier
 * @returns {object|null} - Client session or null if not found
 */
function getClientSession(clientId) {
  return clientSessions.get(clientId) || null;
}

/**
 * Get active transcoding tasks
 * @returns {Map} - Map of active transcoding tasks
 */
function getActiveTranscodingTasks() {
  return new Map(activeTranscodingTasks);
}

/**
 * Prune old variants from client sessions to prevent memory leaks
 * This function removes variants that have been unused for a long time
 * @param {number} maxAgeMs - Maximum age of variants to keep (default: 1 hour)
 */
function pruneOldVariants(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  let prunedCount = 0;
  let clientsAffected = 0;
  
  for (const [clientId, session] of clientSessions.entries()) {
    if (!session.variants) continue;
    
    const variantLabels = Object.keys(session.variants);
    if (variantLabels.length <= 1) continue; // Keep at least one variant
    
    let clientAffected = false;
    
    // Find variants that haven't been used in a long time
    for (const variantLabel of variantLabels) {
      // Skip the currently active variant
      if (variantLabel === session.currentActiveVariant) continue;
      
      const variantData = session.variants[variantLabel];
      const lastActivity = variantData.lastRequestTime || 0;
      const age = now - lastActivity;
      
      // If this variant is very old and not the current active variant, remove it
      if (age > maxAgeMs) {
        delete session.variants[variantLabel];
        prunedCount++;
        clientAffected = true;
        console.log(`Pruned old variant ${variantLabel} for client ${clientId} (age: ${Math.round(age/1000/60)} minutes)`);
      }
    }
    
    if (clientAffected) {
      clientsAffected++;
    }
  }
  
  if (prunedCount > 0) {
    console.log(`Pruned ${prunedCount} old variants from ${clientsAffected} client sessions`);
  }
  
  return { prunedCount, clientsAffected };
}

/**
 * Clean up completed or stale transcoding tasks
 * This prevents memory leaks in the activeTranscodingTasks map
 */
function pruneCompletedTasks() {
  const now = Date.now();
  let prunedCount = 0;
  
  for (const [taskKey, task] of activeTranscodingTasks.entries()) {
    // Clean up tasks marked as finished
    if (task.finished) {
      console.log(`Removing finished task ${taskKey} from activeTranscodingTasks`);
      activeTranscodingTasks.delete(taskKey);
      prunedCount++;
      continue;
    }
    
    // Clean up tasks that have been pending start for too long
    if (task.pendingStart && now - task.lastActivity > VARIANT_SWITCH_TIMEOUT * 2) {
      console.log(`Removing stale pending task ${taskKey} from activeTranscodingTasks`);
      activeTranscodingTasks.delete(taskKey);
      prunedCount++;
      continue;
    }
    
    // Clean up tasks with no clients attached
    if (task.clientIds && task.clientIds.size === 0) {
      console.log(`Removing task ${taskKey} with no clients from activeTranscodingTasks`);
      activeTranscodingTasks.delete(taskKey);
      prunedCount++;
      continue;
    }
  }
  
  if (prunedCount > 0) {
    console.log(`Pruned ${prunedCount} completed or stale tasks`);
  }
  
  return prunedCount;
}

/**
 * Scan a directory for existing segments and build a range map
 * @param {string} videoId - Video identifier
 * @param {string} variantLabel - Variant label
 * @returns {Promise<Array<{start: number, end: number}>>} - Array of segment ranges that exist
 */
async function scanExistingSegments(videoId, variantLabel) {
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variantLabel);
  
  try {
    // Ensure directory exists
    try {
      await fs.mkdir(outputDir, { recursive: true });
    } catch (err) {
      // Ignore directory already exists error
      if (err.code !== 'EEXIST') throw err;
    }

    // Read all files in the directory
    const files = await fs.readdir(outputDir);
    
    // Filter for .ts segment files and extract segment numbers
    const segmentNumbers = [];
    const segmentRegex = /segment_(\d+)\.ts$/;
    
    for (const file of files) {
      const match = file.match(segmentRegex);
      if (match) {
        segmentNumbers.push(parseInt(match[1], 10));
      }
    }
    
    if (segmentNumbers.length === 0) {
      return [];
    }
    
    // Sort segment numbers
    segmentNumbers.sort((a, b) => a - b);
    
    // Build ranges
    const ranges = [];
    let rangeStart = segmentNumbers[0];
    let rangeEnd = rangeStart;
    
    for (let i = 1; i < segmentNumbers.length; i++) {
      const current = segmentNumbers[i];
      const previous = segmentNumbers[i - 1];
      
      // If this segment is continuous with the previous, extend the range
      if (current === previous + 1) {
        rangeEnd = current;
      } else {
        // Otherwise, close the current range and start a new one
        ranges.push({ start: rangeStart, end: rangeEnd });
        rangeStart = current;
        rangeEnd = current;
      }
    }
    
    // Add the last range
    ranges.push({ start: rangeStart, end: rangeEnd });
    
    console.log(`Found ${ranges.length} segment ranges for ${videoId}/${variantLabel}: ${JSON.stringify(ranges)}`);
    return ranges;
  } catch (err) {
    console.error(`Error scanning segments for ${videoId}/${variantLabel}:`, err);
    return [];
  }
}

/**
 * Check if a segment is within any of the existing ranges
 * @param {number} segmentNumber - Segment number to check
 * @param {Array<{start: number, end: number}>} ranges - Array of segment ranges
 * @returns {boolean} - True if segment is in a range
 */
function isSegmentInExistingRanges(segmentNumber, ranges) {
  if (!ranges || !Array.isArray(ranges)) return false;
  
  for (const range of ranges) {
    if (segmentNumber >= range.start && segmentNumber <= range.end) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if a segment is near (within threshold) of any existing range
 * @param {number} segmentNumber - Segment number to check
 * @param {Array<{start: number, end: number}>} ranges - Array of segment ranges
 * @param {number} threshold - Max distance to consider "near"
 * @returns {object|null} - Nearest range and distance, or null if none within threshold
 */
function findNearestRange(segmentNumber, ranges, threshold = 5) {
  if (!ranges || !Array.isArray(ranges) || ranges.length === 0) return null;
  
  let nearestRange = null;
  let minDistance = Infinity;
  
  for (const range of ranges) {
    // Check distance to start of range
    const distanceToStart = Math.abs(segmentNumber - range.start);
    if (distanceToStart < minDistance) {
      minDistance = distanceToStart;
      nearestRange = { ...range, position: 'start', distance: distanceToStart };
    }
    
    // Check distance to end of range
    const distanceToEnd = Math.abs(segmentNumber - range.end);
    if (distanceToEnd < minDistance) {
      minDistance = distanceToEnd;
      nearestRange = { ...range, position: 'end', distance: distanceToEnd };
    }
  }
  
  // Only return if within threshold
  if (minDistance <= threshold) {
    return nearestRange;
  }
  
  return null;
}

/**
 * Update the generatedSegments property of a task with a new segment
 * @param {object} task - The transcoding task to update
 * @param {number} segmentNumber - Segment number that was generated
 */
function updateGeneratedSegments(task, segmentNumber) {
  if (!task.generatedSegments) {
    task.generatedSegments = {
      ranges: [{ start: segmentNumber, end: segmentNumber }],
      lastVerifiedTime: Date.now()
    };
    return;
  }
  
  const ranges = task.generatedSegments.ranges;
  let rangeUpdated = false;
  
  // Try to extend existing ranges
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    
    // If segment is already in this range, nothing to do
    if (segmentNumber >= range.start && segmentNumber <= range.end) {
      rangeUpdated = true;
      break;
    }
    
    // If segment is one before the range start, extend the range start
    if (segmentNumber === range.start - 1) {
      range.start = segmentNumber;
      rangeUpdated = true;
      break;
    }
    
    // If segment is one after the range end, extend the range end
    if (segmentNumber === range.end + 1) {
      range.end = segmentNumber;
      rangeUpdated = true;
      break;
    }
  }
  
  // If segment didn't extend any existing range, add a new range
  if (!rangeUpdated) {
    ranges.push({ start: segmentNumber, end: segmentNumber });
  }
  
  // Check if ranges can be merged
  let i = 0;
  while (i < ranges.length - 1) {
    const currentRange = ranges[i];
    const nextRange = ranges[i + 1];
    
    // If ranges overlap or are adjacent, merge them
    if (currentRange.end + 1 >= nextRange.start) {
      currentRange.end = Math.max(currentRange.end, nextRange.end);
      ranges.splice(i + 1, 1); // Remove the next range
    } else {
      i++;
    }
  }
  
  // Sort ranges by start position
  ranges.sort((a, b) => a.start - b.start);
  
  // Update verification time
  task.generatedSegments.lastVerifiedTime = Date.now();
}

/**
 * Schedule regular cleanup of abandoned variants for all clients
 * This will only clean up truly inactive variants
 */
setInterval(async () => {
  const now = Date.now();
  console.log(`Running scheduled cleanup of abandoned variants at ${new Date(now).toISOString()}`);
  
  let cleanupCount = 0;
  
  for (const [clientId, session] of clientSessions.entries()) {
    if (session.videoId) {
      console.log(`Performing scheduled cleanup check for client ${clientId}, active variant: ${session.currentActiveVariant}`);
      await cleanupAbandonedVariants(clientId, session.videoId);
      cleanupCount++;
    }
  }
  
  if (cleanupCount > 0) {
    console.log(`Completed scheduled cleanup checks for ${cleanupCount} clients`);
  }
  
  // Also prune old variants to prevent memory leaks
  pruneOldVariants();
  
  // And prune completed tasks
  pruneCompletedTasks();
}, VARIANT_SWITCH_TIMEOUT);


/**
 * Handle a segment request with intelligent client-aware transcoding
 * This is a unified orchestration function that handles both video and audio segment requests
 * @param {object} params - Request parameters
 * @param {object} params.req - Express request object
 * @param {string} params.videoId - Video identifier
 * @param {object} params.variant - Variant information (video variant or audio variant)
 * @param {string} params.videoPath - Path to source video
 * @param {number} params.segment - Segment number to ensure
 * @param {Function} params.ensureFn - Function to call to ensure segment (ensureSegment or ensureAudioSegment)
 * @returns {Promise<string>} - Path to the segment file when it's ready
 */
async function handleSegment({ req, videoId, variant, videoPath, segment, ensureFn }) {
  const clientId = getClientId(req);

  // 1) normalize the label up front
  const variantLabel = variant.label.toLowerCase();
  const variantTaskKey = `${videoId}_${variantLabel}`;
  const isAudio = !!variant.trackIndex;

  // 2) tell computeSegmentPath to use the lowercase folder
  const segmentPath = await helpers.computeSegmentPath(
    videoId,
    { ...variant, label: variantLabel },
    segment
  );

  // 3) serve immediately if it already exists
  if (await helpers.serveIfExists(clientId, videoId, variantLabel, segment, segmentPath, isAudio)) {
    return segmentPath;
  }

  // 4) update our session & analyze the pattern
  const { clientSession, analysis } = updateClientSession(clientId, videoId, variantLabel, segment);
  console.log(
    `Client ${clientId} ${isAudio ? 'audio ' : ''}` +
    `request analysis for ${videoId}/${variantLabel}#${segment}: ${analysis.type}`
  );

  // 5) grab any existing task for this variant
  const activeTask = activeTranscodingTasks.get(variantTaskKey);

  // 6) decide if we need to start fresh
  const startNew = await helpers.shouldRestartTask({
    clientId,
    variantTaskKey,
    clientSession,
    activeTask,
    analysis,
    segment,
    isAudio
  });

  if (startNew) {
    await helpers.restartOrEnqueueTask({
      clientId,
      videoId,
      variant: { ...variant, label: variantLabel },
      analysis,
      segment,
      clientSession,
      isAudio
    });
  } else if (activeTask) {
    helpers.touchExistingTask(activeTask, clientId, segment, isAudio, variantTaskKey);
  }

  // 7) track viewing and finally ensure the segment
  trackViewerActivity(videoId, variantLabel, segment);
  return helpers.ensureSegmentUnique({
    videoId,
    variant: { ...variant, label: variantLabel },
    videoPath,
    segment,
    ensureFn,
    variantTaskKey
  });
}

module.exports = {
  // Public API
  handleVideoSegmentRequest,
  handleAudioSegmentRequest,
  getClientId,
  getClientSession,
  getActiveTranscodingTasks,
  cleanupAbandonedVariants,
  stopAllOtherVariants,
  
  // Internal state and helpers needed by the helpers module
  activeTranscodingTasks,
  pendingSegmentEnsures,
  shouldStartNewTranscoding,
  updateGeneratedSegments,
  enforceTranscodingLimits,
  updateClientSession,
  
  // Constants
  NORMAL_PLAYBACK_RANGE,
  VARIANT_PRIORITY,
  TRANSCODING_MIN_SEGMENTS,
  TRANSCODING_MOMENTUM_FACTOR,
  PRELOAD_THRESHOLD,
  SEEK_COOLDOWN
};

// Initialize helpers with reference to this module
// This avoids circular dependencies - must be done after module.exports is defined
helpers.init(module.exports);
