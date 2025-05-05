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
//   clientIds: Set<string> // All clients using this transcoding task
// }
const activeTranscodingTasks = new Map();

// Configuration constants
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const REQUEST_HISTORY_SIZE = 30; // Number of requests to keep in history per variant (increased)
const NORMAL_PLAYBACK_RANGE = 40; // Segments considered within normal playback range (significantly increased)
const SEEK_COOLDOWN = 10000; // Minimum ms between transcoding restarts (doubled to 10 seconds)
const PRELOAD_THRESHOLD = 10; // Segments to preload ahead of playback (doubled)
const VARIANT_SWITCH_TIMEOUT = 15 * 1000; // Time to wait before stopping abandoned variant transcoding (15 seconds)
const VARIANT_PRIORITY = { // Higher number = higher priority
  '4k': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1
};
// Transcoding process "momentum" - longer running processes are harder to stop
const TRANSCODING_MIN_SEGMENTS = 10; // Minimum segments to produce before considering a restart
const TRANSCODING_MOMENTUM_FACTOR = 0.5; // How much to increase restart threshold per segment transcoded

// Clean up stale sessions periodically
setInterval(cleanupStaleSessions, 60 * 1000);

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
      // Stop any active transcoding initiated by this client
      for (const [taskKey, task] of activeTranscodingTasks.entries()) {
        if (task.clientId === clientId) {
          const [videoId, variantLabel] = taskKey.split('_');
          stopActiveTranscoding(videoId, variantLabel)
            .catch(err => console.error(`Error stopping transcoding for ${taskKey}:`, err));
          activeTranscodingTasks.delete(taskKey);
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
function shouldStartNewTranscoding(clientId, clientSession, videoId, variantLabel, segmentNumber, requestAnalysis) {
  const taskKey = `${videoId}_${variantLabel}`;
  const activeTask = activeTranscodingTasks.get(taskKey);
  
  // No active transcoding, always start new
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
  
  // Check if request is in an acceptable range from current transcoding position
  const distance = Math.abs(segmentNumber - activeTask.segmentStart);
  
  // If distance is within adjusted threshold, don't restart
  if (distance < adjustedThreshold) {
    return false;
  }
  
  // If there's a cooldown period active, don't restart
  const now = Date.now();
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
      clientSession.currentActiveVariant = variantLabel;
      
      // Schedule cleanup of abandoned variants
      setTimeout(() => {
        cleanupAbandonedVariants(clientId, videoId);
      }, 1000); // Quick check to see if we need to stop other variants
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
  
  // Identify abandoned variants
  for (const [variantLabel, variantData] of Object.entries(clientSession.variants)) {
    // Skip the currently active variant
    if (variantLabel === currentActiveVariant) continue;
    
    // Check if this variant has been abandoned
    const timeSinceLastRequest = now - (variantData.lastRequestTime || 0);
    if (timeSinceLastRequest > VARIANT_SWITCH_TIMEOUT) {
      variantsToCleanup.push(variantLabel);
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
 * Handle a video segment request with intelligent client-aware transcoding
 * @param {object} req - Express request object
 * @param {string} videoId - Video identifier
 * @param {object} variant - Variant information
 * @param {string} videoPath - Path to source video
 * @param {number} segmentNumber - Segment number to ensure
 * @returns {Promise<string>} - Path to the segment file when it's ready
 */
async function handleVideoSegmentRequest(req, videoId, variant, videoPath, segmentNumber) {
  // Generate client ID
  const clientId = getClientId(req);
  
  // Check if segment already exists
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variant.label);
  const segmentPath = path.join(outputDir, segmentNumberToFilename(segmentNumber));
  
  const exists = await segmentExists(segmentPath);
  if (exists) {
    // Segment exists - update tracking but serve immediately
    console.log(`Segment ${segmentNumber} for ${videoId}/${variant.label} already exists, serving without transcoding`);
    updateClientSession(clientId, videoId, variant.label, segmentNumber);
    trackViewerActivity(videoId, variant.label, segmentNumber);
    return segmentPath;
  }
  
  // Update client session and analyze request pattern
  const { clientSession, analysis } = updateClientSession(clientId, videoId, variant.label, segmentNumber);
  console.log(`Client ${clientId} request analysis for ${videoId}/${variant.label}#${segmentNumber}: ${analysis.type}`);
  
  // Determine if we should start new transcoding
  const taskKey = `${videoId}_${variant.label}`;
  const activeTask = activeTranscodingTasks.get(taskKey);
  
  const startNew = shouldStartNewTranscoding(
    clientId, 
    clientSession, 
    videoId, 
    variant.label, 
    segmentNumber, 
    analysis
  );
  
  if (startNew) {
    console.log(`Starting new transcoding for ${taskKey} at segment ${segmentNumber} (type: ${analysis.type})`);
    
    // Try to stop any existing transcoding
    try {
      await stopActiveTranscoding(videoId, variant.label);
    } catch (err) {
      console.warn(`Error stopping existing transcoding for ${taskKey}:`, err);
    }
    
    // Record this transcoding task
    activeTranscodingTasks.set(taskKey, {
      clientId: clientId,
      segmentStart: segmentNumber,
      latestSegment: segmentNumber - 1, // Start with one less to track progress
      lastActivity: Date.now(),
      priority: VARIANT_PRIORITY[variant.label] || 1,
      clientIds: new Set([clientId]) // Track all clients using this transcoding
    });
    
    // Update client session
    clientSession.variants[variant.label].transcodingPosition = segmentNumber;
  } else {
  // Update the activity timestamp for this task
  if (activeTask) {
    activeTask.lastActivity = Date.now();
    
    // Add this client to the set of clients using this task
    if (activeTask.clientIds && !activeTask.clientIds.has(clientId)) {
      activeTask.clientIds.add(clientId);
      console.log(`Client ${clientId} added to existing video transcoding task ${taskKey}`);
    }
    
    // If this segment is further along than our latest tracked segment,
    // update our understanding of the transcoding progress
    if (segmentNumber > activeTask.latestSegment) {
      activeTask.latestSegment = segmentNumber;
    }
    
    console.log(`Using existing transcoding for ${taskKey}, progress: segments ${activeTask.segmentStart} to ${activeTask.latestSegment}`);
  }
  }
  
  // Track viewer activity in segment manager
  trackViewerActivity(videoId, variant.label, segmentNumber);
  
  // Ensure segment is available (using existing segmentManager)
  try {
    return await ensureSegment(videoId, variant, videoPath, segmentNumber);
  } catch (error) {
    console.error(`Error ensuring segment ${segmentNumber} for ${videoId}/${variant.label}:`, error);
    throw error;
  }
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
  // Generate client ID
  const clientId = getClientId(req);
  
  // Check if segment already exists
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariant.label);
  const segmentPath = path.join(outputDir, segmentNumberToFilename(segmentNumber));
  
  const exists = await segmentExists(segmentPath);
  if (exists) {
    // Segment exists - update tracking but serve immediately
    console.log(`Audio segment ${segmentNumber} for ${videoId}/${audioVariant.label} already exists, serving without transcoding`);
    updateClientSession(clientId, videoId, audioVariant.label, segmentNumber);
    trackViewerActivity(videoId, audioVariant.label, segmentNumber);
    return segmentPath;
  }
  
  // Update client session and analyze request pattern
  const { clientSession, analysis } = updateClientSession(clientId, videoId, audioVariant.label, segmentNumber);
  console.log(`Client ${clientId} audio request analysis for ${videoId}/${audioVariant.label}#${segmentNumber}: ${analysis.type}`);
  
  // Determine if we should start new transcoding
  const taskKey = `${videoId}_${audioVariant.label}`;
  const activeTask = activeTranscodingTasks.get(taskKey);
  
  const startNew = shouldStartNewTranscoding(
    clientId, 
    clientSession, 
    videoId, 
    audioVariant.label, 
    segmentNumber, 
    analysis
  );
  
  if (startNew) {
    console.log(`Starting new audio transcoding for ${taskKey} at segment ${segmentNumber} (type: ${analysis.type})`);
    
    // Try to stop any existing transcoding
    try {
      await stopActiveTranscoding(videoId, audioVariant.label);
    } catch (err) {
      console.warn(`Error stopping existing audio transcoding for ${taskKey}:`, err);
    }
    
    // Record this transcoding task
    activeTranscodingTasks.set(taskKey, {
      clientId: clientId,
      segmentStart: segmentNumber,
      latestSegment: segmentNumber - 1,
      lastActivity: Date.now(),
      priority: 1,
      clientIds: new Set([clientId]), // Track all clients using this transcoding
      isAudio: true, // Flag this as an audio task
      channels: audioVariant.channels // Track audio channels for special handling
    });
    
    // Update client session
    clientSession.variants[audioVariant.label].transcodingPosition = segmentNumber;
  } else {
  // Update the activity timestamp for this task
  if (activeTask) {
    activeTask.lastActivity = Date.now();
    
    // Add this client to the set of clients using this task
    if (activeTask.clientIds && !activeTask.clientIds.has(clientId)) {
      activeTask.clientIds.add(clientId);
      console.log(`Client ${clientId} added to existing audio transcoding task ${taskKey}`);
    }
    
    // If this segment is further along than our latest tracked segment,
    // update our understanding of the transcoding progress
    if (segmentNumber > activeTask.latestSegment) {
      activeTask.latestSegment = segmentNumber;
    }
  }
  }
  
  // Track viewer activity in segment manager
  trackViewerActivity(videoId, audioVariant.label, segmentNumber);
  
  // Ensure audio segment is available (using existing segmentManager)
  try {
    return await ensureAudioSegment(videoId, audioVariant, videoPath, segmentNumber);
  } catch (error) {
    console.error(`Error ensuring audio segment ${segmentNumber} for ${videoId}/${audioVariant.label}:`, error);
    throw error;
  }
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
 * Schedule regular cleanup of abandoned variants for all clients
 */
setInterval(async () => {
  const now = Date.now();
  
  for (const [clientId, session] of clientSessions.entries()) {
    if (session.videoId) {
      await cleanupAbandonedVariants(clientId, session.videoId);
    }
  }
}, VARIANT_SWITCH_TIMEOUT);

module.exports = {
  handleVideoSegmentRequest,
  handleAudioSegmentRequest,
  getClientId,
  getClientSession,
  getActiveTranscodingTasks,
  cleanupAbandonedVariants
};
