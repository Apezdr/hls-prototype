// ffmpegUtils.js
const path = require("path");
const {
  HLS_SEGMENT_TIME,
  FFMPEG_PATH,
  HARDWARE_ENCODING_ENABLED,
  HWACCEL_DECODING_ENABLED,
  HWACCEL_TYPE,
  HLS_IFRAME_ENABLED,
} = require("../config/config");
const { determineFfmpegProfile, getMediaInfo, getVideoFps } = require("../utils/ffprobe");
const { getPeakBrightness } = require("../utils/mediainfo");
const { getOptimalGopSize, getOptimalSegmentDuration } = require("../utils/gopUtils");
const { resolveCodec } = require("../utils/codecSelection");

function getEncoderArgs(bitrate, ffmpegProfile = "high", useHardware, fps, sourceLevel, variantForcedSDR, gopSize, is10bit = false, resolvedCodec = 'h264') {
  // Determine which encoding mode to use: override or fallback to config value,
  // but always use software for 10-bit content since NVENC doesn't support it
  let hardware = typeof useHardware !== "undefined" ? useHardware : (HARDWARE_ENCODING_ENABLED === "true");
  
  // Force software encoding for 10-bit content
  if (is10bit) {
    console.log("Source is 10-bit content, forcing software encoding");
    hardware = false;
  }
  // Parse the bitrate value (e.g., "3000k") into a number.
  // Here we assume that `bitrate` is a string ending with "k" (kilobits per second).
  const bitrateInt = parseInt(bitrate.replace('k', ''), 10);
  
  // Enhanced buffer settings for smoother transitions between segments
  // Increased buffer size helps prevent stuttering at segment transitions
  const maxrateMultiplier = 1.5;  // 50% higher than target (was 1.1)
  const bufsizeMultiplier = 3;    // 3× the target bitrate (was 2)
  
  if (hardware) {
    // For NVIDIA hardware encoding, choose encoder based on the resolved codec
    let encoderName = 'h264_nvenc'; // Default hardware encoder
    
    // Select appropriate hardware encoder based on codec
    if (resolvedCodec === 'hevc') {
      encoderName = 'hevc_nvenc';
      console.log("Using HEVC hardware encoder for 4K content");
    } else if (resolvedCodec === 'av1') {
      encoderName = 'av1_nvenc';
      console.log("Using AV1 hardware encoder");
    }
    
    // For NVIDIA hardware encoding, we need to adapt profile settings
    // If the source is HDR ("high10") or not forcing SDR, use appropriate profile
    const gpuProfile = (ffmpegProfile === "high10" || !variantForcedSDR) ? "high" : ffmpegProfile;

    const args = [
      '-c:v', encoderName,
      '-preset', 'medium',         // slower preset for better quality
      '-rc:v', 'vbr_hq',
      '-cq', '23',
      '-b:v', bitrate,         // nominal target bitrate
      '-maxrate', `${Math.round(bitrateInt * maxrateMultiplier)}k`, // limit the peak bitrate
      '-bufsize', `${Math.round(bitrateInt * bufsizeMultiplier)}k`,   // set the VBV buffer size
      '-profile:v', gpuProfile,
    ];

    // Conditionally cap level at 5.0 if source level > 50
    if (sourceLevel && sourceLevel > 50) {
      args.push("-level:v", variantForcedSDR ? "5.0" : "5.1");
    }

    // Remove -forced-idr 1, rely on -force_key_frames
    // args.push(
    //   '-forced-idr', '1'
    // );
    
    return args;
  } else {
    // Select appropriate software encoder based on the resolved codec
    let encoderName = 'libx264'; // Default software encoder
    let crf = '18';
    
    if (resolvedCodec === 'hevc') {
      encoderName = 'libx265';
      crf = '22'; // x265 uses a different CRF scale than x264
      console.log("Using HEVC software encoder (libx265) for 10-bit content");
    } else if (resolvedCodec === 'av1') {
      encoderName = 'libsvtav1'; // or 'libaom-av1' but libsvtav1 is faster
      crf = '28'; // AV1 uses a different CRF scale
      console.log("Using AV1 software encoder (libsvtav1)");
    }
    
    // For 10-bit content, force high10 profile regardless of input profile
    // This only applies to h264, hevc has its own profile system
    const softwareProfile = (encoderName === 'libx264' && is10bit) ? 'high10' : ffmpegProfile;
    
    const args = [
      '-c:v', encoderName,
      //'-preset', 'veryfast',
      '-crf:v', crf,          // Constant Rate Factor: quality-based encoding
      '-maxrate', `${Math.round(bitrateInt * maxrateMultiplier)}k`,
      '-bufsize', `${Math.round(bitrateInt * bufsizeMultiplier)}k`,
    ];
    
    // Only add profile for h264, as other codecs have different profile systems
    if (encoderName === 'libx264') {
      args.push('-profile:v', softwareProfile);
      args.push('-rc-lookahead', '120');
    } else if (encoderName === 'libx265') {
      // x265 specific params
      args.push('-x265-params', 'rc-lookahead=120');
    }
    
    //'-x264-params', `keyint=${gopSize}`,
    // Removed here, will be added only once in buildFfmpegArgs
    // Alternatively, if you wish to use constant bitrate (CBR):
    // return ["-c:v", "libx264", "-preset", "ultrafast", "-b:v", bitrate, "-maxrate", `${Math.round(bitrateInt * maxrateMultiplier)}k`, "-bufsize", `${Math.round(bitrateInt * bufsizeMultiplier)}k`];
    // Conditionally cap level at 5.0 if source level > 50
    if (sourceLevel && sourceLevel > 50) {
      args.push("-level:v", variantForcedSDR ? "5.0" : "5.1");
    }
    return args;
  }
}

