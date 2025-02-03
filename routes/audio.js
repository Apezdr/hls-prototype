// routes/audio.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { startAudioTranscoding } = require('../services/ffmpegService');
const { isSessionActive, createSessionLock, updateSessionLock } = require('../services/sessionManager');
const { VIDEO_SOURCE_DIR, HLS_OUTPUT_DIR } = require('../config/config');
var mime = require('mime-types');
const findVideoFile = require('../utils/findVideoFile');
const router = express.Router();

// Audio playlist route: e.g. /api/stream/:id/audio/track_:track/playlist.m3u8
router.get('/api/stream/:id/audio/track_:track/playlist.m3u8', async (req, res) => {
  const videoId = req.params.id;
  const trackId = req.params.track; // e.g. "0"
  const audioVariantLabel = `audio_${trackId}`;
  const outputDir = path.join(HLS_OUTPUT_DIR, videoId, audioVariantLabel);
  const playlistPath = path.join(outputDir, 'playlist.m3u8');

  console.log(`[Audio Playlist] Request for videoId: ${videoId}, track: ${trackId}`);

  if (!isSessionActive(videoId, audioVariantLabel)) {
    createSessionLock(videoId, audioVariantLabel);
    const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);
    startAudioTranscoding(videoPath, videoId, trackId, audioVariantLabel);
  } else {
    updateSessionLock(videoId, audioVariantLabel);
  }

  if (!fs.existsSync(playlistPath)) {
    console.log(`[Audio Playlist] Playlist not ready for ${audioVariantLabel}`);
    return res.status(202).send('Audio playlist not ready, please try again shortly.');
  }

  res.setHeader('Content-Type', mime.lookup('m3u8'));
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(playlistPath);
});

// Variant segment route for audio
router.get('/api/stream/:id/audio/track_:track/:segment.ts', async (req, res) => {
  const videoId = req.params.id;
  const trackId = req.params.track;
  const audioVariantLabel = `audio_${trackId}`;
  const segmentFile = `${req.params.segment}.ts`;
  const segmentPath = path.join(HLS_OUTPUT_DIR, videoId, audioVariantLabel, segmentFile);

  if (!fs.existsSync(segmentPath)) {
    return res.status(404).send('Segment not found.');
  }
  
  res.setHeader('Content-Type', mime.lookup('.ts'));
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(segmentPath);
});

module.exports = router;
