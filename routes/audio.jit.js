// routes/audio.jit.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { HLS_OUTPUT_DIR, VIDEO_SOURCE_DIR, JIT_TRANSCODING_ENABLED, WEB_SUPPORTED_CODECS, HLS_SEGMENT_TIME } = require('../config/config');
const { safeFilename } = require('../utils/files');
const mime = require('mime-types');
const findVideoFile = require('../utils/findVideoFile');
const { getMediaInfo } = require('../utils/ffprobe');
const { 
  ensureVariantPlaylist, 
  stopActiveTranscoding
} = require('../services/segmentManager');
const {
  handleAudioSegmentRequest
} = require('../services/requestManager');
const { calculateSegmentNumber } = require('../utils/timestampUtils');
const { getAudioCodec, getAudioChannelCount } = require('../utils/audio');
const router = express.Router();
const fsPromises = fs.promises;

/**
 * GET /api/stream/:id/audio/track_:track/playlist.m3u8
 *
 * Handles HLS playlist requests for audio tracks with JIT transcoding support.
 * Creates an empty playlist immediately, which gets populated as segments are requested.
 */
router.get('/api/stream/:id/audio/track_:track/playlist.m3u8', async (req, res) => {
  // Only use JIT if enabled in config
  if (!JIT_TRANSCODING_ENABLED) {
    return res.status(500).send('JIT transcoding is disabled');
  }

  const videoId = req.params.id;
  const _trackId = req.params.track; // e.g. "0_aac"
  // split the trackId by underscore and get the last element
  const trackId = _trackId.split('_')[0];
  const requested_codec = _trackId.split('_').pop();
  const audioVariantLabel = `audio_${trackId}_${requested_codec}`;

  console.log(`[Audio JIT Playlist] Request for videoId: ${videoId}, track: ${_trackId}`);

  try {
    // 1. Find the source file
    const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);

    // 2. Get media info for the source file
    let mediaInfo;
    try {
      mediaInfo = await getMediaInfo(videoPath);
    } catch (error) {
      console.error('Error probing media:', error);
      return res.status(500).send('Error reading media info.');
    }

    // 3. Check if the requested audio track exists
    const audioStreams = (mediaInfo.streams || []).filter(s => s.codec_type === 'audio');
    if (audioStreams.length === 0) {
      return res.status(500).send('No audio streams found.');
    }

    const audioTrackIndex = parseInt(trackId, 10);
    if (audioTrackIndex >= audioStreams.length) {
      return res.status(404).send('Requested audio track not found.');
    }

    // 4. Ensure the variant playlist exists with the right number of segments
    // Pass the audio track index to get proper audio duration
    const playlistPath = await ensureVariantPlaylist(videoId, audioVariantLabel, {
      mediaTrackIndex: audioTrackIndex
    });

    // 5. Read the playlist
    let playlistContent = await fsPromises.readFile(playlistPath, 'utf8');

    // 6. Read the placeholder playlist content (created by ensureVariantPlaylist)
    playlistContent = await fsPromises.readFile(playlistPath, 'utf8');

    // 7. Set response headers and send the placeholder playlist
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(playlistContent, 'utf8'));
  } catch (error) {
    console.error('Error handling JIT audio playlist:', error);
    res.status(500).send('Error generating audio playlist');
  }
});

/**
 * GET /api/stream/:id/audio/track_:track/:segment.ts
 *
 * Serves audio segments with JIT transcoding support.
 * If a segment doesn't exist, it starts transcoding from that timestamp.
 */
router.get('/api/stream/:id/audio/track_:track/:segment.ts', async (req, res) => {
  // Only use JIT if enabled in config
  if (!JIT_TRANSCODING_ENABLED) {
    return res.status(500).send('JIT transcoding is disabled');
  }

  const videoId = req.params.id;
  const _trackId = req.params.track; // e.g. "0_aac"
  const trackId = _trackId.split('_')[0];
  const requested_codec = _trackId.split('_').pop();
  const audioVariantLabel = `audio_${trackId}_${requested_codec}`;
  const segmentFile = req.params.segment + '.ts';
  
  try {
    // Parse segment number from filename
    const segmentNumber = parseInt(req.params.segment, 10);
    if (isNaN(segmentNumber)) {
      return res.status(400).send('Invalid segment number');
    }
    
    // Find the source file
    const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);
    
    // Get audio stream information
    const audioTrackIndex = parseInt(trackId, 10);
    const originalCodec = await getAudioCodec(videoPath, audioTrackIndex);
    const channels = await getAudioChannelCount(videoPath, audioTrackIndex);
    
    // Create an audio variant object with the necessary information
    const audioVariant = {
      label: audioVariantLabel,
      codec: requested_codec || originalCodec,
      originalCodec: originalCodec,
      channels: channels,
      trackIndex: audioTrackIndex
    };
    
    try {
      // Use requestManager to handle the segment request (client-aware)
      const segmentPath = await handleAudioSegmentRequest(req, videoId, audioVariant, videoPath, segmentNumber);
      
      // Send the segment
      res.setHeader('Content-Type', mime.lookup('.ts') || 'video/MP2T');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      const file = await fsPromises.readFile(segmentPath);
      res.send(Buffer.from(file));
    } catch (error) {
      if (error.message.includes('Timeout')) {
        // If segment generation is still in progress
        return res.status(202).send('Audio segment is being generated, please try again shortly.');
      }
      throw error;
    }
  } catch (error) {
    console.error(`Error handling JIT audio segment request for ${segmentFile}:`, error);
    res.status(500).send('Error processing audio segment request');
  }
});


module.exports = router;
