const { MAX_HW_PROCESSES } = require("../config/config");

let currentCount = 0;

/**
 * Attempts to acquire a hardware transcoder slot.
 *
 * This asynchronous function checks whether the current number of active hardware processes
 * (tracked by a global or module-level variable) is less than the maximum allowed (MAX_HW_PROCESSES).
 * If a slot is available, it increments the count and returns true; otherwise, it returns false.
 *
 * @async
 * @function acquireSlot
 * @returns {Promise<boolean>} A promise that resolves to true if a hardware slot is successfully acquired,
 *                             or false if the maximum number of hardware processes has been reached.
 */
async function acquireSlot() {
  if (currentCount < MAX_HW_PROCESSES) {
    currentCount++;
    return true;
  }
  return false;
}

/**
 * Releases a slot by decrementing the current count if it is greater than zero.
 *
 * This function checks if there are any slots currently in use and decreases the count accordingly.
 *
 * @function releaseSlot
 * @returns {void} No return value.
 */
function releaseSlot() {
  if (currentCount > 0) {
    currentCount--;
  }
}

module.exports = { acquireSlot, releaseSlot };