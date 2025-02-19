// utils/manifest.js
const fs = require('fs');
const path = require('path');
const { waitForFileStability } = require('./files');
const { getMediaInfo, determineVideoRange, calculateAverageBitrate } = require('./ffprobe');
const { mapCodec } = require('./audio');
const { determineVideoCodec } = require('./rfc');
const { SEGMENTS_TO_ANALYZE } = require('../config/config');

const fsPromises = fs.promises;

/**
 * Ensure that a variant info file exists for a given video variant.
 * If not, wait for the first segment (e.g. "000.ts") to be stable,
 * run ffprobe on it, and write an info.json file in the variant output directory.
 *
 * This function returns an object with properties such as:
 *   - measuredBitrate (in bits per second)
 *   - width and height (of the video)
 *
 * @param {string} videoId - The video identifier.
 * @param {object} variant - The variant configuration object.
 * @param {string} variantOutputDir - The absolute path to the variant's output folder.
 * @returns {Promise<object>} - Resolves with the parsed info object.
 */
async function ensureVideoVariantInfo(videoId, variant, variantOutputDir) {
  const infoFile = path.join(variantOutputDir, 'info.json');

  // Check if the info file exists and can be read.
  try {
    await fsPromises.access(infoFile, fs.constants.F_OK);
    const data = await fsPromises.readFile(infoFile, 'utf8');
    const isDone = await isVariantDone(variantOutputDir);
    const dataJson = JSON.parse(data);
    return {...dataJson, isDone: isDone};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error reading info file, regenerating:', err);
    }
  }

  // Number of segments to use for analysis (default to 1 if not provided)
  const segmentsToAnalyze = parseInt(SEGMENTS_TO_ANALYZE, 10) || 4;
  const segmentFiles = Array.from({ length: segmentsToAnalyze }, (_, i) =>
    path.join(variantOutputDir, i.toString().padStart(3, '0') + ".ts")
  );

  // Wait for all segments to stabilize and get their media info
  const segmentInfos = await Promise.all(
    segmentFiles.map(segmentFile =>
      waitForFileStability(segmentFile, 2000, 600)
        .catch(err => Promise.reject(new Error(`Segment file ${segmentFile} did not stabilize: ${err.message}`)))
        .then(() => getMediaInfo(segmentFile)
          .catch(err => Promise.reject(new Error(`Error running ffprobe on ${segmentFile}: ${err.message}`)))
        )
    )
  );

  // Extract video stream info and determine the highest measured bitrate from the segments
  let maxBitrate = 0;
  let validSegments = 0;
  let videoStreamSample = null; // store the first valid video stream for common properties

  segmentInfos.forEach((segmentInfo, index) => {
    const videoStream = (segmentInfo.streams || []).find(s => s.codec_type === 'video');
    if (!videoStream) {
      console.error(`No video stream found in ${segmentFiles[index]}`);
      return;
    }
    if (!videoStreamSample) {
      videoStreamSample = videoStream;
    }
    let bitRate = videoStream.bit_rate ? parseInt(videoStream.bit_rate, 10) : 0;
    if (!bitRate || isNaN(bitRate) || bitRate === 0) {
      // Fallback to calculating bitrate from file size and duration
      const stats = fs.statSync(segmentFiles[index]);
      const fileSizeBytes = stats.size;
      const duration = parseFloat(videoStream.duration);
      if (duration && duration > 0) {
        bitRate = Math.round((fileSizeBytes * 8) / duration);
      }
    }
    if (bitRate && !isNaN(bitRate)) {
      maxBitrate = Math.max(maxBitrate, bitRate);
      validSegments++;
    }
  });

  if (validSegments === 0) {
    return Promise.reject(new Error(`No valid video bitrate could be determined from segments in ${variantOutputDir}`));
  }

  let adjustedWidth = videoStreamSample.width;
  const adjustedHeight = videoStreamSample.height;

  if (videoStreamSample.display_aspect_ratio && videoStreamSample.display_aspect_ratio !== '0:1') {
    const [num, den] = videoStreamSample.display_aspect_ratio.split(':').map(Number);
    if (den && num) {
      adjustedWidth = Math.round(adjustedHeight * (num / den));
    }
  } else if (videoStreamSample.sample_aspect_ratio && videoStreamSample.sample_aspect_ratio !== '1:1') {
    const [num, den] = videoStreamSample.sample_aspect_ratio.split(':').map(Number);
    if (den && num) {
      adjustedWidth = Math.round(videoStreamSample.width * (num / den));
    }
  }

  // Build the info object using the highest measured bitrate
  const info = {
    measuredBitrate: maxBitrate, // in bits per second
    rfcCodec: determineVideoCodec({ streams: [videoStreamSample] }),
    videoRange: determineVideoRange({ streams: [videoStreamSample] }),
    videoCodec: videoStreamSample ? videoStreamSample.codec_name : 'unknown',
    width: adjustedWidth,
    height: adjustedHeight,
  };

  // Write the variant info file asynchronously.
  try {
    await fsPromises.writeFile(infoFile, JSON.stringify(info, null, 2));
    console.log(`Wrote variant info to ${infoFile}`);
  } catch (err) {
    console.error(`Error writing info file to ${infoFile}:`, err);
  }

  // Rely on new requests to update this based on if the done file exists
  info.isDone = false;

  return Promise.resolve(info);
}

