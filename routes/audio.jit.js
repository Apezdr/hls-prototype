// routes/audio.jit.js
const express = require('express');
const fs = require('fs');
const { VIDEO_SOURCE_DIR, JIT_TRANSCODING_ENABLED } = require('../config/config');
const mime = require('mime-types');
const findVideoFile = require('../utils/findVideoFile');
const { getMediaInfo } = require('../utils/ffprobe');
const { 
  ensureVariantPlaylist
} = require('../services/segmentManager');
const { AudioProcessingPipeline } = require('../services/audio');
const { transcodeExplicitAudioSegment } = require('../services/ffmpegService');
const router = express.Router();
const fsPromises = fs.promises;

// Initialize the audio processing pipeline
const audioPipeline = new AudioProcessingPipeline();

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
 * Serves audio segments with JIT transcoding support using explicit offsets.
 * Segments are transcoded from precise timestamps using query parameters.
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
  const audioVariantLabel = `audio_${trackId}_${requested_codec?.toLowerCase()}`;
  const segmentFile = req.params.segment + '.ts';
  
  // Extract runtime and duration parameters from query string
  const runtimeTicks = parseInt(req.query.runtimeTicks || '0', 10);
  const actualSegmentLengthTicks = parseInt(req.query.actualSegmentLengthTicks || '0', 10);
  
  console.log(`Audio segment request for ${videoId}/${audioVariantLabel}/${segmentFile} with explicit offsets: runtimeTicks=${runtimeTicks}, duration=${actualSegmentLengthTicks}`);
  
  try {
    // Parse segment number from filename
    const segmentNumber = parseInt(req.params.segment, 10);
    if (isNaN(segmentNumber)) {
      return res.status(400).send('Invalid segment number');
    }
    
    // Find the source file
    const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);
    
    // Get audio stream information using comprehensive media analysis
    const audioTrackIndex = parseInt(trackId, 10);
    const mediaInfo = await getMediaInfo(videoPath);
    const audioStreams = mediaInfo.streams.filter(s => s.codec_type === 'audio');
    const sourceStream = audioStreams[audioTrackIndex];
    
    if (!sourceStream) {
      return res.status(404).send('Audio track not found');
    }
    
    // Prepare source stream information for the audio pipeline
    const sourceStreamInfo = {
      codec: sourceStream.codec_name,
      bitRate: parseInt(sourceStream.bit_rate) || 128000,
      sampleRate: parseInt(sourceStream.sample_rate) || 48000,
      channels: parseInt(sourceStream.channels) || 2,
      channelLayout: sourceStream.channel_layout,
      duration: parseFloat(sourceStream.duration) || 0
    };
    
    // Create target audio variant
    const targetVariant = {
      id: audioVariantLabel,
      codec: requested_codec || sourceStream.codec_name,
      bitrate: 128000, // Default, will be optimized by pipeline
      channels: sourceStreamInfo.channels,
      sampleRate: sourceStreamInfo.sampleRate,
      trackIndex: audioTrackIndex,
      container: 'ts' // For HLS segments
    };
    
    // Detect content type from user agent or metadata
    const userAgent = req.headers['user-agent'] || '';
    const deviceType = userAgent.includes('Mobile') ? 'mobile' : 
                      userAgent.includes('TV') ? 'tv' : 'desktop';
    
    // Process through audio pipeline for optimized strategy
    const processingOptions = {
      contentType: 'mixed', // Could be enhanced with metadata detection
      deviceType: deviceType,
      qualityPreference: 'balanced',
      enableVBR: true,
      normalizeLoudness: false // Disable for live streaming
    };
    
    let audioStrategy;
    try {
      audioStrategy = await audioPipeline.processAudioStream(
        sourceStreamInfo, 
        targetVariant, 
        processingOptions
      );
      console.log(`Audio strategy: ${audioStrategy.metadata.targetCodec} at ${audioStrategy.bitrate}bps - ${audioStrategy.metadata.optimization}`);
    } catch (strategyError) {
      console.warn('Audio pipeline strategy failed, using fallback:', strategyError.message);
      // Fallback to basic configuration
      audioStrategy = {
        encoder: requested_codec || sourceStream.codec_name,
        bitrate: 128000,
        channels: sourceStreamInfo.channels,
        sampleRate: sourceStreamInfo.sampleRate,
        args: ['-c:a', requested_codec || 'aac', '-b:a', '128000']
      };
    }
    
    // Create audio variant object for transcoding
    const audioVariant = {
      label: audioVariantLabel,
      codec: audioStrategy.encoder,
      originalCodec: sourceStream.codec_name,
      channels: audioStrategy.channels,
      sampleRate: audioStrategy.sampleRate,
      bitrate: audioStrategy.bitrate,
      trackIndex: audioTrackIndex,
      strategy: audioStrategy
    };
    
    try {
      let segmentPath;
      
      // If explicit offsets are provided in the query string, use them
      if (runtimeTicks > 0 || actualSegmentLengthTicks > 0) {
        // Use the new audio pipeline for explicit segment transcoding
        try {
          segmentPath = await audioPipeline.transcodeSegment(
            audioVariant.strategy,
            audioVariant,
            videoPath,
            segmentNumber,
            runtimeTicks,
            actualSegmentLengthTicks
          );
          console.log(`Audio pipeline transcoded segment ${segmentNumber} successfully`);
        } catch (pipelineError) {
          console.warn('Audio pipeline transcoding failed:', pipelineError.message);
        }
      }
      
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
