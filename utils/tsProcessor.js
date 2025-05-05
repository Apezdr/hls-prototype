// utils/tsProcessor.js
const fs = require('fs').promises;
const path = require('path');
const muxjs = require('mux.js');
const { safeFilename } = require('./files');

/**
 * Persistent store for tracking the last continuity counter values per PID for each variant.
 * Structure: { [videoId_variantLabel]: { [pid]: lastCCValue } }
 */
const ccStateStore = new Map();

/**
 * Process a TS segment to adjust continuity counters based on previous segment's ending values.
 * @param {string} videoId - Unique identifier for the video
 * @param {string} variantLabel - Variant label (e.g. "720p")
 * @param {string} segmentPath - Path to the segment file
 * @param {number} segmentNumber - The segment number
 * @returns {Promise<void>}
 */
async function processTsSegment(videoId, variantLabel, segmentPath, segmentNumber) {
  try {
    // Skip processing for the first segment (segment 0)
    if (segmentNumber === 0) {
      // For first segment, just parse it to store the final CC values
      await updateCcState(videoId, variantLabel, segmentPath);
      return;
    }

    // Get the stored CC state from the previous segment
    const stateKey = `${videoId}_${variantLabel}`;
    const previousCcState = ccStateStore.get(stateKey) || {};
    
    if (Object.keys(previousCcState).length === 0) {
      console.log(`No previous CC state found for ${stateKey}. Skipping adjustment.`);
      // Still update state for future segments
      await updateCcState(videoId, variantLabel, segmentPath);
      return;
    }

    // 1. Read the segment file
    const segmentBuffer = await fs.readFile(segmentPath);
    
    // 2. Process the segment with mux.js
    const { adjustedBuffer, finalCcState } = await adjustContinuityCounters(
      segmentBuffer, 
      previousCcState
    );
    
    // 3. Write the processed segment to a temporary file first
    const tempPath = `${segmentPath}.tmp.processed`;
    await fs.writeFile(tempPath, Buffer.from(adjustedBuffer));
    
    // 4. Try to atomically replace the original file with the processed one
    try {
      await fs.rename(tempPath, segmentPath);
    } catch (renameError) {
      if (renameError.code === 'EPERM' || renameError.code === 'EBUSY') {
        console.log(`File ${segmentPath} is locked, cannot replace. Using a copy approach instead.`);
        
        try {
          // Alternative approach: create a copy with a different name in the same directory
          const segDir = path.dirname(segmentPath);
          const segFilename = path.basename(segmentPath);
          const processedPath = path.join(segDir, `processed_${segFilename}`);
          
          // Copy the processed file instead of renaming
          await fs.copyFile(tempPath, processedPath);
          
          // Update the segment path for state tracking
          console.log(`Successfully copied processed segment to ${processedPath}`);
          
          // Clean up temp file
          try {
            await fs.unlink(tempPath);
          } catch (unlinkError) {
            // Ignore errors when deleting temp file
          }
          
          // Return early - we've stored the CC state and will use it for the next segment
          return;
        } catch (copyError) {
          console.error(`Error creating processed copy: ${copyError.message}`);
          // Continue to normal error handling
        }
      }
      
      // Re-throw any other errors
      throw renameError;
    }
    
    // 5. Update the CC state store with the final values from this segment
    ccStateStore.set(stateKey, finalCcState);
    
    console.log(`Successfully adjusted continuity counters for segment ${segmentNumber} of ${videoId}/${variantLabel}`);
  } catch (error) {
    console.error(`Error processing TS segment ${segmentPath}:`, error);
    // Don't throw - we should still serve the original segment rather than failing completely
  }
}

/**
 * Updates the CC state store with the final CC values from a segment
 * @param {string} videoId - Unique identifier for the video
 * @param {string} variantLabel - Variant label (e.g. "720p")
 * @param {string} segmentPath - Path to the segment file
 * @returns {Promise<void>}
 */