/**
 * Ensure that an audio variant info file exists for a given audio track variant.
 * This function works similarly to ensureVideoVariantInfo, but for audio tracks.
 * It waits for the first audio segment (e.g. "000.ts") to be stable,
 * uses ffprobe to extract key audio parameters, and writes these details to an info file.
 *
 * The returned object will include:
 *   - audioCodec: the codec used in the transcoded audio segments
 *   - channels: number of channels (e.g. 2 for stereo)
 *   - sampleRate: the audio sample rate (e.g. "48000")
 *   - bitRate: measured audio bitrate in bits per second
 *
 * @param {string} videoId - The video identifier.
 * @param {string} audioVariantLabel - The label for the audio variant (e.g., "audio_0").
 * @param {string} audioVariantOutputDir - The absolute path to the audio variant's output folder.
 * @returns {Promise<object>} - Resolves with the parsed audio info object.
 */
async function ensureAudioVariantInfo(videoId, audioVariantLabel, audioVariantOutputDir) {
  const infoFile = path.join(audioVariantOutputDir, 'audio_info.json');

  // If the info file already exists, try to read and parse it.
  try {
    await fsPromises.access(infoFile, fs.constants.F_OK);
    const data = await fsPromises.readFile(infoFile, 'utf8');
    const isDone = await isVariantDone(audioVariantOutputDir);
    const dataJson = JSON.parse(data);
    return {...dataJson, isDone: isDone};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error reading info file, regenerating:', err);
    }
  }

  // Number of segments to use for averaging (default to 4 if not provided)
  const segmentsToAnalyze = parseInt(SEGMENTS_TO_ANALYZE, 10) || 4;
  const segmentFiles = Array.from({ length: segmentsToAnalyze }, (_, i) =>
    path.join(audioVariantOutputDir, i.toString().padStart(3, '0') + ".ts")
  );

  // Wait for all segments to stabilize and get their media info
  const segmentInfos = await Promise.all(
    segmentFiles.map(segmentFile =>
      waitForFileStability(segmentFile, 200, 600)
        .catch(err => Promise.reject(new Error(`Audio segment file ${segmentFile} did not stabilize: ${err.message}`)))
        // Use mediainfo
        .then(() => getMediaInfo(segmentFile, 'mediainfo')
          .catch(err => Promise.reject(new Error(`Error running mediainfo on ${segmentFile}: ${err.message}`)))
        )
    )
  );

  // Extract audio stream info from each segment, fallback to calculating bitrate if needed.
  let maxBitrate = 0;
  let validSegments = 0;
  let audioStreamSample = null; // store the first valid audio stream for common properties
  segmentInfos.forEach((segmentInfo, index) => {
    const generalStream = (segmentInfo?.media?.track || []).find(s => s['@type'] === 'General');
    const audioStream = (segmentInfo.streams || segmentInfo?.media?.track || []).find(s => s.codec_type === 'audio' || s['@type'] === 'Audio');
    if (!audioStream) {
      console.error(`No audio stream found in ${segmentFiles[index]}`);
      return;
    }
    if (!audioStreamSample) {
      audioStreamSample = audioStream;
    }
    let bitRate = generalStream.OverallBitRate ? parseInt(generalStream.OverallBitRate, 10) : 0;
    if (!bitRate || isNaN(bitRate) || bitRate === 0) {
      const stats = fs.statSync(segmentFiles[index]);
      const fileSizeBytes = stats.size;
      const duration = parseFloat(audioStream.Duration);
      if (duration && duration > 0) {
        bitRate = Math.round((fileSizeBytes * 8) / duration);
      }
    }
    if (bitRate && !isNaN(bitRate)) {
      maxBitrate = Math.max(maxBitrate, bitRate);
      validSegments++;
    }
  });

  if (validSegments === 0) {
    return Promise.reject(new Error(`No valid audio bitrate could be determined from segments in ${audioVariantOutputDir}`));
  }

  const averagedBitrate = Math.round(maxBitrate / validSegments);

  // Use first segment's values for other properties.
  let audioCodec = audioStreamSample && audioStreamSample.InternetMediaType ? audioStreamSample.InternetMediaType.replace('audio/','') : audioStreamSample?.Format ? String(audioStreamSample?.Format).toLowerCase() : 'unknown';
  const channels = parseInt((audioStreamSample && audioStreamSample.Channels)) || 2;
  const sampleRate = (audioStreamSample && audioStreamSample.SamplingRate) || "48000";
  const language = (audioStreamSample && audioStreamSample.Language_String3) || 'und';

  let isTrueHD = false;
  // Dolby TrueHD + Dolby Atmos is a special case
  if (audioCodec === 'mlp fba') {
    audioCodec = 'ac3';
    isTrueHD = true;
  }

  const audioInfo = {
    index: parseInt(audioVariantLabel.split('_')[1]),
    audioCodec,
    rfcAudioCodec: mapCodec({codec_name: audioCodec, profile: audioStreamSample?.Format_AdditionalFeatures }),
    channels,
    sampleRate,
    bitRate: averagedBitrate,
    language
  };

  if (isTrueHD) {
    audioInfo.isTrueHD = true;
  }

  // Check for signals that this is Dolby Atmos content
  if (audioStreamSample?.Format_AdditionalFeatures === 'JOC') {
    audioInfo.isAtmos = true;
    audioInfo.additionalFeatures = audioStreamSample.Format_AdditionalFeatures;
    audioInfo.complexity = audioStreamSample.extra.ComplexityIndex;
    audioInfo.dynamicObjects = audioStreamSample.extra.NumberOfDynamicObjects;
  } else {
    audioInfo.isAtmos = false;
  }

  try {
    fs.writeFileSync(infoFile, JSON.stringify(audioInfo, null, 2));
    console.log(`Wrote audio variant info to ${infoFile}`);
  } catch (err) {
    console.error(`Error writing audio info file to ${infoFile}:`, err);
  }

  // Rely on new requests to update this based on if the done file exists
  audioInfo.isDone = false;

  return audioInfo;
}

/**
 * Mark a variant as complete by writing a marker file ("done.txt") in the variant's output directory.
 *
 * @param {string} variantOutputDir - The absolute path to the variant's output folder.
 * @returns {Promise<void>}
 */
async function markVariantDone(variantOutputDir) {
  const doneFile = path.join(variantOutputDir, 'done.txt');
  try {
    await fsPromises.writeFile(doneFile, '', 'utf8');
    console.log(`Variant marked as done: ${doneFile}`);
  } catch (err) {
    console.error(`Error writing done marker to ${doneFile}:`, err);
  }
}

/**
 * Check whether a variant has been marked as complete by looking for the marker file ("done.txt").
 *
 * @param {string} variantOutputDir - The absolute path to the variant's output folder.
 * @returns {Promise<boolean>} - Resolves to true if the marker exists; otherwise, false.
 */
async function isVariantDone(variantOutputDir) {
  const doneFile = path.join(variantOutputDir, 'done.txt');
  try {
    await fsPromises.access(doneFile, fs.constants.F_OK);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { ensureVideoVariantInfo, ensureAudioVariantInfo, markVariantDone, isVariantDone };
