// routes/audio.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { handleAudioTranscodingSession } = require('../services/ffmpegService');
const { isSessionActive, createSessionLock, updateSessionLock } = require('../services/sessionManager');
const { VIDEO_SOURCE_DIR, HLS_OUTPUT_DIR } = require('../config/config');
var mime = require('mime-types');
const findVideoFile = require('../utils/findVideoFile');
const { safeFilename, waitForFileStability } = require('../utils/files');
const router = express.Router();
const fsPromises = fs.promises;


// Audio playlist route: e.g. /api/stream/:id/audio/track_:track/playlist.m3u8
router.get('/api/stream/:id/audio/track_:track/playlist.m3u8', async (req, res) => {
  const videoId = req.params.id;
  const _trackId = req.params.track; // e.g. "0"
  // split the trackId by underscore and get the last element
  const trackId = _trackId.split('_')[0];
  const requested_codec = _trackId.split('_').pop();
  const audioVariantLabel = `audio_${trackId}_${requested_codec}`;
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariantLabel);
  const playlistPath = path.join(outputDir, 'playlist.m3u8');

  console.log(`[Audio Playlist] Request for videoId: ${videoId}, track: ${_trackId}`);

  await handleAudioTranscodingSession(videoId, audioVariantLabel, trackId, requested_codec, null);

  try {
    await fsPromises.access(playlistPath);
  } catch (err) {
    console.log(`[Audio Playlist] Playlist not ready for ${audioVariantLabel}`);
    return res.status(202).send('Audio playlist not ready, please try again shortly.');
  }

  res.setHeader('Content-Type', mime.lookup('m3u8'));
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  let file = await fsPromises.readFile(playlistPath, 'utf8');
  if (req.query.playlistType === 'VOD') {
    file = file.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
  }
  res.send(Buffer.from(file));
});

// Variant segment route for audio
router.get('/api/stream/:id/audio/track_:track/:segment.ts', async (req, res) => {
  const videoId = req.params.id;
  const _trackId = req.params.track; // e.g. "0"
  // split the trackId by underscore and get the last element
  const trackId = _trackId.split('_')[0];
  const requested_codec = _trackId.split('_').pop();
  const audioVariantLabel = `audio_${trackId}_${requested_codec}`;
  const segmentFile = `${req.params.segment}.ts`;
  const segmentPath = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariantLabel, segmentFile);

  try {
    await fsPromises.access(segmentPath);
  } catch (err) {
    return res.status(404).send('Segment not found.');
  }
  
  res.setHeader('Content-Type', mime.lookup('.ts'));
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const file = await fsPromises.readFile(segmentPath);
  res.send(Buffer.from(file, 'utf8'));
});

// Force stereo audio playlist route: e.g. /api/stream/:id/audio/audio_stereo/playlist.m3u8
router.get('/api/stream/:id/audio/audio_stereo/playlist.m3u8', async (req, res) => {
  const videoId = req.params.id;
  const audioVariantLabel = 'audio_stereo';
  const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariantLabel);
  const playlistPath = path.join(outputDir, 'playlist.m3u8');

  console.log(`[Audio Playlist] Request for stereo audio track, videoId: ${videoId}`);

  await handleAudioTranscodingSession(videoId, audioVariantLabel, null, 'aac', 'stereo');

  try {
    //await fsPromises.access(playlistPath);
    await waitForFileStability(playlistPath, 200, 30);
  } catch (err) {
    console.log(`[Audio Playlist] Stereo playlist not ready for ${audioVariantLabel}`);
    return res.status(202).send('Stereo audio playlist not ready, please try again shortly.');
  }

  res.setHeader('Content-Type', mime.lookup('m3u8'));
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  let file = await fsPromises.readFile(playlistPath, 'utf8');

  if (req.query.playlistType === 'VOD') {
    file = file.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
  }

  res.send(Buffer.from(file));
});

// stereo audio segment route
router.get('/api/stream/:id/audio/audio_stereo/:segment.ts', async (req, res) => {
  const videoId = req.params.id;
  const trackId = 'audio_stereo';
  const audioVariantLabel = `${trackId}`;
  const segmentFile = `${req.params.segment}.ts`;
  const segmentPath = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariantLabel, segmentFile);

  try {
    await fsPromises.access(segmentPath);
  } catch (err) {
    console.log(`[Audio Playlist] Stereo playlist not ready for ${audioVariantLabel}`);
    return res.status(404).send('Segment not found.');
  }
  
  res.setHeader('Content-Type', mime.lookup('.ts'));
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const file = await fsPromises.readFile(segmentPath);
  res.send(Buffer.from(file, 'utf8'));
});

module.exports = router;
