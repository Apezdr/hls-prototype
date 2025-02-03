// routes/master.js
const express = require('express');
const path = require('path');
var fs = require('fs');
const { getMediaInfo } = require('../utils/ffprobe');
const { VIDEO_SOURCE_DIR, VARIANTS, HLS_OUTPUT_DIR } = require('../config/config');
const { mapCodec, mapLanguage } = require('../utils/audio');
var mime = require('mime-types');
const { ensureVariantInfo } = require('../utils/manifest');
const findVideoFile = require('../utils/findVideoFile');
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

  // Extract video stream info to determine source resolution.
  const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
  if (!videoStream) {
    return res.status(500).send('No video stream found.');
  }
  const sourceWidth = videoStream.width;
  const sourceHeight = videoStream.height;

  // Choose variant set based on source resolution.
  let variantSet = VARIANTS; // default variants from config.
  if (sourceWidth >= 3840) {
    // Source is 4K or higher: offer 4k, 1080p, 720p, and 420p renditions.
    variantSet = [
      { resolution: `${sourceWidth}x${sourceHeight}`, bitrate: '8000k', label: '4k' },
      { resolution: '1920x1080', bitrate: '5000k', label: '1080p' },
      { resolution: '1280x720',  bitrate: '3000k', label: '720p' },
      { resolution: '720x420',   bitrate: '1500k', label: '420p' }
    ];
  }


  // Filter for audio streams.
  const audioStreams = (mediaInfo.streams || []).filter(s => s.codec_type === 'audio');

  let masterPlaylist = '#EXTM3U\n';
  masterPlaylist += '#EXT-X-VERSION:3\n';
  masterPlaylist += '#EXT-X-INDEPENDENT-SEGMENTS\n';

  // Add EXT-X-MEDIA lines for each audio track.
  if (audioStreams.length > 0) {
    audioStreams.forEach((audioStream, index) => {
      let audioName = audioStream.tags.title || `Audio ${index + 1}`;
      let language = audioStream.tags && audioStream.tags.language ? audioStream.tags.language : 'und';
      let mappedLanguage = mapLanguage(language);
      if (audioStream?.channel_layout) {
        audioName = `${audioStream.channel_layout}${language === 'eng' ? '' : ` ${language}`}`;
      }
      const isDefault = index === 0 ? 'YES' : 'NO';
      let codec = audioStream?.profile ? mapCodec({ codec_name: 'aac', profile: audioStream?.profile }) : mapCodec(audioStream);
      if (codec === 'unknown') {
        console.warn(`Unknown audio codec: ${audioStream.codec_name}`);
        return; // Skip this track.
      }
      masterPlaylist += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${audioName}",LANGUAGE="${mappedLanguage}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},CODECS="${codec}",URI="/api/stream/${videoId}/audio/track_${index}/playlist.m3u8"\n`;
    });
  }

  // For each video variant, use the info file if available.
  for (const variant of variantSet) {
    // Set default static values.
    let bitrate = parseInt(variant.bitrate.replace('k', '')) * 1000;
    let resolution = variant.resolution;
    const variantDir = path.join(HLS_OUTPUT_DIR, videoId, variant.label);

    try {
      // Ensure the info file exists and get its data.
      const info = await ensureVariantInfo(videoId, variant, variantDir);
      // Optionally add an overhead (e.g., 10%) to the measured bitrate.
      bitrate = Math.round(info.measuredBitrate * 1.1);
      resolution = `${info.width}x${info.height}`;
    } catch (err) {
      console.error(`Error ensuring variant info for ${variant.label}:`, err);
      // Fall back to static config values.
    }

    masterPlaylist += `#EXT-X-STREAM-INF:BANDWIDTH=${bitrate},RESOLUTION=${resolution},AUDIO="audio"\n`;
    masterPlaylist += `/api/stream/${videoId}/${variant.label}/playlist.m3u8\n`;
  }

  //res.setHeader('Content-Type', mime.lookup('m3u8'));
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Set the header explicitly (without any added charset)
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  // Send the content as a Buffer so Express doesn’t append a charset
  res.send(Buffer.from(masterPlaylist, 'utf8'));
});

module.exports = router;
