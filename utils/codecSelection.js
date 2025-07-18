// utils/codecSelection.js
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { FFMPEG_PATH } = require('../config/config');

/**
 * Cache for hardware encoder capabilities
 * Structure: { 'h264_nvenc': true, 'hevc_nvenc': false, ... }
 */
let hwEncoderCache = null;

/**
 * Detect available hardware encoders on the system
 * @returns {Promise<Object>} Object with encoder names as keys and boolean values
 */
async function detectHardwareEncoders() {
  if (hwEncoderCache) {
    return hwEncoderCache;
  }

  try {
    const { stdout } = await execAsync(`${FFMPEG_PATH} -encoders`);
    
    // Initialize result object
    const encoders = {
      h264_nvenc: false,
      hevc_nvenc: false,
      av1_nvenc: false,
      h264_qsv: false,
      hevc_qsv: false,
      h264_vaapi: false,
      hevc_vaapi: false,
      h264_amf: false,
      hevc_amf: false
    };
    
    // Check for each encoder in the output
    Object.keys(encoders).forEach(encoder => {
      encoders[encoder] = stdout.includes(encoder);
    });
    
    // Cache the result
    hwEncoderCache = encoders;
    
    console.log('Detected hardware encoders:', 
      Object.keys(encoders).filter(k => encoders[k]).join(', ') || 'None');
    
    return encoders;
  } catch (error) {
    console.error('Error detecting hardware encoders:', error.message);
    // Return empty object as fallback
    return {};
  }
}

/**
 * Check if a specific hardware encoder is available
 * @param {string} encoderName - Name of the encoder to check (e.g., 'h264_nvenc')
 * @returns {Promise<boolean>} True if the encoder is available
 */
async function hasHardwareSupport(encoderName) {
  const encoders = await detectHardwareEncoders();
  return encoders[encoderName] || false;
}

/**
 * Codec selection strategies
 */
const codecStrategies = {
  /**
   * Use source codec when compatible, fallback to h264
   * @param {Object} mediaInfo - FFprobe media information
   * @returns {string} Codec to use
   */
  source: async (mediaInfo) => {
    const videoStream = mediaInfo.streams.find(s => s.codec_type === 'video');
    const sourceCodec = videoStream?.codec_name?.toLowerCase();
    
    console.log(`Source strategy examining source codec: ${sourceCodec}`);
    
    // Map ffprobe codec names to ffmpeg encoder names
    const codecMap = {
      'h264': 'h264',
      'avc': 'h264',
      'hevc': 'hevc',
      'h265': 'hevc',
      'vp9': 'vp9'
    };
    
    const mappedCodec = codecMap[sourceCodec];
    
    // If source codec is supported, use it directly regardless of hardware support
    // This ensures we preserve the source codec as requested
    if (mappedCodec) {
      console.log(`Source strategy: preserving original codec ${sourceCodec} → ${mappedCodec}`);
      return mappedCodec;
    }
    
    // Default to h264 for unsupported source codecs
    console.log(`Source codec ${sourceCodec} not directly supported, using h264`);
    return 'h264';
  },
  
  /**
   * Dynamically select codec based on content resolution and hardware support
   * @param {Object} mediaInfo - FFprobe media information
   * @param {Object} variant - Variant configuration
   * @returns {string} Codec to use
   */
  optimal: async (mediaInfo, variant) => {
    const height = parseInt(variant.resolution.split('x')[1]);
    
    // For 4K content, prefer HEVC if available
    if (height >= 1080) {
      if (await hasHardwareSupport('hevc_nvenc')) {
        console.log(`Optimal strategy selected HEVC for ${height}p content (hardware supported)`);
        return 'hevc';
      }
      if (await hasHardwareSupport('av1_nvenc')) {
        console.log(`Optimal strategy selected AV1 for ${height}p content (hardware supported)`);
        return 'av1';
      }
    }
    
    // Default to h264
    console.log(`Optimal strategy selected H264 for ${height}p content`);
    return 'h264';
  },
  
  /**
   * HDR-aware codec selection
   * @param {Object} mediaInfo - FFprobe media information
   * @returns {string} Codec to use
   */
  hdrAware: async (mediaInfo) => {
    const videoStream = mediaInfo.streams.find(s => s.codec_type === 'video');
    
    // Check for HDR characteristics
    const isHDR = videoStream?.color_space === 'bt2020nc' || 
                  videoStream?.color_transfer === 'smpte2084' ||
                  videoStream?.color_primaries === 'bt2020';
    
    const is10bit = videoStream?.bits_per_raw_sample === 10 ||
                  videoStream?.pix_fmt?.includes('p10');
                  
    // For HDR or 10-bit, prefer HEVC which has better support
    if ((isHDR || is10bit) && await hasHardwareSupport('hevc_nvenc')) {
      console.log(`HDR/10-bit content detected, using HEVC codec`);
      return 'hevc';
    }
    
    // Default to h264
    return 'h264';
  },
  
  /**
   * Always use h264 (legacy option for compatibility)
   */
  h264: async () => 'h264',
  
  /**
   * Always use HEVC/H.265
   */
  hevc: async () => 'hevc',
  
  /**
   * Always use AV1
   */
  av1: async () => 'av1'
};

