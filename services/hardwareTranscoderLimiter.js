const { MAX_HW_PROCESSES } = require("../config/config");

// Current count of active hardware transcoding processes
let currentCount = 0;

// Queue for pending hardware transcoding tasks
// Each entry is { taskId, priority, resolve, reject, timestamp, metadata }
const pendingQueue = [];

// Process interval in milliseconds
const QUEUE_PROCESS_INTERVAL = 2000;

// Flag to indicate if queue processing is active
let isProcessingQueue = false;

// Start periodic queue processor
setInterval(processQueue, QUEUE_PROCESS_INTERVAL);

/**
 * Attempts to acquire a hardware transcoder slot, or queues the request if none available.
 *
 * This function either immediately grants a hardware slot if available, or places the
 * request in a priority queue to be processed when slots become available.
 *
 * @async
 * @function acquireSlot
 * @param {Object} options - Options for slot acquisition
 * @param {string} options.taskId - Unique identifier for this transcoding task (e.g., videoId_variantLabel)
 * @param {number} options.priority - Priority level (higher numbers = higher priority)
 * @param {Object} [options.metadata] - Additional metadata about the task for monitoring
 * @returns {Promise<boolean>} A promise that resolves to true when a hardware slot is acquired
 */
async function acquireSlot({ taskId, priority = 1, metadata = {} }) {
  // If slot is immediately available, grant it
  if (currentCount < MAX_HW_PROCESSES) {
    currentCount++;
    console.log(`Hardware slot acquired immediately for task ${taskId} (${currentCount}/${MAX_HW_PROCESSES} active)`);
    return true;
  }

  // Otherwise, queue the request
  console.log(`Hardware slot not available for task ${taskId}, adding to queue (position ${pendingQueue.length + 1})`);
  
  return new Promise((resolve, reject) => {
    // Check if this task is already in the queue
    const existingIndex = pendingQueue.findIndex(item => item.taskId === taskId);
    
    if (existingIndex >= 0) {
      // Update priority if higher than existing
      if (priority > pendingQueue[existingIndex].priority) {
        pendingQueue[existingIndex].priority = priority;
        console.log(`Updated priority for queued task ${taskId} to ${priority}`);
      }
      
      // Reuse the existing promise
      resolve(pendingQueue[existingIndex].resolve);
      return;
    }
    
    // Add new entry to queue
    pendingQueue.push({
      taskId,
      priority,
      resolve,
      reject,
      timestamp: Date.now(),
      metadata
    });
    
    // Sort queue by priority (higher first), then by timestamp (older first)
    pendingQueue.sort((a, b) => {
      // First by priority (descending)
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      // Then by timestamp (ascending - older first)
      return a.timestamp - b.timestamp;
    });
    
    // Trigger queue processing (won't do anything if already processing)
    processQueue();
  });
}

/**
 * Releases a hardware transcoder slot and processes the next item in queue if any.
 *
 * @function releaseSlot
 * @param {string} [taskId] - The task ID that's releasing the slot
 * @returns {void} No return value.
 */
function releaseSlot(taskId = undefined) {
  if (currentCount > 0) {
    currentCount--;
    console.log(`Hardware slot released${taskId ? ' by task ' + taskId : ''} (${currentCount}/${MAX_HW_PROCESSES} active)`);
    
    // Trigger queue processing in case there are pending tasks
    processQueue();
  }
}

/**
 * Processes the pending queue, granting slots to waiting tasks if available.
 * This function is called automatically when slots are released and periodically.
 *
 * @function processQueue
 * @returns {void} No return value.
 */
function processQueue() {
  // Prevent concurrent processing
  if (isProcessingQueue || pendingQueue.length === 0) {
    return;
  }
  
  isProcessingQueue = true;
  
  try {
    // Process as many items as we have available slots
    while (currentCount < MAX_HW_PROCESSES && pendingQueue.length > 0) {
      const nextTask = pendingQueue.shift();
      currentCount++;
      
      console.log(`Granting queued hardware slot to task ${nextTask.taskId} (waited ${Math.floor((Date.now() - nextTask.timestamp) / 1000)}s)`);
      
      // Resolve the promise for this task
      nextTask.resolve(true);
    }
    
    // Log queue status if items remain
    if (pendingQueue.length > 0) {
      console.log(`Transcoding queue: ${pendingQueue.length} task(s) waiting for hardware slots`);
    }
  } catch (err) {
    console.error('Error processing hardware transcoder queue:', err);
  } finally {
    isProcessingQueue = false;
  }
}

/**
 * Gets the current queue status for monitoring
 *
 * @function getQueueStatus
 * @returns {Object} Queue status information
 */
function getQueueStatus() {
  return {
    activeSlots: currentCount,
    maxSlots: MAX_HW_PROCESSES,
    queuedTasks: pendingQueue.length,
    queuedTaskIds: pendingQueue.map(item => item.taskId)
  };
}

/**
 * Cancels a pending task in the queue
 *
 * @function cancelQueuedTask
 * @param {string} taskId - The task ID to cancel
 * @returns {boolean} True if a task was found and cancelled, false otherwise
 */
function cancelQueuedTask(taskId) {
  const index = pendingQueue.findIndex(item => item.taskId === taskId);
  
  if (index >= 0) {
    const task = pendingQueue[index];
    pendingQueue.splice(index, 1);
    task.reject(new Error('Task cancelled'));
    console.log(`Cancelled queued task ${taskId}`);
    return true;
  }
  
  return false;
}

module.exports = { 
  acquireSlot, 
  releaseSlot,
  getQueueStatus,
  cancelQueuedTask
};
