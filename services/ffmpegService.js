// services/ffmpegService.js
const path = require('path');
const { spawn } = require('child_process');
const {
  HLS_OUTPUT_DIR,
  FFMPEG_PATH,
  HLS_SEGMENT_TIME,
  HARDWARE_ENCODING_ENABLED,
  SEGMENTS_TO_ANALYZE,
  WEB_SUPPORTED_CODECS,
  VIDEO_SOURCE_DIR,
  HLS_IFRAME_ENABLED,
} = require('../config/config');
const { ensureDir, waitForFileStability, safeFilename } = require('../utils/files');
const { getAudioChannelCount, getAudioCodec, getAudioFilterArgs } = require('../utils/audio');
const { getMediaInfo, getVideoFps, detectHdrType } = require('../utils/ffprobe');
const { buildFfmpegArgs } = require('./ffmpegUtils');
const { ensureVideoVariantInfo, ensureAudioVariantInfo, markVariantDone } = require('../utils/manifest');
const { acquireSlot } = require('./hardwareTranscoderLimiter');
const { isSessionActive, createSessionLock, updateSessionLock } = require('./sessionManager');
const findVideoFile = require('../utils/findVideoFile');

/**
 * Start transcoding a video into HLS segments for a specific variant.
 * After FFmpeg starts producing segments, we wait for the first segment (e.g. "000.ts")
 * to stabilize, run FFprobe on it, and write an info file with measured values.
 */
async function startTranscoding(videoPath, videoId, variant) {
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variant.label);
  await ensureDir(outputDir);

  // Parse the intended width and height
  const [w, h] = variant.resolution.split('x');
  const hdrType = detectHdrType(await getMediaInfo(videoPath, 'ffprobe'));
  // detectHdrType could return: "SDR", "HDR10", "HLG", "DolbyVision", etc.
  const isSourceHDR = hdrType !== 'SDR';

  // If the user’s variant config says "force SDR," 
  // then actually force SDR only if the source is HDR.
  const variantForcedSDR = variant.isSDR && isSourceHDR;

  let useHardware = false;
  if (HARDWARE_ENCODING_ENABLED === "true") {
    // If hardware encoding is enabled in config, try to acquire a slot.
    if (await acquireSlot()) {
      useHardware = true;
      console.log("Hardware slot acquired, using hardware encoding.");
    } else {
      console.log("Hardware slot unavailable. Falling back to CPU encoding.");
    }
  }

  // Build the complete set of FFmpeg arguments in one place
  const args = await buildFfmpegArgs({
    videoPath,
    outputDir,
    width: w,
    height: h,
    bitrate: variant.bitrate,
    useHardware,
    variantForcedSDR,
  });

  console.log(`Starting FFmpeg for variant ${variant.label} with arguments:\n${args.join(' ')}`);

  // Spawn FFmpeg
  const ffmpeg = spawn(FFMPEG_PATH, args);

  ffmpeg.stderr.on('data', (data) => {
    console.log(`FFmpeg (${variant.label} ${useHardware ? "gpu" : "cpu"}) stderr: ${data}`);
  });

  ffmpeg.on('close', async (code) => {
    if (code === 0) {
      console.log(`FFmpeg video process for ${variant.label} completed successfully.`);
      await markVariantDone(outputDir);
    } else {
      console.log(`FFmpeg video process for ${variant.label} exited with code ${code}`);
    }
  });

  // Wait for the first segment file to stabilize, then gather info
  const segmentFile = path.join(outputDir, '000.ts');
  waitForFileStability(segmentFile, 200, 600)
    .then(() => getMediaInfo(segmentFile))
    .then(async (segmentInfo) => {
      const videoStream = (segmentInfo.streams || []).find(s => s.codec_type === 'video');
      if (!videoStream) {
        throw new Error('No video stream found in segment.');
      }
      await ensureVideoVariantInfo(videoId, variant, outputDir);
    })
    .catch((err) => {
      console.error(`Error generating variant info for ${variant.label}:`, err);
    });
}

