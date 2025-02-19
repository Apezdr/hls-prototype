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

function getEncoderArgs(bitrate, ffmpegProfile = "high", useHardware, fps, sourceLevel, variantForcedSDR) {
  // Determine which encoding mode to use: override or fallback to config value.
  const hardware = typeof useHardware !== "undefined" ? useHardware : (HARDWARE_ENCODING_ENABLED === "true");
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

    args.push(
      '-forced-idr', '1'
    );
    
    return args;
  } else {
    // Software encoding with libx264
    const args = [
      '-c:v', 'libx264',
      //'-preset', 'veryfast',
      '-crf:v', '18',          // Constant Rate Factor: quality-based encoding
      '-maxrate', `${Math.round(bitrateInt * maxrateMultiplier)}k`,
      '-bufsize', `${Math.round(bitrateInt * bufsizeMultiplier)}k`,
      '-profile:v', ffmpegProfile,
      '-rc-lookahead', '120',
      //'-x264-params', `keyint=${gopSize}:closed_gop=1`
      '-force_key_frames', `"expr:if(isnan(prev_forced_n),1,eq(n,prev_forced_n+${gopSize}))"`
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
        `format=yuv420p`;
    } else {
      filterChain =
        `[0:v]format=nv12,` +
        `hwupload_cuda,` +
        `scale_cuda=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
        `hwdownload,format=nv12,` +
        `scale=trunc(iw/2)*2:trunc(ih/2)*2,` + // Force even dimensions
        padFilter +
        (is10bit ? `format=yuv420p` : "");
    }
    return {
      filterType: "filter_complex",
      filter: filterChain,
    };
  } else {
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
        padFilter;
    } else {
      filterChain =
        `[0:v]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,` +
        padFilter +
        (is10bit ? `format=yuv420p` : "");
    }
    return {
      filterType: "vf",
      filter: filterChain,
    };
  }
}

/**
 * Build the final array of FFmpeg arguments for HLS transcoding,
 * switching between GPU or CPU pipelines as needed.
 */
async function buildFfmpegArgs({ videoPath, outputDir, width, height, bitrate, isSubtitles = false, useHardware, variantForcedSDR = false }) {
  const ffprobe_mediaInfo = await getMediaInfo(videoPath);
  const mediaInfo = await getMediaInfo(videoPath, 'mediainfo');
  const { profile: ffmpegProfile, level: sourceLevel, is10bit } = determineFfmpegProfile(ffprobe_mediaInfo);
  const fps = getVideoFps(ffprobe_mediaInfo);
  const encoderArgs = getEncoderArgs(bitrate, ffmpegProfile, useHardware, fps, sourceLevel, variantForcedSDR);
  const peakBrightnessSource = getPeakBrightness(mediaInfo) || 1000;
  const { filterType, filter } = getScalePadFilter(width, height, variantForcedSDR, peakBrightnessSource, is10bit, ffmpegProfile, sourceLevel);
  const gopSize = Math.ceil(HLS_SEGMENT_TIME * fps);

  // Start building the arguments
  const args = [];

  // Optional GPU decode
  if (HWACCEL_DECODING_ENABLED === "true") {
    // For Nvidia
    if (HWACCEL_TYPE === 'cuda') {
        args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'nv12');
    }
    // For Intel QSV
    else if (HWACCEL_TYPE === 'qsv') {
        args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
    }
  }

  // Input file
  args.push("-i", videoPath);

  // Audio handling
  args.push("-an");

  // Encoder-specific arguments
  args.push(...encoderArgs);

  args.push("-f", "hls");

  // General arguments
  args.push("-flags", "+cgop");
  args.push("-g", `${gopSize}`);

  // Attach the filter (either -vf or -filter_complex)
  if (filterType === "vf") {
    args.push("-vf", filter);
  } else {
    args.push("-filter_complex", filter);
  }

  // Keyframe interval & HLS segment config
  //args.push("-g", `${HLS_SEGMENT_TIME * 25}`);
  //args.push("-force_key_frames", `expr:gte(t,n_forced*${HLS_SEGMENT_TIME})`);
  args.push("-sc_threshold", "0");

  // (Optional) Handle Subtitles
  if (!isSubtitles) {
    args.push("-sn");
  }

  // Add output(s) based on HLS_IFRAME_ENABLED
  if (HLS_IFRAME_ENABLED) {
    // First output: Normal HLS variant
    args.push("-hls_list_size", "0");
    args.push("-hls_init_time", `${HLS_SEGMENT_TIME}`);
    args.push("-hls_time", `${HLS_SEGMENT_TIME}`);
    args.push("-hls_segment_type", `mpegts`);
    args.push("-hls_playlist_type", "event");
    args.push("-hls_flags", "append_list+temp_file+independent_segments");
    args.push("-hls_segment_filename", path.join(outputDir, "%03d.ts"));
    args.push(path.join(outputDir, "playlist.m3u8"));

    // Second output: I-frame only variant
    const iframeGopSize = Math.ceil(gopSize / 2);
    args.push("-c:v", "copy");
    args.push("-an");
    args.push("-g", `${iframeGopSize}`);
    args.push("-vsync", "0");
    args.push("-copyts");
    args.push("-hls_list_size", "0");
    args.push("-hls_init_time", `${HLS_SEGMENT_TIME}`);
    args.push("-hls_time", `${HLS_SEGMENT_TIME}`);
    args.push("-hls_segment_type", "fmp4");
    //args.push("-hls_playlist_type", "vod");
    //args.push("-hls_playlist_type", "event");
    args.push("-hls_flags", "iframes_only+single_file+independent_segments");
    args.push("-hls_segment_filename", path.join(outputDir, "iframe_%03d.ts"));
    args.push(path.join(outputDir, "iframe_playlist.m3u8"));
  } else {
    // Only a single output: Normal HLS variant (without i-frame playlist)
    args.push("-hls_list_size", "0");
    args.push("-hls_init_time", `${HLS_SEGMENT_TIME}`);
    args.push("-hls_time", `${HLS_SEGMENT_TIME}`);
    args.push("-hls_segment_type", `mpegts`);
    args.push("-hls_playlist_type", "event");
    args.push("-hls_flags", "append_list+temp_file+independent_segments");
    //args.push("-hls_flags", "append_list+temp_file+split_by_time");
    args.push("-hls_segment_filename", path.join(outputDir, "%03d.ts"));
    args.push(path.join(outputDir, "playlist.m3u8"));
  }

  // args.push('-c:a', 'aac');
  // args.push('-b:a', '128k');

  return args;
}

module.exports = {
  FFMPEG_PATH,
  buildFfmpegArgs,
};
