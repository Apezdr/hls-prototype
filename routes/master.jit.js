// routes/master.jit.js
const express = require('express');
const path = require('path');
const { getMediaInfo, parseFrameRate } = require('../utils/ffprobe');
const {
  VIDEO_SOURCE_DIR,
  VARIANTS,
  HLS_OUTPUT_DIR,
  WEB_SUPPORTED_CODECS,
  JIT_TRANSCODING_ENABLED
} = require('../config/config');
const mime = require('mime-types');
const findVideoFile = require('../utils/findVideoFile');
const { safeFilename } = require('../utils/files');
const { mapCodec } = require('../utils/audio');
const { buildAudioGroupKey } = require('../utils/master');

// For transcoded output, we assume H.264.
const defaultVideoCodec = "avc1.64001F";
// We want AAC-LC for web‐friendly audio.
const defaultAudioCodec = "mp4a.40.2";

const router = express.Router();

router.get('/api/stream/:id/master.m3u8', async (req, res) => {
  if (!JIT_TRANSCODING_ENABLED) {
    return res.status(500).send('JIT transcoding is disabled');
  }

  const videoId = req.params.id;
  // 1) locate
  const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);
  if (!videoPath) return res.status(404).send('Video not found');

  // 2) probe
  let mediaInfo;
  try {
    mediaInfo = await getMediaInfo(videoPath);
  } catch (err) {
    console.error('ffprobe error:', err);
    return res.status(500).send('Error reading media info');
  }

  // 3) stream info
  const videoStream = mediaInfo.streams.find(s => s.codec_type === 'video');
  if (!videoStream) return res.status(500).send('No video stream');
  const sourceWidth  = videoStream.width;
  const sourceHeight = videoStream.height;
  const frameRate = parseFrameRate(videoStream.avg_frame_rate) || '23.976';

  // 4) audio streams
  const sourceAudioStreams = mediaInfo.streams.filter(s => s.codec_type === 'audio');
  const { audioGroups } = createPredictedAudioInfo(sourceAudioStreams);

  // 5) build variants
  let variantSet = VARIANTS;
  if (sourceWidth >= 3840) {
    variantSet = [
      { resolution: `${sourceWidth}x${sourceHeight}`, bitrate: '15000k', label: '4k', isSDR: false },
      ...VARIANTS
    ];
  }

  // 6) generate
  const masterPlaylist = generateJitMasterPlaylist(
    videoId,
    variantSet,
    frameRate,
    { audioGroups }
  );

  // 7) respond
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', mime.lookup('m3u8') || 'application/vnd.apple.mpegurl');
  return res.send(masterPlaylist);
});


function createPredictedAudioInfo(sourceAudioStreams) {
  const fullGroupId = 'audio-eng-full';
  const aacGroupId  = 'audio-eng-aac';
  const audioGroups = {
    [fullGroupId]: { id: fullGroupId, tracks: [] },
    [aacGroupId]:  { id: aacGroupId,  tracks: [] }
  };

  sourceAudioStreams.forEach((stream, i) => {
    const channels = stream.channels || 2;
    const lang     = stream.tags?.language || 'und';
    let codecName  = stream.codec_name === 'truehd' ? 'ac3' : stream.codec_name;

    // base track
    const base = {
      index: i,
      language: lang,
      channels,
      codec: codecName,
      rfcAudioCodec: mapCodec({ codec_name: codecName, profile: stream.profile }),
      variantLabel: `audio/track_${i}_${codecName}`
    };
    audioGroups[fullGroupId].tracks.push(base);

    // AAC fallback
    audioGroups[aacGroupId].tracks.push({
      ...base,
      codec: 'aac',
      rfcAudioCodec: defaultAudioCodec,
      variantLabel: `audio/track_${i}_aac`
    });

    // EAC3 → AC3 fallback in full group
    if (codecName === 'eac3') {
      const ac3 = {
        ...base,
        codec: 'ac3',
        rfcAudioCodec: mapCodec({ codec_name: 'ac3', profile: null }),
        variantLabel: `audio/track_${i}_ac3`
      };
      audioGroups[fullGroupId].tracks.push(ac3);

      // and AAC fallback for AC3 in AAC group
      audioGroups[aacGroupId].tracks.push({
        ...base,
        codec: 'aac',
        rfcAudioCodec: defaultAudioCodec,
        variantLabel: `audio/track_${i}_ac3_aac`
      });
    }
  });

  return { audioGroups };
}


function generateJitMasterPlaylist(videoId, variantSet, frameRate, { audioGroups }) {
  let p = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-START:TIME-OFFSET=0\n';

  // audio groups
  p += '\n\n#Audio Groups\n';
  Object.values(audioGroups).forEach(group => {
    p += `\n# Audio Group: ${group.id}\n`;
    group.tracks.forEach(track => {
      const name = track.channels > 2
        ? `ENG ${track.channels}.1${track.codec==='eac3'?' (Dolby Digital Plus)':''}`
        : 'ENG Stereo';

      const chAttr = track.channels > 2
        ? `CHANNELS="${track.channels}"`
        : 'CHANNELS="2"';

      p += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${group.id}",NAME="${name}",` +
           `LANGUAGE="${track.language}",DEFAULT=NO,AUTOSELECT=NO,` +
           `CODECS="${track.rfcAudioCodec}",${chAttr},` +
           `URI="/api/stream/${videoId}/${track.variantLabel}/playlist.m3u8"\n`;
    });
  });

  // video variants
  p += '\n\n#Video + audio variants\n';
  const audioBitrate = 128000;
  Object.keys(audioGroups).forEach(groupId => {
    variantSet.forEach(variant => {
      const [w,h] = variant.resolution.split('x').map(Number);
      const vbr = parseInt(variant.bitrate,10)*1000;
      const bw  = vbr + audioBitrate;
      const avg = Math.floor(bw * 0.833);
      const vr  = variant.isSDR ? 'SDR' : 'PQ';
      const codecs = [ defaultVideoCodec ]
        .concat(
          // unique audio codecs in this group:
          [ ...new Set(audioGroups[groupId].tracks.map(t=>t.rfcAudioCodec)) ]
        ).join(',');

      // a tiny score tweak so “full” always sorts before “aac”
      const score = (w*h*1e-6 + vbr*1e-8) + (groupId==='audio-eng-full'?0.1:0);

      p += `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${avg},` +
           `RESOLUTION=${w}x${h},FRAME-RATE=${frameRate},` +
           `CODECS="${codecs}",AUDIO="${groupId}",VIDEO-RANGE=${vr},` +
           `SCORE=${score.toFixed(2)},CLOSED-CAPTIONS=NONE\n`;

      // ◀─ here, ALWAYS call the plain playlist.m3u8
      p += `/api/stream/${videoId}/${variant.label}/playlist_${groupId}.m3u8\n`;
    });
  });

  return p;
}

module.exports = router;