async function startAudioTranscoding(videoPath, videoId, audioTrackIndex, audioVariantLabel, requested_codec) {
    const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariantLabel);
    await ensureDir(outputDir);
  
    let channels;
    let originalAudioCodec; 
    try {
        // Get the number of channels
        channels = await getAudioChannelCount(videoPath, audioTrackIndex);
        console.log(`Audio track ${audioTrackIndex} has ${channels} channel(s).`);

        // Get the audio codec
        originalAudioCodec = await getAudioCodec(videoPath, audioTrackIndex);
        console.log(`Audio track ${audioTrackIndex} has codec ${originalAudioCodec}.`); 
    } catch (err) {
        console.error("Error retrieving channel/codec information, defaulting to stereo AAC:", err);
        channels = 2;
        originalAudioCodec = 'aac';
    }
  
    // Determine the audio channel option.
    // We preserve the channel count if >2.
    const aacProfile = 'LC'; // Or 'HE-AAC', 'HE-AACv2' - CHOOSE ONE
  
    // Calculate the desired bit rate based on the channel count.
    // (These values are just examples—adjust as needed.)
    let bitRate;
    if (channels > 2) {
        bitRate = aacProfile === 'HE-AACv2' ? '192k' : (aacProfile === 'HE-AAC' ? '128k' : '384k'); // Adjust for profile and channels
    } else {
        bitRate = aacProfile === 'HE-AACv2' ? '64k' : (aacProfile === 'HE-AAC' ? '64k' : '128k'); // Adjust for profile
    }

    // Decide whether to copy the audio stream or transcode.
    // 1. If a requested codec is provided and it exactly matches the original,
    //    simply copy the stream to avoid quality loss.
    // 2. Also, if the original codec is one of the special types (e.g., TrueHD/AC3/EAC3),
    //    we prefer to copy.
    // 3. Otherwise, if transcoding is needed, use the requested codec if it is supported,
    //    or default to 'aac'.
    let audioCodecArg;
    let filterArgs = [];

    if (requested_codec && requested_codec.toLowerCase() === originalAudioCodec.toLowerCase()) {
      // The requested codec matches the source codec, so let's avoid double-transcoding
      // and simply copy the audio.
      console.log("Requested codec matches the source codec. Copying audio track.");
      audioCodecArg = 'copy';
      filterArgs = [];
    } else {
      // We want to transcode if the user requests a codec that differs from the source.
      // Check if it's in our supported codec list; otherwise, fallback to AAC.
      if (requested_codec && WEB_SUPPORTED_CODECS.includes(requested_codec.toLowerCase())) {
        audioCodecArg = requested_codec.toLowerCase();
        console.log(`Transcoding audio track to requested codec: ${audioCodecArg}.`);
      } else {
        audioCodecArg = 'aac';
        if (requested_codec) {
          console.log(`Requested codec "${requested_codec}" not supported; falling back to AAC.`);
        } else {
          console.log("No requested codec provided; using default AAC transcoding.");
        }
      }
      // Only apply filters and set bit rate when transcoding
      filterArgs = getAudioFilterArgs(channels, true);
    }

    const ffprobe_mediaInfo = await getMediaInfo(videoPath);
    const fps = getVideoFps(ffprobe_mediaInfo);
    const gopSize = Math.ceil(HLS_SEGMENT_TIME * fps); // frames per GOP e.g., 4s * 30fps = 120 frames

    // codecOpts can include audioChannelOption, filterArgs, etc.
    let codecOpts = [];
    let audioChannelOption = [
      // Use the selected channel count
      '-ac', channels.toString(),
      // Use the selected AAC profile
      //'-profile:a', aacProfile
    ];
    if (originalAudioCodec === 'truehd') {
      console.log("Detected TrueHD. Transcoding to AC-3 for reliable web playback (cannot rely on AC-3 core).");
      
      // Force AC-3 transcoding:
      audioCodecArg = 'ac3';
      
      // Use the actual channel count from the TrueHD source, but keep in mind
      // many AC-3 decoders only support up to 5.1 (6 channels). If your TrueHD
      // track has 7.1, you may want to do something like:
      //   channels = Math.min(channels, 6);
      // or logic for 7.1 if your pipeline supports E-AC3. But let's assume 5.1 is typical:
      if (channels > 6) {
          channels = 6;
      }

      bitRate = '640k';
      // For AC-3, a common bitrate is 640k for 5.1:
      audioChannelOption = [
        '-ac', channels.toString(),
      ]
    }

    if (audioCodecArg === 'copy') {
      codecOpts = [];
    } else {
      codecOpts = [
        ...audioChannelOption,
        '-b:a', bitRate,
        ...filterArgs,
      ];
    }

    const hlsFlags = 
      "append_list+temp_file" + (HLS_IFRAME_ENABLED ? "+independent_segments" : "+split_by_time");
  
    const args = [
      '-i', videoPath,
      // Map the requested audio track (0-based index)
      '-map', `0:a:${audioTrackIndex}`,
      '-c:a', audioCodecArg,
      ...codecOpts,
      '-f', 'hls',
      '-hls_list_size', '0',
      "-hls_init_time", `${HLS_SEGMENT_TIME}`,
      //'-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_TIME})`,
      '-hls_time', `${HLS_SEGMENT_TIME}`,
      '-hls_segment_type', 'mpegts',
      '-hls_playlist_type', 'event',
      '-flags', '+cgop',
      '-g', `${gopSize}`,
      '-sc_threshold', '0',
      '-hls_playlist_type', 'event',
      // You can remove '+temp_file' for audio if needed
      '-hls_flags', hlsFlags,
      '-hls_segment_filename', path.join(outputDir, '%03d.ts'),
      path.join(outputDir, 'playlist.m3u8')
    ];
  
    console.log(`Starting FFmpeg audio transcoding for ${audioVariantLabel} with args:`);
    console.log(args.join(' '));
  
    const ffmpeg = spawn(FFMPEG_PATH, args);

    ffmpeg.stderr.on('data', (data) => {
      console.log(`FFmpeg audio (${audioVariantLabel}) stderr: ${data}`);
    });
  
    ffmpeg.on('close', async (code) => {
      if (code === 0) {
        console.log(`FFmpeg audio process for ${audioVariantLabel} completed successfully.`);
        await markVariantDone(outputDir);
      } else {
        console.log(`FFmpeg audio process for ${audioVariantLabel} exited with code ${code}`);
      }
    });

    const segmentFile = path.join(outputDir, '000.ts');
    await waitForFileStability(segmentFile, 200, 9999)
      .then(() => getMediaInfo(segmentFile))
      .then(async (segmentInfo) => {
        const audioStream = (segmentInfo.streams || []).find(s => s.codec_type === 'audio');
        if (!audioStream) {
          throw new Error('No audio stream found in segment.');
        }
        await ensureAudioVariantInfo(videoId, audioVariantLabel, outputDir)
      })
      .catch((err) => {
        console.error(`Error generating variant info for ${audioVariantLabel}:`, err);
      });
}