/**
 * Resolve the codec to use based on strategy, media info, and variant
 * @param {string} codecStrategy - Codec strategy name or direct codec name
 * @param {Object} mediaInfo - FFprobe media information
 * @param {Object} variant - Variant configuration
 * @returns {Promise<string>} Resolved codec to use
 */
async function resolveCodec(codecStrategy, mediaInfo, variant) {
  // If no strategy specified, default to h264
  if (!codecStrategy) {
    return 'h264';
  }
  
  // Check if we have a strategy with this name
  if (codecStrategies[codecStrategy]) {
    return await codecStrategies[codecStrategy](mediaInfo, variant);
  }
  
  // If not a recognized strategy, assume it's a direct codec specification
  return codecStrategy;
}

/**
 * Get FFmpeg encoder name for a codec
 * @param {string} codec - Base codec name (h264, hevc, etc.)
 * @param {boolean} useHardware - Whether to use hardware encoding
 * @returns {Promise<string>} FFmpeg encoder name
 */
async function getEncoderForCodec(codec, useHardware) {
  if (!useHardware) {
    // Software encoders
    const softwareEncoders = {
      'h264': 'libx264',
      'hevc': 'libx265',
      'av1': 'libaom-av1' // or 'libsvtav1' which is faster
    };
    return softwareEncoders[codec] || 'libx264';
  } else {
    // Hardware encoders
    const hwEncoders = {
      'h264': 'h264_nvenc',
      'hevc': 'hevc_nvenc',
      'av1': 'av1_nvenc'
    };
    
    const encoder = hwEncoders[codec];
    
    // Check if this hardware encoder is available
    if (encoder && await hasHardwareSupport(encoder)) {
      return encoder;
    }
    
    // Fall back to software encoding if hardware isn't available
    console.log(`Hardware encoder ${encoder} not available, falling back to software`);
    return getEncoderForCodec(codec, false);
  }
}

/**
 * Determine pixel format for a codec
 * @param {string} codec - Codec name
 * @param {boolean} is10bit - Whether content is 10-bit
 * @returns {string} Pixel format
 */
function getPixelFormat(codec, is10bit) {
  if (codec === 'hevc' && is10bit) {
    return 'yuv420p10le';
  } else if (codec === 'av1' && is10bit) {
    return 'yuv420p10le';
  } else if (is10bit) {
    return 'yuv420p10le'; // Default for 10-bit
  } else {
    return 'yuv420p'; // Default 8-bit
  }
}

/**
 * Get encoder-specific arguments
 * @param {string} encoder - FFmpeg encoder name
 * @param {string} bitrate - Target bitrate
 * @param {Object} options - Additional options
 * @returns {Array} Array of FFmpeg arguments
 */
function getEncoderSpecificArgs(encoder, bitrate, options = {}) {
  const bitrateInt = parseInt(bitrate.replace('k', ''), 10);
  const maxrateMultiplier = 1.1;  // 10% higher than target
  const bufsizeMultiplier = 2;    // 2× the target bitrate
  
  // Base arguments common to most encoders
  const args = [
    '-b:v', bitrate,
    '-maxrate', `${Math.round(bitrateInt * maxrateMultiplier)}k`,
    '-bufsize', `${Math.round(bitrateInt * bufsizeMultiplier)}k`,
  ];
  
  // NVENC hardware encoders
  if (encoder.includes('nvenc')) {
    args.push(
      '-preset', 'medium',
      '-rc:v', 'vbr_hq',
      '-cq', '23'
    );
  }
  // x264 software encoder
  else if (encoder === 'libx264') {
    args.push(
      '-crf:v', '18',
      '-preset', 'medium',
      '-rc-lookahead', '120'
    );
  }
  // x265 software encoder
  else if (encoder === 'libx265') {
    args.push(
      '-crf:v', '22',  // x265 CRF scale is different from x264
      '-preset', 'medium',
      '-x265-params', 'rc-lookahead=120'
    );
  }
  // AV1 encoders
  else if (encoder === 'libaom-av1') {
    args.push(
      '-crf:v', '28',  // AV1 CRF scale is different
      '-cpu-used', '4', // Speed setting, lower is better quality but slower
      '-row-mt', '1'   // Enable row-based multithreading
    );
  }
  
  return args;
}

module.exports = {
  resolveCodec,
  getEncoderForCodec,
  getPixelFormat,
  getEncoderSpecificArgs,
  hasHardwareSupport,
  detectHardwareEncoders
};
