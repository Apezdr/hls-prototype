// routes/video.jit.js
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { VARIANTS, HLS_OUTPUT_DIR, VIDEO_SOURCE_DIR, JIT_TRANSCODING_ENABLED, HLS_SEGMENT_TIME } = require('../config/config');
const { safeFilename } = require('../utils/files');
const mime = require('mime-types');
const findVideoFile = require('../utils/findVideoFile');
const { getMediaInfo, determineVideoRange } = require('../utils/ffprobe');
const { 
  ensureVariantPlaylist, 
  stopActiveTranscoding
} = require('../services/segmentManager');
const {
  handleVideoSegmentRequest
} = require('../services/requestManager');
const { calculateSegmentNumber } = require('../utils/timestampUtils');
const router = express.Router();

/**
 * GET /api/stream/:id/:variant/playlist.m3u8
 *
 * Handles HLS playlist requests for a given video and variant with JIT transcoding support.
 * Creates an empty playlist immediately, which gets populated as segments are requested.
 */
router.get('/api/stream/:id/:variant/playlist:ignoreSuffix?.m3u8', async (req, res) => {
  // Only use JIT if enabled in config
  if (!JIT_TRANSCODING_ENABLED) {
    return res.status(500).send('JIT transcoding is disabled');
  }

  const videoId = req.params.id;
  const variantLabel = req.params.variant;
  
  // Extract audio group info from suffix if present
  const audioGroupMatch = req.params.ignoreSuffix ? req.params.ignoreSuffix.match(/^_audio-([^.]+)/) : null;
  const audioGroupId = audioGroupMatch ? `audio-${audioGroupMatch[1]}` : null;
  
  console.log(`Playlist request for ${videoId}/${variantLabel} with audio group: ${audioGroupId || 'none'}`);

  try {
    // 1. Find the source file
    const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);

    // 2. Use ffprobe to analyze the source file
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

    // 3. Build a dynamic variant set
    let variantSet = VARIANTS;
    if (sourceWidth >= 3840) {
      // Add a custom "4k" variant
      variantSet = [
        { resolution: `${sourceWidth}x${sourceHeight}`, bitrate: '15000k', label: '4k', isSDR: false },
        ...VARIANTS
      ];
    }

    // 4. Find the variant by label
    const variant = variantSet.find(v => v.label === variantLabel);
    if (!variant) {
      return res.status(404).send('Variant not found.');
    }

    // 5. Ensure the variant playlist exists (will create if it doesn't)
    const playlistPath = await ensureVariantPlaylist(videoId, variantLabel);

    // 6. Read the playlist
    let playlistContent = await fs.readFile(playlistPath, 'utf8');


    // 8. Read the placeholder playlist content (created by ensureVariantPlaylist)
    // We serve this placeholder playlist, not the one FFmpeg manages directly
    playlistContent = await fs.readFile(playlistPath, 'utf8');

    // 9. Ensure video range tag is present (if needed)
    const videoRange = determineVideoRange(mediaInfo);
    if (!playlistContent.includes('#EXT-X-VIDEO-RANGE')) {
      playlistContent = playlistContent.replace(
        /(#EXT-X-VERSION:[^\n]+\n)/,
        `$1#EXT-X-VIDEO-RANGE:${videoRange}\n`
      );
      // Optionally write back the updated placeholder playlist
      // await fs.writeFile(playlistPath, playlistContent);
    }

    // 10. Set response headers and send the placeholder playlist
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(playlistContent, 'utf8'));
  } catch (error) {
    console.error('Error handling JIT variant playlist:', error);
    res.status(500).send('Error generating playlist');
  }
});

/**
 * GET /api/stream/:id/:variant/:segment.ts
 *
 * Serves video segments with JIT transcoding support.
 * If a segment doesn't exist, it starts transcoding from that timestamp.
 * Uses the RequestManager for intelligent client-aware segment handling.
 */
router.get('/api/stream/:id/:variant/:segment.ts', async (req, res) => {
  // Only use JIT if enabled in config
  if (!JIT_TRANSCODING_ENABLED) {
    return res.status(500).send('JIT transcoding is disabled');
  }

  const videoId = req.params.id;
  const variantLabel = req.params.variant;
  const segmentFile = req.params.segment + '.ts';
  
  try {
    // Parse segment number from filename
    const segmentNumber = parseInt(req.params.segment, 10);
    if (isNaN(segmentNumber)) {
      return res.status(400).send('Invalid segment number');
    }
    
    // Find the source file
    const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);
    
    // Determine the variant
    const mediaInfo = await getMediaInfo(videoPath);
    const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
    if (!videoStream) {
      return res.status(500).send('No video stream found.');
    }
    
    const sourceWidth = videoStream.width;
    const sourceHeight = videoStream.height;
    
    // Build a dynamic variant set
    let variantSet = VARIANTS;
    if (sourceWidth >= 3840) {
      variantSet = [
        { resolution: `${sourceWidth}x${sourceHeight}`, bitrate: '15000k', label: '4k', isSDR: false },
        ...VARIANTS
      ];
    }
    
    // Find the variant by label
    const variant = variantSet.find(v => v.label === variantLabel);
    if (!variant) {
      return res.status(404).send('Variant not found.');
    }
    
    try {
      // Use requestManager to handle the segment request (client-aware)
      const segmentPath = await handleVideoSegmentRequest(req, videoId, variant, videoPath, segmentNumber);
      
      // Send the segment
      res.setHeader('Content-Type', mime.lookup('.ts'));
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      const file = await fs.readFile(segmentPath);
      res.send(Buffer.from(file));
    } catch (error) {
      if (error.message.includes('Timeout')) {
        // If segment generation is still in progress
        return res.status(202).send('Segment is being generated, please try again shortly.');
      }
      throw error;
    }
  } catch (error) {
    console.error(`Error handling JIT segment request for ${segmentFile}:`, error);
    res.status(500).send('Error processing segment request');
  }
});

module.exports = router;
