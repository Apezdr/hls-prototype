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

function getEncoderArgs(bitrate, ffmpegProfile = "high", useHardware, fps, sourceLevel, variantForcedSDR, gopSize, is10bit = false) {
  // Determine which encoding mode to use: override or fallback to config value,
  // but always use software for 10-bit content since NVENC doesn't support it
  let hardware = typeof useHardware !== "undefined" ? useHardware : (HARDWARE_ENCODING_ENABLED === "true");
  
  // Force software encoding for 10-bit content
  if (is10bit) {
    console.log("Source is 10-bit content, forcing software encoding with libx264");
    hardware = false;
  }
  // Parse the bitrate value (e.g., "3000k") into a number.
  // Here we assume that `bitrate` is a string ending with "k" (kilobits per second).
  const bitrateInt = parseInt(bitrate.replace('k', ''), 10);
  // Define maxrate multiplier and bufsize multiplier
  const maxrateMultiplier = 1.1;  // 10% higher than target
  const bufsizeMultiplier = 2;    // 2× the target bitrate
  
  if (hardware) {
    // For NVIDIA hardware encoding (h264_nvenc), even if the source is HDR ("high10"),
    // we must use an SDR-compatible profile. Also, if the output is explicitly SDR,
    // then force the profile to "high".
    const gpuProfile = (ffmpegProfile === "high10" || !variantForcedSDR) ? "high" : ffmpegProfile;

    const args = [
      '-c:v', 'h264_nvenc',
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
    // Software encoding with libx264
    // For 10-bit content, force high10 profile regardless of input profile
    const softwareProfile = is10bit ? 'high10' : ffmpegProfile;
    
    const args = [
      '-c:v', 'libx264',
      //'-preset', 'veryfast',
      '-crf:v', '18',          // Constant Rate Factor: quality-based encoding
      '-maxrate', `${Math.round(bitrateInt * maxrateMultiplier)}k`,
      '-bufsize', `${Math.round(bitrateInt * bufsizeMultiplier)}k`,
      '-profile:v', softwareProfile,
      '-rc-lookahead', '120',
      //'-x264-params', `keyint=${gopSize}:closed_gop=1`,
      // Removed here, will be added only once in buildFfmpegArgs
    ];
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
function getScalePadFilter(width, height, variantForcedSDR = false, peak = 1000, is10bit = false, ffmpegProfile, sourceLevel) {
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
        (is10bit ? `format=yuv420p` : "") + 
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
      // For 10-bit content, we need to maintain 10-bit yuv420p10le format for high10 profile
      filterChain = is10bit ?
        `[0:v]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
        padFilter +
        `[outv]` :                         // Add output label to prevent double stream
        `[0:v]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
        padFilter +
        `[outv]`;                          // Add output label to prevent double stream
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
 * @returns {Promise<Array>} FFmpeg arguments
 */
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
  startNumber = 0
}) {
  const ffprobe_mediaInfo = await getMediaInfo(videoPath);
  const mediaInfo = await getMediaInfo(videoPath, 'mediainfo');
  const { profile: ffmpegProfile, level: sourceLevel, is10bit } = determineFfmpegProfile(ffprobe_mediaInfo);
  const fps = getVideoFps(ffprobe_mediaInfo);
  // Calculate GOP size for perfect segment alignment with AAC audio frames
  const gopSize = await getOptimalGopSize(videoPath, HLS_SEGMENT_TIME);
  const segmentDuration = await getOptimalSegmentDuration(videoPath, HLS_SEGMENT_TIME);
  const encoderArgs = getEncoderArgs(bitrate, ffmpegProfile, useHardware, fps, sourceLevel, variantForcedSDR, gopSize, is10bit);
  const peakBrightnessSource = getPeakBrightness(mediaInfo) || 1000;
  const { filterType, filter, outputLabel } = getScalePadFilter(width, height, variantForcedSDR, peakBrightnessSource, is10bit, ffmpegProfile, sourceLevel);

  // Start building the arguments
  const args = [];

  // --- Input Options ---
  // Optional GPU decode
  if (HWACCEL_DECODING_ENABLED === "true") {
    if (HWACCEL_TYPE === 'cuda') {
      args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'nv12');
    } else if (HWACCEL_TYPE === 'qsv') {
      args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
    }
  }
  
  // Add -copyts before input for consistent timestamp handling
  args.push('-copyts');
  
  // Input file (seek time -ss will be added before this in startTranscoding...)
  args.push("-i", videoPath);

  // --- Stream Mapping & Filtering ---
  // Subtitle handling
  if (!isSubtitles) {
    args.push("-sn");
  }
  
  // Audio handling (assuming video-only for now, audio will be separate)
  args.push("-an");
  
  // We need filters especially for 10-bit HDR content
  args.push("-filter_complex", filter);
  
  // Map the filter output instead of the input directly
  // This prevents duplicate streams
  args.push('-map', outputLabel);
  
  // For 10-bit content, explicitly set pixel format that supports high10 profile
  if (is10bit) {
    args.push("-pix_fmt", "yuv420p10le");
  }

  // --- Encoding Options ---
  args.push(...encoderArgs); // Includes codec, preset, bitrate, profile, etc.
  args.push("-g", `${gopSize}`); // GOP size
  // Only add force_key_frames here (it was removed from encoder args)
  // Use the calculated segment duration for keyframe placement too
  args.push("-force_key_frames", `expr:gte(t,n_forced*${segmentDuration})`);
  args.push("-sc_threshold", "0"); // Disable scene change detection for keyframes

  // --- Output Options (HLS Muxer) ---
  args.push("-f", "hls");
  // Add -copyts for output too
  args.push("-copyts");
  // Use the calculated segment duration for perfect alignment with AAC audio frames
  args.push("-hls_time", `${segmentDuration.toFixed(6)}`);
  args.push("-hls_playlist_type", "vod"); // Set to VOD
  args.push("-hls_segment_type", "mpegts");
  args.push("-hls_flags", "independent_segments"); // Keep segments independent
  // Set start number if specified
  if (startNumber > 0) {
    args.push("-start_number", startNumber.toString());
  }
  // Define segment filename pattern
  args.push("-hls_segment_filename", path.join(outputDir, "%03d.ts"));
  // Define the output playlist path (FFmpeg managed)
  args.push(outputPlaylistPath || path.join(outputDir, "ffmpeg_playlist.m3u8"));

  // args.push('-c:a', 'aac');
  // args.push('-b:a', '128k');

  return args;
}

module.exports = {
  FFMPEG_PATH,
  buildFfmpegArgs,
};