/**
 * FFMPEG
 * Generates the appropriate filter string(s) for scaling + padding,
 * optionally including HDR to SDR conversion.
 * Uses `scale_cuda` + CPU-based `pad` if hardware encoding is enabled.
 */
function getScalePadFilter(width, height, variantForcedSDR = false, peak = 1000, is10bit = false, ffmpegProfile, sourceLevel, resolvedCodec) {
  if (HARDWARE_ENCODING_ENABLED === "true") {
    let filterChain;
    // Check if one or both dimensions are dynamic (i.e. set to "-1")
    const dynamicResize = (width === '-1' || height === '-1');

    // Only apply padding if both dimensions are fixed
    const padFilter = dynamicResize ? "" : `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,`;

    if (variantForcedSDR) {
      filterChain =
        `[0:v]format=nv12,` +
        `hwupload_cuda,` +
        `scale_cuda=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
        `hwdownload,format=nv12,` +       // hwdownload outputs NV12
        `scale=trunc(iw/2)*2:trunc(ih/2)*2,` + // Force even dimensions
        padFilter +
        `format=gbrpf32le,` +             // Convert to high‑precision format
        // Convert to linear light (assumes input is PQ, though without explicit PQ conversion)
        `zscale=transfer=linear,` +
        // Apply tone mapping (without out_transfer option)
        `tonemap=mobius:desat=0:peak=${peak},` +
        // Convert from linear to BT.709 transfer using zscale
        `zscale=transfer=bt709,` +
        `format=yuv420p[outv]`;           // Add output label to prevent double stream
    } else {
      filterChain =
        `[0:v]format=nv12,` +
        `hwupload_cuda,` +
        `scale_cuda=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
        `hwdownload,format=nv12,` +
        `scale=trunc(iw/2)*2:trunc(ih/2)*2,` + // Force even dimensions
        padFilter +
        (is10bit && resolvedCodec === 'hevc' ? `format=yuv420p10le` : is10bit ? `format=yuv420p` : "") + 
        `[outv]`;                          // Add output label to prevent double stream
    }
    return {
      filterType: "filter_complex",
      filter: filterChain,
      outputLabel: "[outv]"  // Return output label for mapping
    };
  } else {
    // For simple filters, we'll switch to filter_complex for consistency
    const dynamicResize = (width === '-1' || height === '-1');
    const padFilter = dynamicResize ? "" : `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,`;

    let filterChain;
    if (variantForcedSDR) {
      filterChain =
        `[0:v]format=gbrpf32le,` +
        `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
        `zscale=transfer=linear,` +
        `tonemap=mobius:desat=0:peak=${peak},` +
        `zscale=transfer=bt709,` +
        `format=yuv420p,` +
        padFilter +
        `[outv]`;                          // Add output label to prevent double stream
    } else {
      // For 10-bit content, we need to maintain 10-bit yuv420p10le format for high10 profile and HEVC
      if (is10bit) {
        // Specifically for HEVC, make sure to use 10-bit format for HDR preservation
        if (resolvedCodec === 'hevc') {
          filterChain = `[0:v]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
                        padFilter +
                        `format=yuv420p10le[outv]`;  // Explicitly preserve 10-bit color depth
        } else {
          // For h264 high10 profile 
          filterChain = `[0:v]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
                        padFilter +
                        `[outv]`;          // Without explicit format filter
        }
      } else {
        // Standard 8-bit processing
        filterChain = `[0:v]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
                      padFilter +
                      `[outv]`;            // Add output label to prevent double stream
      }
    }
    
    // Always use filter_complex for consistent handling
    return {
      filterType: "filter_complex",
      filter: filterChain,
      outputLabel: "[outv]"  // Return output label for mapping
    };
  }
}

