// utils/ffprobe.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { FFPROBE_PATH, MEDIAINFO_PATH } = require('../config/config');
const fsPromises = fs.promises;


/**
 * Retrieves media metadata by executing either ffprobe or mediainfo (depending on the `tool` param).
 *
 * @param {string} filePath - The path to the media file.
 * @param {string} [tool='ffprobe'] - Which tool to use: 'ffprobe' or 'mediainfo'.
 * @returns {Promise<Object>} A promise that resolves to the media metadata object in JSON format.
 */
function getMediaInfo(filePath, tool = 'ffprobe') {
  return new Promise((resolve, reject) => {
    let command;
    let args;

    // Choose which command and arguments to use based on the tool parameter
    if (tool === 'mediainfo') {
      command = MEDIAINFO_PATH;
      // Adjust arguments as needed — this is a typical way to get JSON output from mediainfo
      args = [
        '--Full',
        '--Output=JSON',
        filePath
      ];
    } else {
      // Default to ffprobe
      command = FFPROBE_PATH;
      args = [
        '-v', 'error',
        '-print_format', 'json',
        '-show_streams',
        '-show_stream_groups',
        filePath
      ];
    }

    const child = spawn(command, args);

    let output = '';

    child.stdout.on('data', (data) => {
      output += data;
    });

    child.stderr.on('data', (data) => {
      console.error(`${tool} error: ${data},${filePath}`);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(
          new Error(`${tool} process exited with code ${code} for file: ${filePath}`)
        );
      }

      try {
        const metadata = JSON.parse(output);
        resolve(metadata);
      } catch (error) {
        reject(error);
      }
    });

    // Catch any error that might happen while spawning
    child.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Determines the video FPS from the ffprobe metadata object.
 *
 * It locates the video stream from the provided mediaInfo and extracts the frame rate from
 * the `r_frame_rate` property (expected in the form "numerator/denominator"). If the property
 * exists and is properly formatted, it calculates and returns the FPS as a number.
 *
 * @param {Object} mediaInfo - The ffprobe metadata object.
 * @returns {number|null} - The frames per second, or null if not available.
 */
function getVideoFps(mediaInfo) {
  const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
  if (!videoStream || !videoStream.r_frame_rate) return null;

  const fpsStr = parseFrameRate(videoStream.r_frame_rate);
  const fps = parseFloat(fpsStr);
  return isNaN(fps) ? null : fps;
}

/**
 * Parses a frame rate string (e.g. "24000/1001") and returns a decimal string.
 *
 * @param {string} rateStr - The frame rate string.
 * @returns {string} - The frame rate as a string.
 */
function parseFrameRate(rateStr) {
  if (!rateStr) return '23.976';
  const parts = rateStr.split('/');
  if (parts.length === 2) {
    const fps = parseFloat(parts[0]) / parseFloat(parts[1]);
    return fps.toFixed(3);
  }
  return parseFloat(rateStr).toFixed(3);
}

/**
 * Determines the Apple HLS video range by checking video stream metadata.
 *
 * It inspects properties such as `color_transfer`, `transfer_characteristics`, and `color_primaries`,
 * and maps known HDR indicators to approved Apple HLS video ranges: "HLG", "PQ", or "SDR". If a video stream
 * property indicates HLG (via "hlg") then "HLG" is returned; if it indicates SMPTE 2084, PQ, or ARIB then "PQ"
 * is returned; otherwise "SDR" is returned.
 *
 * @param {Object} mediaInfo - The ffprobe metadata object.
 * @returns {string} - Either "HLG", "PQ", "SDR", or another approved Apple HLS video range if applicable.
 */
function determineVideoRange(mediaInfo) {
  const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
  if (!videoStream) return 'SDR'; // fallback if no video stream found

  function mapRange(value) {
    if (!value) return null;
    const val = value.toLowerCase();
    if (val.includes('hlg')) return 'HLG';
    if (val.includes('smpte2084') || val.includes('pq') || val.includes('arib')) return 'PQ';
    return null;
  }

  let range = mapRange(videoStream.color_transfer) || mapRange(videoStream.transfer_characteristics);
  if (range) return range;

  // Check color primaries for additional guidance (e.g., bt.2020).
  if (videoStream.color_primaries && videoStream.color_primaries.toLowerCase().includes('bt.2020')) {
    return 'PQ';
  }
  return 'SDR';
}

/**
 * Attempt to classify the source as SDR, HLG, HDR10, HDR10+, or Dolby Vision.
 * Fall back to SDR if no known HDR indicators are found.
 *
 * @param {Object} mediaInfo - The JSON result from ffprobe (with .streams array).
 * @returns {string} One of: 'SDR', 'HLG', 'HDR10', 'HDR10+', 'DolbyVision'.
 */
function detectHdrType(mediaInfo) {
  const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
  if (!videoStream) return 'SDR';

  const { 
    codec_name,            // e.g. 'h264', 'hevc', 'dvhe' (Dolby Vision)
    color_primaries, 
    color_transfer, 
    color_space,
    side_data_list = []    // sometimes contains "Mastering display metadata", HDR10+ dynamic metadata, etc.
  } = videoStream;

  // Normalize for case-insensitive checks
  const cp = (color_primaries || '').toLowerCase();
  const ct = (color_transfer || '').toLowerCase();
  const cs = (color_space || '').toLowerCase();
  const cn = (codec_name || '').toLowerCase();

  //
  // 1) Check for Dolby Vision by codec name or side data
  //
  // Dolby Vision in ffprobe can appear as:
  //   "codec_name": "dvh1" or "dvhe"
  //   "profile": "dvhe.05.06"
  //   side_data_list might also have "Dolby Vision" info
  //
  if (cn.includes('dvhe') || cn.includes('dvh1')) {
    return 'DolbyVision';
  }
  // Or check side_data_list for a "Dolby Vision" entry
  const hasDolbyMetadata = side_data_list.some(sd => {
    if (!sd.metadata) return false;
    // If we see keys that obviously indicate DV
    return Object.keys(sd.metadata).some(k => k.toLowerCase().includes('dolby'));
  });
  if (hasDolbyMetadata) {
    return 'DolbyVision';
  }

  //
  // 2) Check for HDR10+ or "dynamic_hdr10_plus" side data, or "HDR10+ Profile"
  //
  // HDR10+ might show up in side_data_list with name="Mastering display metadata" + 
  // "HDR10+" in the commercial_name, or "dynamic_hdrplus" side data.
  //
  const hasHdr10PlusSideData = side_data_list.some(sd => {
    if (!sd.side_data_type) return false;
    return sd.side_data_type.toLowerCase().includes('dynamic_hdrplus'); 
  });
  if (hasHdr10PlusSideData) {
    return 'HDR10+';
  }
  // Another fallback: sometimes "HDR10+" might be in color_primaries or something, 
  // but that’s less common.

  //
  // 3) Check HLG: color_transfer=arib-std-b67
  //
  if (ct.includes('arib-std-b67')) {
    return 'HLG';
  }

  //
  // 4) Check for HDR10: 
  //    Usually color_transfer=smpte2084, color_primaries=bt2020
  //
  // "HDR10" typically means PQ-based (smpte2084) with BT.2020 color. 
  // However, not all sources strictly list "bt2020"—some might say "bt2020nc" or "bt2020ncl".
  //
  const isPQ = ct.includes('smpte2084') || ct.includes('pq');
  const isBT2020 = cp.includes('bt2020') || cs.includes('bt2020');
  if (isPQ && isBT2020) {
    return 'HDR10';
  }

  //
  // 5) If none of those triggers, assume SDR
  //
  return 'SDR';
}

// Determine ffmpeg profile and level for H.264/AVC codec
/**
 * Examines ffprobe metadata and returns an object:
 * {
 *   profile: "high" | "high10" | ...,
 *   level: number | null,  // e.g. 51 if the video is H.264 High@5.1
 * }
 */
function determineFfmpegProfile(mediaInfo) {
  const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
  if (!videoStream) {
    return { profile: 'high', level: null };
  }

  // Default to 'high' profile unless found otherwise:
  let ffmpegProfile = 'high';
  let is10bit = false;

  // 1. Check pixel format for 10bit
  if (videoStream.pix_fmt) {
    const pixFmt = videoStream.pix_fmt.toLowerCase();
    if (pixFmt.includes('10')) {
      ffmpegProfile = 'high10';
      is10bit = true;
    }
  }

  // 2. Check metadata's "profile"
  if (videoStream.profile) {
    const profileStr = videoStream.profile.toLowerCase();
    if (profileStr.includes('high10')) ffmpegProfile = 'high10';
    else if (profileStr.includes('main')) ffmpegProfile = 'main';
    else if (profileStr.includes('baseline')) ffmpegProfile = 'baseline';
    else if (profileStr.includes('high')) ffmpegProfile = 'high';
  }

  // 3. Check numeric level (e.g., 51 => 5.1)
  let levelNum = null;
  if (typeof videoStream.level === 'number') {
    levelNum = videoStream.level;
  }

  return { profile: ffmpegProfile, level: levelNum, is10bit };
}

async function calculateAverageBitrate(variantOutputDir, numSegments = 3) {
  let totalBitrate = 0;
  let validSegments = 0;

  for (let i = 0; i < numSegments; i++) {
    const segmentFile = path.join(
      variantOutputDir,
      `${i.toString().padStart(3, '0')}.ts`
    );

    let stat;
    try {
      stat = await fsPromises.stat(segmentFile);
    } catch (error) {
      // File doesn't exist, skip this segment
      continue;
    }

    const segmentInfo = await getMediaInfo(segmentFile);
    const videoStream = segmentInfo.streams.find(
      (s) => s.codec_type === 'video'
    );

    if (videoStream) {
      let bitrate;

      // 1) Try to use the reported bit_rate if available
      if (videoStream.bit_rate) {
        bitrate = parseInt(videoStream.bit_rate, 10);
      }

      // 2) If bit_rate is missing, compute from file size / duration
      if (!bitrate) {
        const fileSizeInBytes = stat.size;
        if (videoStream.duration) {
          const duration = parseFloat(videoStream.duration);
          if (duration > 0) {
            // bits per second
            bitrate = (fileSizeInBytes * 8) / duration;
          }
        }
      }

      // If we successfully found or calculated a bitrate
      if (bitrate) {
        totalBitrate += bitrate;
        validSegments++;
      }
    }
  }

  // Return the average if we have valid segments
  return validSegments > 0 ? Promise.resolve(Math.round(totalBitrate / validSegments)) : Promise.reject(0);
}

/**
 * Get video duration in seconds using ffprobe
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<number>} - Duration in seconds
 */
async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      videoPath
    ];
    
    console.log(`Getting video duration: ${FFPROBE_PATH} ${args.join(' ')}`);
    
    const ffprobe = spawn(FFPROBE_PATH, args);
    let output = '';
    
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.stderr.on('data', (data) => {
      // Ignore stderr output
    });
    
    ffprobe.on('close', (code) => {
      if (code !== 0) {
        // Default to 2 hours for error cases
        console.log(`Error getting duration, defaulting to 2 hours`);
        return resolve(7200);
      }
      
      try {
        const result = JSON.parse(output);
        const duration = parseFloat(result.format.duration);
        console.log(`Video duration: ${duration} seconds`);
        resolve(isNaN(duration) ? 7200 : duration);
      } catch (err) {
        console.error(`Error parsing duration: ${err.message}`);
        // Default to 2 hours
        resolve(7200);
      }
    });
    
    ffprobe.on('error', (err) => {
      console.error(`FFprobe error: ${err.message}`);
      resolve(7200); // Default to 2 hours
    });
  });
}

module.exports = { getMediaInfo, getVideoFps, parseFrameRate, determineVideoRange, detectHdrType, determineFfmpegProfile, calculateAverageBitrate, getVideoDuration };
