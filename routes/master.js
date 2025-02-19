// routes/master.js
const express = require('express');
const path = require('path');
const { getMediaInfo, parseFrameRate } = require('../utils/ffprobe');
const { VIDEO_SOURCE_DIR, VARIANTS, HLS_OUTPUT_DIR, WEB_SUPPORTED_CODECS, HLS_IFRAME_ENABLED } = require('../config/config');
const mime = require('mime-types');
const { ensureAudioVariantInfo } = require('../utils/manifest');
const findVideoFile = require('../utils/findVideoFile');
const { safeFilename } = require('../utils/files');
const { handleAudioTranscodingSession } = require('../services/ffmpegService');
const { generateVideoVariantTags, generateAudioMediaTags, buildAudioGroupKey, collectAudioGroups } = require('../utils/master');
const { mapCodec } = require('../utils/audio');
// For transcoded output, we assume our video transcoder produces H.264.
const defaultVideoCodec = "avc1.64001F"; // H.264 High Profile, Level 3.1
// We want AAC-LC for audio.
const defaultAudioCodec = "mp4a.40.2";
const router = express.Router();

router.get('/api/stream/:id/master.m3u8', async (req, res) => {
  const videoId = req.params.id;
  const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);

  let mediaInfo;
  try {
    mediaInfo = await getMediaInfo(videoPath);
  } catch (error) {
    console.error('Error probing media:', error);
    return res.status(500).send('Error reading media info.');
  }

  const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
  if (!videoStream) {
    return res.status(500).send('No video stream found.');
  }
  const sourceWidth = videoStream.width;
  const sourceHeight = videoStream.height;
  const frameRate = parseFrameRate(videoStream.avg_frame_rate) || '23.976';

  // --- Audio Handling: Gather transcoded audio info for each track ---
  const sourceAudioStreams = (mediaInfo.streams || []).filter(s => s.codec_type === 'audio');
  let audioInfoList = [];
  let audioCodecGroups = {};

  for (let i = 0; i < sourceAudioStreams.length; i++) {
    let codecName = sourceAudioStreams[i].codec_name;

    if (codecName === 'truehd') {
      codecName = 'ac3'; // Use AC3 for TrueHD
    }
    let audioVariantLabel = `audio_${i}_${codecName}`;
    const audioOutputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariantLabel);

    // Start or update transcoding session
    await handleAudioTranscodingSession(videoId, audioVariantLabel, i, codecName, null);

    // Use promise chaining for ensureAudioVariantInfo
    await ensureAudioVariantInfo(videoId, audioVariantLabel, audioOutputDir)
      .then(async (audioInfo) => {
        const codec = (audioInfo.audioCodec && audioInfo.audioCodec !== 'unknown')
        ? audioInfo.audioCodec
        : defaultAudioCodec;
        const channels = audioInfo.channels || sourceAudioStreams[i].channels;
        
        audioInfoList.push({
          index: i,
          codec: codec,
          rfcAudioCodec: audioInfo.rfcAudioCodec,
          channels: channels,
          ...audioInfo
        });
        const groupKey = buildAudioGroupKey(audioInfo.rfcAudioCodec, channels, audioInfo.isAtmos, audioInfo.language, audioInfo.audioCodec);
        if (!audioCodecGroups[groupKey]) {
          audioCodecGroups[groupKey] = {
            groupKey,
            codec: audioInfo.rfcAudioCodec,
            channels: audioInfo.channels || sourceAudioStreams[i].channels
          };
        }
        // Add an additional audio group for AC-3 fallback
        if (audioInfo.isAtmos) {
          const ac3rfcAudioCodec = mapCodec({ codec_name: "ac3", profile: null })
          const atmosGroupKey = buildAudioGroupKey(ac3rfcAudioCodec, 6, false, audioInfo.language, "ac3");
          if (!audioCodecGroups[atmosGroupKey]) {
            audioCodecGroups[atmosGroupKey] = {
              groupKey: atmosGroupKey,
              codec: ac3rfcAudioCodec,
              channels: audioInfo.channels || sourceAudioStreams[i].channels
            };
          }
        }
        if (
          !WEB_SUPPORTED_CODECS.includes(audioInfo.audioCodec.toLowerCase()) &&
          audioInfo.isAtmos === false
        ) {
          // AAC fallback for non-web supported codecs
          const aacGroupKey = buildAudioGroupKey(defaultAudioCodec, audioInfo.channels, false, audioInfo.language, 'aac');
          if (!audioCodecGroups[aacGroupKey]) {
            audioCodecGroups[aacGroupKey] = {
              groupKey: aacGroupKey,
              codec: defaultAudioCodec,
              channels: audioInfo.channels || sourceAudioStreams[i].channels
            };
          }
        }
        if (audioInfo.audioCodec === "eac3") {
          // AAC fallback for E-AC3
          const aacGroupKey = buildAudioGroupKey(defaultAudioCodec, audioInfo.channels, false, audioInfo.language, 'aac');
          if (!audioCodecGroups[aacGroupKey]) {
            audioCodecGroups[aacGroupKey] = {
              groupKey: aacGroupKey,
              codec: defaultAudioCodec,
              channels: 2
            };
          }
          await handleAudioTranscodingSession(
            videoId,
            `audio_${audioInfo.index}_ac3`,
            audioInfo.index,
            "ac3",
            null
          );
          // Insert an extra entry into audioInfoList for the AC-3 fallback.
          // Note: We use a modified index (as a string) so that when sorting,
          // the fallback appears immediately after the native track.
          audioInfoList.push({
            index: `${audioInfo.index}_ac3`, // so it sorts immediately after the native track
            codec: "ac3",
            rfcAudioCodec: mapCodec({ codec_name: "ac3", profile: null }),
            channels: channels,
            language: audioInfo.language,
            measuredBitrate: audioInfo.measuredBitrate || 640000,
            isFallback: true,
            audioCodec: "ac3"
          });

        }
      })
      .catch((err) => {
        console.error(`Error ensuring audio variant info for track ${i}:`, err);
        const channels = sourceAudioStreams[i].channels || 2;
        const language = sourceAudioStreams[i].tags?.language || 'und';
        audioInfoList.push({
          index: i,
          codec: "aac", // Assume AAC if we can't determine the codec
          rfcAudioCodec: defaultAudioCodec,
          channels: channels,
          measuredBitrate: 128000, // Assume 128 kbps if we can't determine the bitrate
          // language: 'und'
          isAtmos: false,
          isTrueHD: false,
          additionalFeatures: false,
          complexity: false,
          dynamicObjects: false,
          audioCodec: 'aac'
        });
        const groupKey = buildAudioGroupKey(defaultAudioCodec, channels, false, language, 'aac');
        if (!audioCodecGroups[groupKey]) {
          audioCodecGroups[groupKey] = {
            groupKey,
            codec: defaultAudioCodec,
            channels: channels
          };
        }
      });
  }

  // Check if any of the transcoded audio tracks is stereo (2 channels)
  const stereoExists = audioInfoList.some(info => info.channels === 2);
  if (!stereoExists) {
    // If no stereo track exists, add a new audio rendition entry for stereo.
    // This will be produced by a dedicated stereo transcoding process.
    audioInfoList.unshift({
      index: 'stereo',          // use a reserved index string for stereo track
      codec: 'aac',             // we know our forced stereo will be AAC-LC
      rfcAudioCodec: defaultAudioCodec,
      channels: 2,
      language: sourceAudioStreams[0]?.tags?.language,
      measuredBitrate: 128000, // Assume 128 kbps if we can't determine the bitrate
      isAtmos: false,
      isTrueHD: false,
      additionalFeatures: false,
      complexity: false,
      dynamicObjects: false,
      audioCodec: 'aac'
    });
    const groupKey = buildAudioGroupKey(defaultAudioCodec, 2, false, sourceAudioStreams[0]?.tags?.language, 'aac');
    if (!audioCodecGroups[groupKey]) {
      audioCodecGroups[groupKey] = {
        groupKey,
        codec: defaultAudioCodec,
        channels: 2
      };
    }
  }

  // For the CODECS attribute in EXT-X-STREAM-INF, choose the audio codec from the first track.
  // (You could also decide to use the stereo track if it was just added.)
  const finalAudioCodec = audioInfoList[0].rfcAudioCodec;
  const combinedCodecs = `${defaultVideoCodec},${finalAudioCodec}`;
  // const uniqueAudioCodecs = new Set();
  // audioInfoList.forEach(audioInfo => {
  //   if (audioInfo.rfcAudioCodec && audioInfo.rfcAudioCodec !== defaultAudioCodec) { // Exclude default AAC if other codecs exist. Or remove condition to always include default AAC
  //     uniqueAudioCodecs.add(audioInfo.rfcAudioCodec);
  //   } else if (audioInfo.rfcAudioCodec === defaultAudioCodec && uniqueAudioCodecs.size === 0) {
  //     uniqueAudioCodecs.add(defaultAudioCodec); // Ensure AAC is included if no other codecs are found
  //   }
  // });
  // const allAudioCodecsString = Array.from(uniqueAudioCodecs).join(',');
  // const combinedCodecs = `${defaultVideoCodec}${allAudioCodecsString ? ',' : ''}${allAudioCodecsString}`;

  // --- Determine Variant Set ---
  let variantSet = VARIANTS;
  // If the source video is 4K, add a custom "4k" variant.
  if (sourceWidth >= 3840) {
    variantSet = [
      { resolution: `${sourceWidth}x${sourceHeight}`, bitrate: '15000k', label: '4k', isSDR: false },
      ...VARIANTS
    ];
  }

  let masterPlaylist = '#EXTM3U\n';
  masterPlaylist += '#EXT-X-VERSION:3\n';
  //if (HLS_IFRAME_ENABLED) {
  //  masterPlaylist += '#EXT-X-INDEPENDENT-SEGMENTS\n';
  //}
  masterPlaylist += '#EXT-X-START:TIME-OFFSET=0\n';
  //masterPlaylist += `#EXT-X-TARGETDURATION=${process.env.HLS_SEGMENT_TIME || 5}\n`; // HLS segment duration

  masterPlaylist += '\n\n#Audio Groups\n';

  let isDone = [];
  const audioGroups = collectAudioGroups(audioInfoList, videoId, isDone);
  // --- Build EXT-X-MEDIA Tags for Audio ---
  masterPlaylist += await generateAudioMediaTags(audioGroups);

  // Determine the highest audio bitrate for your entire audio group
  const maxAudioBitrate = Math.max(...audioInfoList.map(a => a.measuredBitrate || a.bitrate || a.bitRate || 0));

  if (!maxAudioBitrate) {
    console.error('No audio bitrates found; using default audio bitrate.');
  }

  masterPlaylist += '\n\n#Video + audio variants\n';
  // --- Build EXT-X-STREAM-INF Tags for Video Variants ---
  masterPlaylist += await generateVideoVariantTags(
    variantSet,
    videoId,
    maxAudioBitrate,
    defaultVideoCodec,
    frameRate,
    audioGroups,
    isDone
  );

  if (!isDone.includes(false)) {
    // Replace URI's with parameter to force VOD playlist type
    masterPlaylist = masterPlaylist.replace(/(playlist(?:.*?)\.m3u8)/g, '$1?playlistType=VOD');
  }

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', mime.lookup('m3u8'));
  res.setHeader('Content-Disposition', 'inline');
  res.send(Buffer.from(masterPlaylist, 'utf8'));
});

module.exports = router;