/**
 * Start transcoding audio for a given track as stereo.
 * This function forces the output audio to be stereo regardless of the source.
 *
 * @param {string} videoPath - The source video file.
 * @param {string} videoId - The video identifier.
 * @param {string} audioVariantLabel - The label for this audio variant (e.g., "stereo").
 */
async function startStereoAudioTranscoding(videoPath, videoId, audioVariantLabel) {
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariantLabel);
  await ensureDir(outputDir);
  
  // Force stereo output.
  const channels = 2;
  const aacProfile = 'LC'; // Use AAC-LC.
  const audioChannelOption = [
    '-ac', channels.toString()
  ];
  
  // Choose an appropriate bitrate for stereo.
  const bitRate = '128k';

  // Always apply loudnorm for forced stereo, if that’s your goal:
  const filterArgs = getAudioFilterArgs(channels, true);

  const hlsFlags = 
      "append_list+temp_file" + (HLS_IFRAME_ENABLED ? "+independent_segments" : "+split_by_time");
  
  const args = [
    '-i', videoPath,
    // Map the first audio track (0-based index) from the source.
    '-map', '0:a:0',
    '-c:a', 'aac',
    ...audioChannelOption,
    '-b:a', bitRate,
    ...filterArgs,
    '-flags', '+cgop',
    '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_TIME})`,
    '-hls_time', `${HLS_SEGMENT_TIME}`,
    '-hls_playlist_type', 'event',
    '-hls_flags', hlsFlags,
    '-hls_segment_filename', path.join(outputDir, '%03d.ts'),
    path.join(outputDir, 'playlist.m3u8')
  ];
  
  console.log(`Starting FFmpeg stereo audio transcoding for ${audioVariantLabel} with args:`);
  console.log(args.join(' '));
  
  const ffmpeg = spawn(FFMPEG_PATH, args);
  
  ffmpeg.stderr.on('data', (data) => {
    console.log(`FFmpeg stereo audio (${audioVariantLabel}) stderr: ${data}`);
  });
  
  ffmpeg.on('close', async (code) => {
    if (code === 0) {
      console.log(`FFmpeg audio process for ${audioVariantLabel} completed successfully.`);
      await markVariantDone(outputDir);
    } else {
      console.log(`FFmpeg audio process for ${audioVariantLabel} exited with code ${code}`);
    }
  });
  
  const segmentFile = path.join(outputDir, '000.ts');
  await waitForFileStability(segmentFile, 200, 9999)
    .then(() => getMediaInfo(segmentFile))
    .then(async (segmentInfo) => {
      const audioStream = (segmentInfo.streams || []).find(s => s.codec_type === 'audio');
      if (!audioStream) {
        throw new Error('No audio stream found in segment.');
      }
      await ensureAudioVariantInfo(videoId, audioVariantLabel, outputDir)
    })
    .catch((err) => {
      console.error(`Error generating variant info for ${audioVariantLabel}:`, err);
    });
}