async function updateCcState(videoId, variantLabel, segmentPath) {
  try {
    const segmentBuffer = await fs.readFile(segmentPath);
    const finalCcState = extractFinalCcValues(segmentBuffer);
    
    const stateKey = `${videoId}_${variantLabel}`;
    ccStateStore.set(stateKey, finalCcState);
    
    console.log(`Updated CC state for ${stateKey} with ${Object.keys(finalCcState).length} PIDs`);
  } catch (error) {
    console.error(`Error updating CC state from ${segmentPath}:`, error);
  }
}

/**
 * Extract the final CC values for each PID from a TS buffer
 * @param {Buffer} tsBuffer - TS file buffer
 * @returns {Object} - Object mapping PIDs to their final CC values
 */
function extractFinalCcValues(tsBuffer) {
  const finalCcValues = {};
  const packetSize = 188; // MPEG-TS packet size
  
  // Create a TransportPacketStream to parse the TS file
  const packetStream = new muxjs.mp2t.TransportPacketStream();
  const parser = new muxjs.mp2t.TransportParseStream();
  
  // Track the CC values as we parse
  parser.on('data', (packet) => {
    // Validate the packet
    if (!packet) {
      return;
    }
    
    try {
      let pid, ccValue;
      
      let headerBytes;
      
      if (packet.type === 'pat') {
        pid = 0; // PAT always uses PID 0
        // Handle case where packet.data might be undefined
        if (!packet.data || packet.data.length < 4) {
          ccValue = 0; // Default
        } else {
          headerBytes = packet.data.subarray(0, 4);
          ccValue = headerBytes[3] & 0x0f;
        }
      } else if (packet.type === 'pmt') {
        pid = packet.pid;
        // Handle case where packet.data might be undefined
        if (!packet.data || packet.data.length < 4) {
          ccValue = 0; // Default
        } else {
          headerBytes = packet.data.subarray(0, 4);
          ccValue = headerBytes[3] & 0x0f;
        }
      } else if (packet.pid !== undefined) {
        pid = packet.pid;
        // For other packet types, data should exist
        if (!packet.data || packet.data.length < 4) {
          return; // Skip malformed packets
        }
        headerBytes = packet.data.subarray(0, 4);
        ccValue = headerBytes[3] & 0x0f;
      } else {
        // Unknown packet format
        return;
      }
      
      // Store the CC value for this PID
      finalCcValues[pid] = ccValue;
    } catch (error) {
      // Silently ignore errors during state extraction
    }
  });
  
  // Pipe the packet stream to the parser
  packetStream.pipe(parser);
  
  // Process the entire buffer
  for (let i = 0; i < tsBuffer.length; i += packetSize) {
    if (i + packetSize <= tsBuffer.length) {
      packetStream.push(tsBuffer.subarray(i, i + packetSize));
    }
  }
  packetStream.flush();
  
  return finalCcValues;
}

/**
 * Adjust continuity counters in a TS segment buffer
 * @param {Buffer} tsBuffer - Original TS file buffer
 * @param {Object} previousCcState - Object mapping PIDs to their final CC values from previous segment
 * @returns {Promise<Object>} - Object containing the adjusted buffer and final CC state
 */
