// routes/video.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { startTranscoding } = require('../services/ffmpegService');
const { isSessionActive, createSessionLock, updateSessionLock } = require('../services/sessionManager');
const { VARIANTS, HLS_OUTPUT_DIR, VIDEO_SOURCE_DIR } = require('../config/config');
const { waitForFileStability } = require('../utils/files');
var mime = require('mime-types');
const findVideoFile = require('../utils/findVideoFile');
const { getMediaInfo } = require('../utils/ffprobe');
const router = express.Router();

/**
 * GET /api/stream/:id/:variant/playlist.m3u8
 *
 * Handles HLS playlist requests for a given video and variant.
 *
 * When a request is made for a variant’s playlist:
 * - It validates the variant parameter.
 * - It checks if a transcoding session is active for the given video and variant.
 *   - If not, it creates a session lock and starts the transcoding process.
 *   - If so, it updates the session lock.
 * - If the playlist file does not exist, it responds with a 202 status indicating that the
 *   playlist is not yet ready.
 * - Once the playlist is available, it reads and modifies its content:
 *   - Changes "#EXT-X-PLAYLIST-TYPE:EVENT" to "#EXT-X-PLAYLIST-TYPE:VOD".
 *   - Downgrades the HLS version from 6 to 3.
 *   - Removes any unnecessary discontinuity tags.
 * - Finally, it sends the modified playlist with appropriate HTTP headers.
 *
 * @param {object} req - The Express request object.
 * @param {object} req.params - Parameters provided in the URL path.
 * @param {string} req.params.id - The identifier of the video.
 * @param {string} req.params.variant - The label for the desired video variant.
 * @param {object} res - The Express response object.
 * @returns {Promise<void>}
 */
router.get('/api/stream/:id/:variant/playlist.m3u8', async (req, res) => {
  const videoId = req.params.id;
  const variantLabel = req.params.variant;

  // 1. Find the source file
  const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);

  // 2. Use ffprobe to see if it’s 4K
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

  // 3. Build a dynamic variant set
  let variantSet = VARIANTS;
  if (sourceWidth >= 3840) {
    // Add a custom "4k" variant
    variantSet = [
      { resolution: `${sourceWidth}x${videoStream.height}`, bitrate: '8000k', label: '4k' },
      ...VARIANTS // Also include the standard HD variants
    ];
  }

  // 4. Now find the variant by label in our dynamic set
  const variant = variantSet.find(v => v.label === variantLabel);
  if (!variant) {
    return res.status(404).send('Variant not found.');
  }

  // 5. Proceed with session checks
  const outputDir = path.join(HLS_OUTPUT_DIR, videoId, variant.label);
  const playlistPath = path.join(outputDir, 'playlist.m3u8');

  if (!isSessionActive(videoId, variant.label)) {
    createSessionLock(videoId, variant.label);
    startTranscoding(videoPath, videoId, variant);
  } else {
    updateSessionLock(videoId, variant.label);
  }

  if (!fs.existsSync(playlistPath)) {
    return res.status(202).send('Playlist not ready, please try again shortly.');
  }

  // 6. Finally, serve the playlist
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // If you want to transform the playlist content (e.g., remove discontinuity):
  // const playlistContent = fs.readFileSync(playlistPath, 'utf8');
  // const modifiedPlaylist = playlistContent
  //   .replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD')
  //   .replace('#EXT-X-VERSION:6', '#EXT-X-VERSION:3')
  //   .replace(/#EXT-X-DISCONTINUITY\n/g, '');
  // res.send(modifiedPlaylist);

  // Or just send the file directly:
  res.sendFile(playlistPath);
});

/**
 * GET /api/stream/:id/:variant/:segment.ts
 *
 * Serves the video segment for a given video, variant, and segment identifier.
 *
 * When a request for a segment is received:
 * - It constructs the file path to the segment based on the video ID, variant, and segment name.
 * - It checks if the segment file exists. If not, responds with a 404 status.
 * - It waits for the file to become stable (using the waitForFileStability utility) before delivery.
 * - Upon successful stability check, it sends the segment file with proper HTTP headers.
 * - If the stability wait fails, it logs the error and responds with a 202 status indicating that the
 *   segment is not ready yet.
 *
 * @param {object} req - The Express request object.
 * @param {object} req.params - Parameters provided in the URL path.
 * @param {string} req.params.id - The identifier of the video.
 * @param {string} req.params.variant - The label for the desired video variant.
 * @param {string} req.params.segment - The segment identifier (without the .ts extension).
 * @param {object} res - The Express response object.
 * @returns {Promise<void>}
 */
router.get('/api/stream/:id/:variant/:segment.ts', async (req, res) => {
  const videoId = req.params.id;
  const variantLabel = req.params.variant;
  const segmentFile = `${req.params.segment}.ts`;
  const segmentPath = path.join(HLS_OUTPUT_DIR, videoId, variantLabel, segmentFile);

  if (!fs.existsSync(segmentPath)) {
    return res.status(404).send('Segment not found.');
  }

  try {
    await waitForFileStability(segmentPath, 200, 5);
    res.setHeader('Content-Type', mime.lookup('.ts'));
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(segmentPath);
  } catch (error) {
    console.error(`Error waiting for file stability on ${segmentFile}:`, error);
    res.status(202).send('Segment not ready, please try again.');
  }
});

module.exports = router;