/**
 * Handles the audio transcoding session process for a specific video/audio variant.
 *
 * This asynchronous function verifies whether an audio transcoding session is already active
 * for the specified video and audio variant. If a session is not active, it creates a session lock,
 * retrieves the video file path, and initiates the audio transcoding process for the provided track index and codec.
 * If a session is active, it simply updates the session lock.
 *
 * @async
 * @function handleAudioTranscodingSession
 * @param {string} videoId - The unique identifier for the video.
 * @param {string} audioVariantLabel - The label representing the audio variant.
 * @param {number} i - The index of the specific audio track or step in the process.
 * @param {string} codecName - The name of the codec to use for transcoding.
 * @param {string} [type=null] - The type of audio transcoding process to start (e.g., "stereo").
 * @returns {Promise<void>} A promise that resolves when the audio transcoding session handling is complete.
 * @throws {Error} Logs an error to the console if the audio transcoding process fails.
 */
async function handleAudioTranscodingSession(videoId, audioVariantLabel, i, codecName, type = null) {
  try {
    if (!await isSessionActive(videoId, audioVariantLabel)) {
      await createSessionLock(videoId, audioVariantLabel);
      const videoPath = await findVideoFile(videoId, VIDEO_SOURCE_DIR);
      if (type === "stereo") {
        await startStereoAudioTranscoding(videoPath, videoId, audioVariantLabel);
      } else {
        await startAudioTranscoding(videoPath, videoId, i, audioVariantLabel, codecName);
      }
    } else {
      await updateSessionLock(videoId, audioVariantLabel);
    }
  } catch (err) {
    console.error(`Error starting audio transcoding for track "${audioVariantLabel}" + id:${i} in master playlist step:`, err);
  }
}

/**
 * Handles the video transcoding session process for a specific video/audio variant.
 *
 * This asynchronous function verifies whether an video transcoding session is already active
 * for the specified video and audio variant. If a session is not active, it creates a session lock,
 * retrieves the video file path, and initiates the audio transcoding process for the provided track index and codec.
 * If a session is active, it simply updates the session lock.
 *
 * @async
 * @function handleVideoTranscodingSession
 * @param {string} videoId - The unique identifier for the video.
 * @param {string} variant - The video variant information. ex: { resolution: '1280x720', bitrate: '2500k', label: '720p' isSDR: true }
 * @param {string} videoPath - The path to the video file.
 * @returns {Promise<void>} A promise that resolves when the audio transcoding session handling is complete.
 * @throws {Error} Logs an error to the console if the audio transcoding process fails.
 */
async function handleVideoTranscodingSession(videoId, variant, videoPath) {
  try {
    if (!await isSessionActive(videoId, variant.label)) {
      await createSessionLock(videoId, variant.label);
      startTranscoding(videoPath, videoId, variant);
    } else {
      await updateSessionLock(videoId, variant.label);
    }
  } catch (err) {
    console.error(`Error starting video transcoding for track "${variant?.label ?? 'Invalid Variant'}" in master playlist step:`, err);
  }
}

module.exports = { startTranscoding, startAudioTranscoding, startStereoAudioTranscoding, handleAudioTranscodingSession, handleVideoTranscodingSession };
