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

// Track segment durations to detect significant changes
// Structure: { [videoId_variantLabel]: { segmentNumber: duration } }
const segmentDurationStore = new Map();

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
    // Skip processing for fMP4 segments
    if (segmentPath.endsWith('.m4s')) {
      console.log(`Skipping TS continuity processing for fMP4 segment: ${segmentPath}`);
      return;
    }
    
    // Skip processing for the first segment (segment 0)
    if (segmentNumber === 0) {
      // For first segment, just parse it to store the final CC values
      await updateCcState(videoId, variantLabel, segmentPath);
      console.log(`Initialized CC state for first segment of ${videoId}_${variantLabel}`);
      return;
    }

    // Get the stored CC state from the previous segment
    const stateKey = `${videoId}_${variantLabel}`;
    const previousCcState = ccStateStore.get(stateKey) || {};
    
    // Determine if this is a transition segment with duration change
    let isTransition = false;
    try {
      const duration = await extractSegmentDuration(segmentPath);
      const durationStore = segmentDurationStore.get(stateKey) || {};
      
      // Store this segment's duration
      durationStore[segmentNumber] = duration;
      
      // Check for significant duration change from previous segment
      const prevDuration = durationStore[segmentNumber - 1];
      if (prevDuration && duration) {
        // Calculate percentage change
        const percentChange = Math.abs(duration - prevDuration) / prevDuration * 100;
        
        // If duration changed by more than 20%, consider it a transition segment
        if (percentChange > 20) {
          isTransition = true;
          console.log(`Detected segment transition: Duration changed by ${percentChange.toFixed(2)}% (${prevDuration.toFixed(3)}s → ${duration.toFixed(3)}s) at segment ${segmentNumber}`);
        }
      }
      
      segmentDurationStore.set(stateKey, durationStore);
    } catch (error) {
      console.warn(`Unable to check segment duration for transition detection: ${error.message}`);
    }
    
    if (Object.keys(previousCcState).length === 0) {
      console.log(`No previous CC state found for ${stateKey}. Skipping adjustment.`);
      // Still update state for future segments
      await updateCcState(videoId, variantLabel, segmentPath);
      return;
    }

    // Apply more aggressive processing for transition segments
    if (isTransition) {
      console.log(`Applying enhanced TS processing for transition segment ${segmentNumber}`);
    }

    // 1. Read the segment file
    const segmentBuffer = await fs.readFile(segmentPath);
    
    // 2. Process the segment with mux.js
    const { adjustedBuffer, finalCcState } = await adjustContinuityCounters(
      segmentBuffer, 
      previousCcState,
      isTransition
    );
    
    // 3. Create a temporary file with a unique name that won't conflict
    const tempFilename = `.__tmp_${Date.now()}_${Math.floor(Math.random() * 10000)}.ts`;
    const tempPath = path.join(path.dirname(segmentPath), tempFilename);
    
    // 4. Write the adjusted buffer to the temp file first
    try {
      await fs.writeFile(tempPath, Buffer.from(adjustedBuffer));
      
      // 5. Now try to replace the original file with the temp file
      try {
        // On Windows, we need to handle the case where the file might be locked
        // On Linux, this should work most of the time
        await fs.unlink(segmentPath);
        await fs.rename(tempPath, segmentPath);
        console.log(`Successfully replaced segment with fixed continuity counters: ${segmentPath}`);
      } catch (replaceError) {
        // If we can't replace the file, don't worry - we'll just use the original
        // This could happen if another process is reading the file
        console.warn(`Could not replace segment file (may be locked): ${replaceError.message}`);
        
        // Clean up temp file so we don't leave junk behind
        try {
          await fs.unlink(tempPath);
        } catch (unlinkError) {
          // Ignore errors when deleting temp file
        }
      }
    } catch (writeError) {
      console.error(`Error writing temporary segment: ${writeError.message}`);
      // Clean up temp file if it exists
      try {
        await fs.unlink(tempPath);
      } catch (unlinkError) {
        // Ignore errors when deleting temp file
      }
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
 * Extract segment duration from a TS file
 * @param {string} segmentPath - Path to the segment file
 * @returns {Promise<number>} - Duration in seconds
 */
async function extractSegmentDuration(segmentPath) {
  try {
    const segmentBuffer = await fs.readFile(segmentPath);
    const segmentName = path.basename(segmentPath);
    
    // Parse timestamps from the segment
    let firstPts = null;
    let lastPts = null;
    let ptsFound = false;
    
    // Create streams for processing with ElementaryStream to better extract PTS values
    const packetStream = new muxjs.mp2t.TransportPacketStream();
    const parser = new muxjs.mp2t.TransportParseStream();
    const elementary = new muxjs.mp2t.ElementaryStream();
    const timestampParser = new muxjs.mp2t.TimestampRolloverStream();
    
    // Connect the streams
    packetStream.pipe(parser).pipe(elementary).pipe(timestampParser);
    
    // Look for PTS values in the stream
    timestampParser.on('data', (data) => {
      if (!data || !data.pts) return;
      
      ptsFound = true;
      
      if (firstPts === null) {
        firstPts = data.pts;
      }
      
      // Always update lastPts to get the latest value
      lastPts = data.pts;
    });
    
    // Process the entire buffer
    const packetSize = 188; // MPEG-TS packet size
    for (let i = 0; i < segmentBuffer.length; i += packetSize) {
      if (i + packetSize <= segmentBuffer.length) {
        packetStream.push(segmentBuffer.subarray(i, i + packetSize));
      }
    }
    packetStream.flush();
    elementary.flush(); // Ensure all elementary stream data is flushed
    
    // Log the results for debugging
    console.log(`Segment ${segmentName}: PTS found: ${ptsFound}, First PTS: ${firstPts}, Last PTS: ${lastPts}`);
    
    // Calculate duration
    if (firstPts !== null && lastPts !== null) {
      // Handle PTS wraparound (PTS is a 33-bit value that wraps around)
      let duration;
      if (lastPts < firstPts) {
        // PTS wrapped around
        duration = ((8589934592 - firstPts) + lastPts) / 90000; // 2^33 = 8589934592, 90kHz clock
      } else {
        duration = (lastPts - firstPts) / 90000;
      }
      
      // Handle invalid durations
      if (isNaN(duration) || duration <= 0 || duration > 60) {
        throw new Error(`Invalid segment duration: ${duration}s`);
      }
      
      return duration;
    }
    
    console.warn(`Segment ${segmentName}: Could not determine segment duration, no valid PTS values found`);
    // Return a default duration of 4 seconds to ensure transition detection still works
    return 4.0;
  } catch (error) {
    console.warn(`Error extracting segment duration from ${segmentName}: ${error.message}`);
    // Return a default duration instead of null to ensure transition detection still works
    return 4.0;
  }
}

/**
 * Adjust continuity counters in a TS segment buffer
 * @param {Buffer} tsBuffer - Original TS file buffer
 * @param {Object} previousCcState - Object mapping PIDs to their final CC values from previous segment
 * @param {boolean} isTransition - Whether this segment is a transition segment
 * @returns {Promise<Object>} - Object containing the adjusted buffer and final CC state
 */
function adjustContinuityCounters(tsBuffer, previousCcState, isTransition = false) {
  return new Promise((resolve) => {
    const packetSize = 188; // MPEG-TS packet size
    const outputBuffers = [];
    const finalCcState = { ...previousCcState }; // Start with previous state
    const pidFirstCcValues = {}; // To track the first CC per PID in this segment
    
    // For transition segments, we'll keep track of PIDs that need special handling
    const transitionPids = new Set();
    
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
            // This is the first packet for this PID, so increment from previous segment's last CC
            
            // For transition segments, use a more aggressive approach to ensure clean continuity
            if (isTransition) {
              // Mark this PID as needing special treatment
              transitionPids.add(pid);
              
              // For transition segments, we force a double increment to create clear separation
              // between the non-transition and transition segments. This helps players recognize
              // the boundary more clearly.
              const newCc = (previousCcState[pid] + 2) % 16;
              headerBytes[3] = (headerBytes[3] & 0xf0) | newCc;
              finalCcState[pid] = newCc;
              
              // If this is a video PID (generally not 0 or in the range 16-31)
              if (pid !== 0 && (pid < 16 || pid > 31)) {
                // Log special handling for video PIDs which tend to be most problematic
                console.log(`Applied transition handling for video PID ${pid}: previous CC ${previousCcState[pid]} → new CC ${newCc}`);
              }
            } else {
              // Normal handling for non-transition segments
              const newCc = (previousCcState[pid] + 1) % 16;
              headerBytes[3] = (headerBytes[3] & 0xf0) | newCc;
              finalCcState[pid] = newCc;
            }
          } else {
            // For subsequent packets, preserve the increment pattern from the first packet
            const ccIncrement = (currentCc - pidFirstCcValues[pid] + 16) % 16;
            
            // For transition segments with PIDs we've marked, maintain the special handling
            if (isTransition && transitionPids.has(pid)) {
              // For marked PIDs in transition segments, we add an extra increment
              // to maintain the double-increment pattern established for the first packet
              const newCc = (previousCcState[pid] + 1 + ccIncrement + 1) % 16;
              headerBytes[3] = (headerBytes[3] & 0xf0) | newCc;
              finalCcState[pid] = newCc;
            } else {
              // Normal handling for non-transition segments
              const newCc = (previousCcState[pid] + 1 + ccIncrement) % 16;
              headerBytes[3] = (headerBytes[3] & 0xf0) | newCc;
              finalCcState[pid] = newCc;
            }
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