function adjustContinuityCounters(tsBuffer, previousCcState) {
  return new Promise((resolve) => {
    const packetSize = 188; // MPEG-TS packet size
    const outputBuffers = [];
    const finalCcState = { ...previousCcState }; // Start with previous state
    const pidFirstCcValues = {}; // To track the first CC per PID in this segment
    
    // Create streams for processing
    const packetStream = new muxjs.mp2t.TransportPacketStream();
    const parser = new muxjs.mp2t.TransportParseStream();
    
  // Process each packet
    parser.on('data', (packet) => {
      // Validate that we have a packet
      if (!packet) {
        console.warn('Received null packet, skipping');
        return;
      }
      
      // We need this to handle different packet formats in mux.js
      // Some packet types don't have 'data' property
      let pid, currentCc;
      
      try {
        // Handle packet based on its type
        if (packet.type === 'pat' || packet.type === 'pmt') {
          // For PAT/PMT, we get the PID directly from the packet
          pid = packet.type === 'pat' ? 0 : packet.pid;
          
          // PAT/PMT packets might not have a data property, so we
          // use a default CC value if we can't extract it
          currentCc = 0; // Default value
          
          // Skip these system packets as modifying them can break parsing
          // Just pass them through unchanged
          if (packet.data && packet.data.length >= 4) {
            currentCc = packet.data[3] & 0x0f;
            outputBuffers.push(packet.data);
          }
          
          // Track this PID's state even if we don't process the packet
          if (pidFirstCcValues[pid] === undefined) {
            pidFirstCcValues[pid] = currentCc;
          }
          if (previousCcState[pid] !== undefined) {
            finalCcState[pid] = (previousCcState[pid] + 1) % 16;
          } else {
            finalCcState[pid] = currentCc;
          }
          
          return; // Skip further processing for these packet types
        }
        
        // For regular packets, we need the data buffer
        if (!packet.data || packet.data.length < 4) {
          console.warn(`Skipping packet with invalid data for PID ${packet.pid}`);
          return;
        }
        
        // Regular packets with data buffer
        pid = packet.pid;
        var headerBytes = packet.data.subarray(0, 4);
        currentCc = headerBytes[3] & 0x0f; // Extract 4-bit CC
      } catch (error) {
        console.warn(`Error processing packet: ${error.message}`);
        return;
      }
      
      // Skip debug log to avoid console spam
      
      // At this point, we must have a valid headerBytes for this packet
      // Make sure it's defined before we continue
      if (typeof headerBytes === 'undefined') {
        console.warn(`Missing headerBytes for packet type ${packet.type} with PID ${pid}`);
        return;
      }

      // Store the first CC value for this PID if we haven't seen it before
      if (pidFirstCcValues[pid] === undefined) {
        pidFirstCcValues[pid] = currentCc;
      }
      
      // Adjust the CC value if we have a previous state for this PID
      if (previousCcState[pid] !== undefined) {
        try {
          // For the first packet of this PID in the segment, we want to ensure it
          // continues directly from the last CC value of the previous segment
          if (currentCc === pidFirstCcValues[pid]) {
            // This is the first packet for this PID, so just increment from previous segment's last CC
            const newCc = (previousCcState[pid] + 1) % 16;
            headerBytes[3] = (headerBytes[3] & 0xf0) | newCc;
            finalCcState[pid] = newCc;
          } else {
            // For subsequent packets, preserve the increment pattern from the first packet
            const ccIncrement = (currentCc - pidFirstCcValues[pid] + 16) % 16;
            const newCc = (previousCcState[pid] + 1 + ccIncrement) % 16;
            headerBytes[3] = (headerBytes[3] & 0xf0) | newCc;
            finalCcState[pid] = newCc;
          }
        } catch (error) {
          console.warn(`Error updating CC for PID ${pid}: ${error.message}`);
          finalCcState[pid] = currentCc; // Use current value as fallback
        }
        
        // Note: We've already updated both the header bytes and the final state above
      } else {
        // If we don't have previous state for this PID, just use the current CC
        finalCcState[pid] = currentCc;
      }
      
      // Add the (potentially modified) packet to the output
      outputBuffers.push(packet.data);
    });
    
    // Pipe the packet stream to the parser
    packetStream.pipe(parser);
    
    // Process the entire buffer
    for (let i = 0; i < tsBuffer.length; i += packetSize) {
      if (i + packetSize <= tsBuffer.length) {
        packetStream.push(tsBuffer.subarray(i, i + packetSize));
      }
    }
    packetStream.flush();
    
    // Filter out any undefined or null elements and ensure we have buffers to concatenate
    const validBuffers = outputBuffers.filter(buffer => buffer && buffer.length);
    
    if (validBuffers.length === 0) {
      // If we have no valid buffers, return the original buffer unchanged
      console.log('No valid buffers to concatenate, returning original buffer');
      resolve({ 
        adjustedBuffer: tsBuffer, 
        finalCcState 
      });
      return;
    }
    
    // Concatenate all valid packet buffers into the final output
    const adjustedBuffer = Buffer.concat(validBuffers);
    
    resolve({ adjustedBuffer, finalCcState });
  });
}

module.exports = {
  processTsSegment,
  updateCcState
};
