// services/ffmpegService.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  HLS_OUTPUT_DIR,
  FFMPEG_PATH,
  HLS_SEGMENT_TIME,
} = require('../config/config');
const { ensureDir, waitForFileStability } = require('../utils/files');
const { getAudioChannelCount, getAudioCodec } = require('../utils/audio');
const { getMediaInfo } = require('../utils/ffprobe');

/**
 * Start transcoding a video into HLS segments for a specific variant.
 * After FFmpeg starts producing segments, we wait for the first segment (e.g. "000.ts")
 * to stabilize, run FFprobe on it, and write an info file with measured values.
 */
function startTranscoding(videoPath, videoId, variant) {
  const outputDir = path.join(HLS_OUTPUT_DIR, videoId, variant.label);
  ensureDir(outputDir);

  // Parse the intended width and height:
  const [w, h] = variant.resolution.split('x');
  // Build a filter chain that scales down (if needed) and pads the result:
  const scalePadFilter = `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;

  // Build the FFmpeg arguments.
  const args = [
    '-i', videoPath,
    '-c:v', 'libx264',
    '-b:v', variant.bitrate,
    //'-vf', `scale=${variant.resolution}`,
    '-vf', scalePadFilter,
    '-preset', 'veryfast',
    // Disable audio track
    '-an',
    //'-c:a', 'aac',
    //'-b:a', '128k',
    '-g', `${HLS_SEGMENT_TIME * 25}`, // assumes ~25 fps
    '-sc_threshold', '0',
    '-hls_time', `${HLS_SEGMENT_TIME}`,
    '-hls_playlist_type', 'event',
    // Use the temp_file flag to ensure that only complete segments are served.
    '-hls_flags', 'independent_segments+append_list+temp_file',
    '-hls_segment_filename', path.join(outputDir, '%03d.ts'),
    path.join(outputDir, 'playlist.m3u8')
  ];

  console.log(`Starting FFmpeg for variant ${variant.label} with arguments:\n${args.join(' ')}`);

  const ffmpeg = spawn(FFMPEG_PATH, args);

  ffmpeg.stderr.on('data', (data) => {
    console.log(`FFmpeg (${variant.label}) stderr: ${data}`);
  });

  ffmpeg.on('close', (code) => {
    console.log(`FFmpeg process for ${variant.label} exited with code ${code}`);
  });

  // Now, once FFmpeg is running, attempt to generate the info file.
  const segmentFile = path.join(outputDir, '000.ts');
  waitForFileStability(segmentFile, 200, 10)
    .then(() => {
      // Use FFprobe on the segment file to extract measurements.
      return getMediaInfo(segmentFile);
    })
    .then((segmentInfo) => {
      // Find the video stream in the segment.
      const videoStream = (segmentInfo.streams || []).find(s => s.codec_type === 'video');
      if (!videoStream) {
        throw new Error('No video stream found in segment.');
      }
      // For example, extract the measured bitrate (as provided by ffprobe) and resolution.
      // (Depending on your FFprobe output, you might need to adjust which fields you use.)
      const measuredBitrate = videoStream.bit_rate || 0;
      const width = videoStream.width;
      const height = videoStream.height;

      const info = {
        measuredBitrate: parseInt(measuredBitrate, 10),
        width,
        height
      };

      const infoFile = path.join(outputDir, 'info.json');
      fs.writeFileSync(infoFile, JSON.stringify(info, null, 2));
      console.log(`Wrote variant info to ${infoFile}`);
    })
    .catch((err) => {
      console.error(`Error generating variant info for ${variant.label}:`, err);
    });
}

async function startAudioTranscoding(videoPath, videoId, audioTrackIndex, audioVariantLabel) {
    const outputDir = path.join(HLS_OUTPUT_DIR, videoId, audioVariantLabel);
    ensureDir(outputDir);
  
    let channels;
    let codec; 
    try {
        // Get the number of channels
        channels = await getAudioChannelCount(videoPath, audioTrackIndex);
        console.log(`Audio track ${audioTrackIndex} has ${channels} channel(s).`);

        // Get the audio codec
        codec = await getAudioCodec(videoPath, audioTrackIndex);
        console.log(`Audio track ${audioTrackIndex} has codec ${codec}.`); 
    } catch (err) {
        console.error("Error retrieving channel/codec information, defaulting to stereo AAC:", err);
        channels = 2;
        codec = 'aac';
    }
  
    // Determine the audio channel option.
    // We preserve the channel count if >2.
    const aacProfile = 'LC'; // Or 'HE-AAC', 'HE-AACv2' - CHOOSE ONE
    const audioChannelOption = [
        // Use the selected channel count
        '-ac', channels.toString(),
        // Use the selected AAC profile
        //'-profile:a', aacProfile
    ];
  
    // Set a higher bit rate for multi-channel (surround) audio.
    let bitRate;
    if (channels > 2) {
        bitRate = aacProfile === 'HE-AACv2' ? '192k' : (aacProfile === 'HE-AAC' ? '128k' : '384k'); // Adjust for profile and channels
    } else {
        bitRate = aacProfile === 'HE-AACv2' ? '64k' : (aacProfile === 'HE-AAC' ? '64k' : '128k'); // Adjust for profile
    }
  
    const args = [
      '-i', videoPath,
      // Map the requested audio track (0-based index)
      '-map', `0:a:${audioTrackIndex}`,
      '-c:a', 'aac',
      ...audioChannelOption,
      '-b:a', bitRate,
      '-hls_time', `${HLS_SEGMENT_TIME}`,
      '-hls_playlist_type', 'event',
      // You can remove '+temp_file' for audio if needed
      '-hls_flags', 'independent_segments+append_list+temp_file',
      '-hls_segment_filename', path.join(outputDir, '%03d.ts'),
      path.join(outputDir, 'playlist.m3u8')
    ];
  
    console.log(`Starting FFmpeg audio transcoding for ${audioVariantLabel} with args:`);
    console.log(args.join(' '));
  
    const ffmpeg = spawn(FFMPEG_PATH, args);
  
    ffmpeg.stderr.on('data', (data) => {
      console.log(`FFmpeg audio (${audioVariantLabel}) stderr: ${data}`);
    });
  
    ffmpeg.on('close', (code) => {
      console.log(`FFmpeg audio process for ${audioVariantLabel} exited with code ${code}`);
    });
}
  

module.exports = { startTranscoding, startAudioTranscoding };