/**
 * Build the final array of FFmpeg arguments for HLS transcoding,
 * switching between GPU or CPU pipelines as needed.
 * @param {Object} options - Configuration options
 * @param {string} options.videoPath - Path to source video
 * @param {string} options.outputDir - Output directory
 * @param {string|number} options.width - Width for scaling
 * @param {string|number} options.height - Height for scaling
 * @param {string} options.bitrate - Target bitrate
 * @param {boolean} [options.isSubtitles=false] - Include subtitles
 * @param {boolean} [options.useHardware] - Use hardware encoding
 * @param {boolean} [options.variantForcedSDR=false] - Force SDR output
 * @param {string} [options.muxer="hls"] - Output muxer (hls or segment) - **NOTE: Now defaults to 'hls' for the new approach**
 * @param {string} [options.outputPlaylistPath] - Custom playlist path (FFmpeg managed)
 * @param {number} [options.startNumber] - Start segment number
 * @param {string} [options.keyframeTimestamps] - Expression for force_key_frames (expr:... format)
 * @returns {Promise<Array>} FFmpeg arguments
 */
/**
 * Get source video resolution from media info
 * @param {Object} mediaInfo - Media info object from ffprobe
 * @returns {Object} - { width, height } of source video
 */
function getSourceResolution(mediaInfo) {
  const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
  if (!videoStream) {
    return { width: 1920, height: 1080 }; // Default to 1080p if not found
  }
  
  return {
    width: parseInt(videoStream.width) || 1920,
    height: parseInt(videoStream.height) || 1080
  };
}

/**
 * Check if variant resolution matches source (within tolerance)
 * @param {number} sourceWidth - Source video width 
 * @param {number} sourceHeight - Source video height
 * @param {string|number} variantWidth - Variant width (could be -1 for auto)
 * @param {string|number} variantHeight - Variant height
 * @returns {boolean} - True if this variant should use copy mode
 */
function shouldUseCopyMode(sourceWidth, sourceHeight, variantWidth, variantHeight) {
  // Parse variant dimensions, handling -1 for auto scaling
  const vWidth = parseInt(variantWidth);
  const vHeight = parseInt(variantHeight);
  
  // If variant uses auto scaling for width (-1)
  if (vWidth === -1) {
    // Check if target height is within 90% of source height
    return vHeight >= sourceHeight * 0.9;
  }
  
  // If variant uses auto scaling for height (-1)
  if (vHeight === -1) {
    // Check if target width is within 90% of source width
    return vWidth >= sourceWidth * 0.9;
  }
  
  // If both dimensions are specified, check if both are close to source
  const widthRatio = vWidth / sourceWidth;
  const heightRatio = vHeight / sourceHeight;
  
  // Consider a match if both dimensions are at least 90% of source
  return widthRatio >= 0.9 && heightRatio >= 0.9;
}

