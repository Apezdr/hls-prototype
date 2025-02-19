// routes/iframe.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const { waitForFileStability, safeFilename } = require('../utils/files');
const { HLS_OUTPUT_DIR } = require('../config/config');
const router = express.Router();

// Route to serve the i-frame playlist
router.get('/api/stream/:id/:variant/iframe_playlist.m3u8', async (req, res) => {
  const { id, variant } = req.params;
  const playlistPath = path.join(HLS_OUTPUT_DIR, safeFilename(id), variant, "iframe_playlist.m3u8");
  
  try {
    await fs.promises.access(playlistPath, fs.constants.F_OK);
  } catch (err) {
    return res.status(202).send('Playlist not ready, please try again shortly.');
  }
  
  try {
    await waitForFileStability(playlistPath, 200, 600);
    let playlistContent = await fs.promises.readFile(playlistPath, 'utf8');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.query.playlistType === 'VOD') {
      playlistContent = playlistContent.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
    }
    res.send(Buffer.from(playlistContent));
  } catch (error) {
    console.error(`Error reading i-frame playlist: ${error}`);
    res.status(202).send('Playlist not ready, please try again.');
  }
});

// Route to serve the i-frame segments
router.get('/api/stream/:id/:variant/iframe_:segment.ts', async (req, res) => {
  const { id, variant, segment } = req.params;
  // Build the file name with the "iframe_" prefix (e.g., "iframe_000.ts")
  const segmentFilename = `iframe_${segment}.ts`;
  const segmentPath = path.join(HLS_OUTPUT_DIR, safeFilename(id), variant, segmentFilename);

  try {
    await fs.promises.access(segmentPath, fs.constants.F_OK);
  } catch (err) {
    return res.status(404).send('Segment not found.');
  }

  try {
    await waitForFileStability(segmentPath, 200, 600);
    res.setHeader('Content-Type', mime.lookup('.ts') || 'video/MP2T');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const fileContent = await fs.promises.readFile(segmentPath);
    res.send(Buffer.from(fileContent));
  } catch (error) {
    console.error(`Error waiting for file stability on ${segmentFilename}:`, error);
    res.status(202).send('Segment not ready, please try again.');
  }
});

module.exports = router;