async function buildFfmpegArgs({
  videoPath,
  outputDir,
  width,
  height,
  bitrate,
  isSubtitles = false,
  useHardware,
  variantForcedSDR = false,
  muxer = "hls", // Defaulting to HLS muxer now
  outputPlaylistPath = null, // Path where FFmpeg will write its playlist
  startNumber = 0,
  keyframeTimestamps = null, // New parameter for exact keyframe placement
  useCopyMode = false, // Allow explicit override of copy mode
  variant = null // Full variant object for codec selection
}) {
  debugger; // this shouldn't run
  const ffprobe_mediaInfo = await getMediaInfo(videoPath);
  const mediaInfo = await getMediaInfo(videoPath, 'mediainfo');
  const { profile: ffmpegProfile, level: sourceLevel, is10bit } = determineFfmpegProfile(ffprobe_mediaInfo);
  const fps = getVideoFps(ffprobe_mediaInfo);
  
  // Check for codec selection from variant
  let codecStrategy = 'h264'; // Default codec
  if (variant && variant.codec) {
    codecStrategy = variant.codec;
    console.log(`Variant ${variant.label} specifies codec strategy: ${codecStrategy}`);
  }
  
  // Resolve the codec strategy to an actual codec
  let resolvedCodec = 'h264';
  try {
    resolvedCodec = await resolveCodec(codecStrategy, ffprobe_mediaInfo, variant);
    console.log(`Resolved codec for ${variant?.label || 'unknown'}: ${resolvedCodec} (from strategy: ${codecStrategy})`);
    
    // If the resolved codec is 'copy', set useCopyMode to true
    if (resolvedCodec === 'copy') {
      useCopyMode = true;
    }
  } catch (err) {
    console.error(`Error resolving codec: ${err.message}, defaulting to h264`);
  }
  
  // Calculate GOP size for perfect segment alignment with AAC audio frames
  const gopSize = await getOptimalGopSize(videoPath, HLS_SEGMENT_TIME);
  const segmentDuration = await getOptimalSegmentDuration(videoPath, HLS_SEGMENT_TIME);
  const encoderArgs = getEncoderArgs(bitrate, ffmpegProfile, useHardware, fps, sourceLevel, variantForcedSDR, gopSize, is10bit, resolvedCodec);
  const peakBrightnessSource = getPeakBrightness(mediaInfo) || 1000;
  const { filterType, filter, outputLabel } = getScalePadFilter(width, height, variantForcedSDR, peakBrightnessSource, is10bit, ffmpegProfile, sourceLevel, resolvedCodec);

  // Get source resolution to check if we should use copy mode
  const sourceRes = getSourceResolution(ffprobe_mediaInfo);
  
  // Determine if we should use copy mode for this variant
  // Either explicitly requested or automatically detected
  const shouldCopy = useCopyMode || shouldUseCopyMode(sourceRes.width, sourceRes.height, width, height);
  
  // Can't copy if we need to convert HDR -> SDR
  // Also disable copy if user explicitly forces using encoding
  const canCopy = shouldCopy && !variantForcedSDR && useCopyMode !== false;
  
  if (canCopy) {
    console.log(`Using copy mode for variant width=${width}, height=${height} (source: ${sourceRes.width}x${sourceRes.height})`);
  }
  
  // Start building the arguments
  const args = [];

  // --- Input Options ---
  // Only use hardware decode if we're not copying (since copy doesn't need decode acceleration)
  if (!canCopy && HWACCEL_DECODING_ENABLED === "true") {
    if (HWACCEL_TYPE === 'cuda') {
      args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'nv12');
    } else if (HWACCEL_TYPE === 'qsv') {
      args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
    }
  }
  
  // Add -copyts and avoid_negative_ts before input for consistent timestamp handling
  args.push('-copyts', '-avoid_negative_ts', 'disabled', '-start_at_zero');
  
  // Add seek parameter BEFORE input if starting from non-zero segment
  if (startNumber > 0) {
    const seekTime = startNumber * segmentDuration;
    console.log(`Seeking to segment ${startNumber} (${seekTime.toFixed(3)}s)`);
    args.push('-ss', seekTime.toString());
  }
  
  // Input file
  args.push("-i", videoPath);

  // --- Stream Mapping & Filtering ---
  // Subtitle handling
  if (!isSubtitles) {
    args.push("-sn");
  }
  
  // Audio handling (assuming video-only for now, audio will be separate)
  args.push("-an");
  
  if (canCopy) {
    // When copying source, use direct stream mapping
    args.push('-map', '0:v:0');
    
    // Use copy codec instead of encoding
    args.push('-c:v', 'copy');
    
    // Add -start_at_zero for copy mode to reset timestamps at segment boundaries
    args.push('-start_at_zero');
    
    // Add HEVC/HVC1 tag when using HEVC codec for better compatibility
    if (resolvedCodec === 'hevc') {
      args.push("-tag:v", "hvc1");
    }

  } else {
  // If not copying, use filters and encoding
    args.push("-filter_complex", filter);
    
    // Map the filter output instead of the input directly
    args.push('-map', outputLabel);
    
    // For 10-bit content, explicitly set pixel format that supports high10 profile
    if (is10bit) {
      args.push("-pix_fmt", "yuv420p10le");
    }

    // Add HEVC/HVC1 tag when using HEVC codec for better compatibility
    if (resolvedCodec === 'hevc') {
      args.push("-tag:v", "hvc1");
    }

    // Add reset timestamp parameter for all encoding modes to ensure each segment starts at 0
    args.push("-start_at_zero");

    // --- Encoding Options ---
    args.push(...encoderArgs); // Includes codec, preset, bitrate, profile, etc.
    args.push("-g", `${gopSize}`); // GOP size
    
    // Re-enable x264/x265 params for closed GOPs and keyframe alignment
    if (resolvedCodec === 'h264') {
      args.push('-x264-params', `keyint=${gopSize}`);
    } else if (resolvedCodec === 'hevc') {
      args.push('-x265-params', `keyint=${gopSize}:closed_gop=1`);
    }
  }
  
  // Use exact keyframe timestamps if provided, otherwise calculate based on segment duration
  if (keyframeTimestamps) {
    // Use exact timestamps for perfect alignment across variants
    args.push("-force_key_frames", keyframeTimestamps);
  } else {
    // Fallback to expression-based keyframes at regular intervals
    args.push("-force_key_frames", `expr:gte(t,n_forced*${segmentDuration})`);
  }
  
  args.push("-sc_threshold", "0"); // Disable scene change detection for keyframes

  // --- Output Options (HLS Muxer) ---
  args.push("-f", "hls");
  // Add -copyts for output too
  //args.push("-copyts");
  // Use the calculated segment duration for perfect alignment with AAC audio frames
  args.push("-hls_time", `${segmentDuration.toFixed(6)}`);
  args.push("-hls_playlist_type", "vod"); // Set to VOD
  
  // If HEVC codec is used, set segment type to fMP4, otherwise use MPEG-TS
  // HEVC requires fMP4 for standards compliance
  if (resolvedCodec === 'hevc') {
    args.push("-hls_segment_type", "fmp4");
    // fMP4 needs initialization segment - use full path in output directory
    args.push("-hls_fmp4_init_filename", path.join(outputDir, "init.mp4"));
  } else {
    args.push("-hls_segment_type", "mpegts");
  }
  
  args.push("-hls_flags", "independent_segments"); // Keep segments independent
  // Set start number if specified
  if (startNumber > 0) {
    args.push("-start_number", startNumber.toString());
  }
  // Define segment filename pattern based on codec
  // HEVC uses .m4s extension for fMP4 segments
  if (resolvedCodec === 'hevc') {
    args.push("-hls_segment_filename", path.join(outputDir, "%03d.m4s"));
  } else {
    args.push("-hls_segment_filename", path.join(outputDir, "%03d.ts"));
  }
  // Define the output playlist path (FFmpeg managed)
  args.push(outputPlaylistPath || path.join(outputDir, "ffmpeg_playlist.m3u8"));

  // args.push('-c:a', 'aac');
  // args.push('-b:a', '128k');

  return args;
}

/**
 * Build FFmpeg arguments for transcoding a single segment with explicit offsets
 */
async function buildExplicitSegmentFfmpegArgs({
  videoPath,
  outputPath,
  startTime,
  duration,
  width,
  height,
  bitrate,
  useHardware,
  variantForcedSDR = false,
  variant,
  keyframeTimestamps = null,
}) {
  // Start with common input options
  const args = [];
  
  // Get codec and encoding details (same as existing function)
  const ffprobe_mediaInfo = await getMediaInfo(videoPath);
  const mediaInfo = await getMediaInfo(videoPath, 'mediainfo');
  // Set options/settings used in the encoding process
  const { profile: ffmpegProfile, level: sourceLevel, is10bit } = determineFfmpegProfile(ffprobe_mediaInfo);
  const fps = getVideoFps(ffprobe_mediaInfo);
  const gopSize = Math.ceil(duration * fps); // Use segment duration for GOP size
  const peakBrightnessSource = getPeakBrightness(mediaInfo) || 1000;

  // Resolve codec
  let resolvedCodec = 'h264';
  if (variant && variant.codec) {
    try {
      resolvedCodec = await resolveCodec(variant.codec, ffprobe_mediaInfo, variant);
    } catch (err) {
      console.error(`Error resolving codec: ${err.message}, defaulting to h264`);
    }
  }
  
  // Hardware acceleration if needed
  if (HWACCEL_DECODING_ENABLED === "true") {
    if (HWACCEL_TYPE === 'cuda') {
      args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'nv12');
    } else if (HWACCEL_TYPE === 'qsv') {
      args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
    }
  }
  
  // Critical timestamp handling sequence for precise segments (following Jellyfin)
  args.push(
    //'-copyts',
    '-avoid_negative_ts',
    'disabled',
    '-start_at_zero'
  );
  
  // Explicit start time from parameters (BEFORE input file)
  args.push('-ss', startTime.toString());
  
  // Input file
  args.push('-i', videoPath);
  
  // Explicit duration limit
  args.push('-t', duration.toString());
  
  // Add force keyframes for reliable segment boundaries
  //args.push('-force_key_frames', 'expr:gte(t,0)');

  
  const encoderArgs = getEncoderArgs(bitrate, ffmpegProfile, useHardware, fps, sourceLevel, variantForcedSDR, gopSize, is10bit, resolvedCodec);

  const { filterType, filter, outputLabel } = getScalePadFilter(
    width, height, variantForcedSDR, peakBrightnessSource, is10bit, ffmpegProfile, sourceLevel, resolvedCodec
  );
  
  // Add filters
  args.push("-filter_complex", filter);
  args.push('-map', outputLabel);
  
  // Maintain advanced encoding options
  args.push(...encoderArgs);
  
  args.push("-g", `${gopSize}`); // GOP size
  args.push("-sc_threshold", "0"); // Disable scene change detection for keyframes
  
  if (keyframeTimestamps) {
    // Use exact timestamps for perfect alignment across variants
    args.push("-force_key_frames", keyframeTimestamps);
  } else {
    // Fallback to expression-based keyframes at regular intervals
    args.push("-force_key_frames", `expr:gte(t,n_forced*${segmentDuration})`);
  }

  // Re-enable x264/x265 params for closed GOPs and keyframe alignment
  if (resolvedCodec === 'h264') {
    args.push('-x264-params', `keyint=${gopSize}`);
  } else if (resolvedCodec === 'hevc') {
    args.push('-x265-params', `keyint=${gopSize}:closed_gop=1`);
  }

  // Audio and subtitle handling - disable them
  args.push("-an", "-sn");
  
  // Format & output path
  if (resolvedCodec === 'hevc') {
    args.push('-f', 'mp4');
    args.push("-tag:v", "hvc1");
  } else {
    args.push('-f', 'mpegts');
  }
  
  args.push(outputPath);
  
  return args;
}

module.exports = {
  FFMPEG_PATH,
  buildFfmpegArgs,
  buildExplicitSegmentFfmpegArgs
};
