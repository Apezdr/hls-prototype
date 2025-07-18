const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const findVideoFile = require('../utils/findVideoFile');
const { processTsSegment } = require('../utils/tsProcessor');
const {
  HLS_OUTPUT_DIR,
  FFMPEG_PATH,
  HLS_SEGMENT_TIME,
  HARDWARE_ENCODING_ENABLED,
  VIDEO_SOURCE_DIR,
  WEB_SUPPORTED_CODECS,
  TRANSCODING_PAUSE_THRESHOLD,
  PRESERVE_SEGMENTS,
  PRESERVE_FFMPEG_PLAYLIST,
  VIEWER_INACTIVITY_THRESHOLD,
  VIEWER_CHECK_INTERVAL
} = require('../config/config');
const { safeFilename, ensureDir, waitForFileStability } = require('../utils/files');
const { getMediaInfo, getVideoFps, detectHdrType } = require('../utils/ffprobe');
const { buildFfmpegArgs } = require('./ffmpegUtils');
const { getOptimalSegmentDuration, getOptimalGopSize } = require('../utils/gopUtils');
const { acquireSlot, releaseSlot } = require('./hardwareTranscoderLimiter');
const { createSessionLock, updateSessionLock } = require('./sessionManager');
const {
  calculateSegmentNumber,
  calculateSegmentTimestamp,
  findNearestKeyframeTimestamp,
  segmentNumberToFilename,
  timestampToSeconds,
  getAlignedSegmentDuration,
  // Use the new approach for segment boundaries
  getSegmentBoundaries
} = require('../utils/timestampUtils');
const {
  generateCodecReference,
  getSegmentExtensionForVariant,
  getCodecReference,
  findVariantIgnoreCase
} = require('../utils/codecReferenceUtils');
const { getAudioFilterArgs } = require('../utils/audio');
const {
  generateKeyframeReference,
  generateKeyframeTimestampsFileForFfmpeg,
  generateAccurateVariantPlaylist,
  findNearestReferenceKeyframe
} = require('../utils/keyframeUtils');

// Base class for video transcoding sessions
class TranscodingSession {
  constructor(videoId, variant, videoPath) {
    this.videoId = videoId;
    this.variant = variant;
    this.videoPath = videoPath;
    this.key = `${videoId}_${variant.label}`;
    this.outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variant.label);
    this.process = null;
    this.startSegment = null;
    this.latestSegment = -1;
    this.adjustedTimestamp = 0;
    this.playlistPath = '';
    this.finished = false;
    this.errorMessage = null;
  }

  async start(startTimestamp, startSegment) {
    this.startSegment = startSegment;
    this.adjustedTimestamp = await findNearestReferenceKeyframe(this.videoId, startTimestamp);
    await ensureDir(this.outputDir);
    await generateKeyframeReference(this.videoId, this.videoPath);

    const mediaInfo = await getMediaInfo(this.videoPath);
    const [w, h] = this.variant.resolution.split('x');
    const isHDR = detectHdrType(mediaInfo) !== 'SDR';
    const variantForcedSDR = this.variant.isSDR && isHDR;
    const gopSize = await getOptimalGopSize(this.videoPath, HLS_SEGMENT_TIME);
    const segmentDuration = await getOptimalSegmentDuration(this.videoPath, HLS_SEGMENT_TIME);
    this.playlistPath = path.join(this.outputDir, 'ffmpeg_playlist.m3u8');

    // Priority calculation
    let priority = 1;
    // ... (you can re-add viewer-based and quality-based priority here)

    const useHardware = HARDWARE_ENCODING_ENABLED === 'true'
      ? await acquireSlot({ taskId: this.key, priority, metadata: { videoId: this.videoId, variant: this.variant.label } })
      : false;

    const keyframeExpression = await generateKeyframeTimestampsFileForFfmpeg(this.videoId);
    const args = await buildFfmpegArgs({
      videoPath: this.videoPath,
      outputDir: this.outputDir,
      width: w,
      height: h,
      bitrate: this.variant.bitrate,
      useHardware,
      variantForcedSDR,
      muxer: 'hls',
      startNumber: startSegment,
      outputPlaylistPath: this.playlistPath,
      keyframeTimestamps: keyframeExpression,
      variant: this.variant
    });

  // Insert -ss before input
  const iidx = args.indexOf('-i');
  if (iidx !== -1) args.splice(iidx, 0, '-ss', this.adjustedTimestamp.toString(), '-copyts');
  
  // Ensure we're using the optimized segment duration
  const hlsTimeIndex = args.indexOf('-hls_time');
  if (hlsTimeIndex !== -1 && hlsTimeIndex + 1 < args.length) {
    args[hlsTimeIndex + 1] = segmentDuration.toFixed(6);
  } else {
    // If not already set, add it (backup)
    args.push('-hls_time', segmentDuration.toFixed(6));
  }
  
  args.push('-g', gopSize.toString(), '-force_key_frames', keyframeExpression);

    // Spawn ffmpeg
    this.process = spawn(FFMPEG_PATH, args);
    this._bindEvents(useHardware);
    await createSessionLock(this.videoId, this.variant.label);
  }

  detectSeek(requestedSegment) {
    if (!this.finished && requestedSegment > this.latestSegment + 10) return true;
    if (requestedSegment < this.startSegment) return true;
    return false;
  }

  async waitForSegment(segmentNumber) {
    const ext = await getSegmentExtensionForVariant(this.videoId, this.variant.label);
    const segFile = `${segmentNumber.toString().padStart(3, '0')}.${ext}`;
    const segPath = path.join(this.outputDir, segFile);
    
    // Wait for file to be stable (not being written to)
    await waitForFileStability(segPath, 200, 9000);
    
    // Additional verification: Check for existence of subsequent segment 
    // if this isn't the last segment and we're not at the end of the video
    if (!this.finished && segmentNumber < this.latestSegment) {
      const nextSegFile = `${(segmentNumber + 1).toString().padStart(3, '0')}.${ext}`;
      const nextSegPath = path.join(this.outputDir, nextSegFile);
      
      // If next segment exists, we know this one is complete
      try {
        await fs.access(nextSegPath);
        console.log(`Verified segment ${segmentNumber} via next segment existence`);
      } catch (err) {
        // Next segment doesn't exist yet, wait a bit longer for this one to fully stabilize
        console.log(`Next segment ${segmentNumber + 1} not found, waiting for current segment to fully stabilize`);
        await waitForFileStability(segPath, 500, 4000); // More extensive stability check
      }
    }
    
    //await processTsSegment(this.videoId, this.variant.label, segPath, segmentNumber);
    // Update session lock to keep it fresh
    await updateSessionLock(this.videoId, this.variant.label);
    return segPath;
  }

  async stop() {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.finished = true;
    if (!PRESERVE_SEGMENTS || !PRESERVE_FFMPEG_PLAYLIST) {
      const files = await fs.readdir(this.outputDir);
      await Promise.all(files.map(async f => {
        if ((!PRESERVE_SEGMENTS && f.endsWith('.ts')) ||
            (!PRESERVE_FFMPEG_PLAYLIST && f === 'ffmpeg_playlist.m3u8')) {
          await fs.unlink(path.join(this.outputDir, f)).catch(() => {});
        }
      }));
    }
    this.process = null;
  }

  async pause() {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.finished = true;
    // keep files
    this.process = null;
  }

  _bindEvents(useHardware) {
    let stderrLog = '';
    this.process.stderr.on('data', d => {
      const s = d.toString();
      if (!/frame=\s*\d+/.test(s)) console.log(`[ffmpeg ${this.key}]`, s.trim());
      if (/Error|Invalid|Failed|Cannot/.test(s)) stderrLog += s;
      
      // Parse progress timemark from stderr for progress tracking
      const timeMatch = s.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (timeMatch && timeMatch[1]) {
        this._updateProgress(timeMatch[1]);
      }
    });
    this.process.on('error', err => {
      console.error(`[${this.key}] ffmpeg error:`, err);
      this.errorMessage = err.message;
      this.finished = true;
      if (useHardware) releaseSlot(this.key);
    });
    this.process.on('exit', (code, sig) => {
      if (code !== 0) console.error(`[${this.key}] exited ${code} ${sig}`, stderrLog);
      this.finished = true;
      if (useHardware) releaseSlot(this.key);
    });
    this.process.stdout?.on('data', () => {});
  }
  
  async _updateProgress(timemark) {
    try {
      const secs = timestampToSeconds(timemark);
      const totalSecondsProcessed = this.adjustedTimestamp + secs;
      const alignedDuration = await getAlignedSegmentDuration(this.videoPath, this.videoId);
      const currentLatestSegment = Math.floor(totalSecondsProcessed / alignedDuration) - 1;
      
      if (currentLatestSegment > this.latestSegment) {
        this.latestSegment = currentLatestSegment;
        // Update session lock to keep it fresh
        await updateSessionLock(this.videoId, this.variant.label);
      }
    } catch (e) {
      console.warn(`Error updating progress for ${this.key}: ${e.message}`);
    }
  }
}

// Subclass for audio
class AudioTranscodingSession extends TranscodingSession {
  async start(startTimestamp, startSegment) {
    this.startSegment = startSegment;
    await ensureDir(this.outputDir);
    
    // For audio streams, find the nearest sync point for better alignment
    const mediaInfo = await getMediaInfo(this.videoPath);
    this.adjustedTimestamp = findNearestKeyframeTimestamp(mediaInfo, startTimestamp);
    console.log(`Adjusted audio seek point from ${startTimestamp}s to ${this.adjustedTimestamp}s for clean alignment`);
    
    const segmentDuration = await getOptimalSegmentDuration(this.videoPath, HLS_SEGMENT_TIME);
    this.playlistPath = path.join(this.outputDir, 'ffmpeg_playlist.m3u8');

    // Get appropriate file extension for this variant
    const ext = await getSegmentExtensionForVariant(this.videoId, this.variant.label) || 'ts';
    
    // Build audio-specific args
    const args = [
      '-copyts','-ss', this.adjustedTimestamp.toString(), '-i', this.videoPath,
      '-map', `0:a:${this.variant.trackIndex}`,
      '-c:a', WEB_SUPPORTED_CODECS.includes(this.variant.codec) ? this.variant.codec : 'aac',
      ...getAudioFilterArgs(this.variant.channels, true),
      '-f','hls','-hls_time', segmentDuration.toFixed(6),
      '-hls_playlist_type','vod','-hls_segment_type','mpegts',
      '-hls_flags','independent_segments',
      '-start_number', startSegment.toString(),
      `-hls_segment_filename`, path.join(this.outputDir, `%03d.${ext}`),
      this.playlistPath
    ];

    this.process = spawn(FFMPEG_PATH, args);
    this._bindEvents(false);
    await createSessionLock(this.videoId, this.variant.label);
  }
}

// Manager
class JITTranscoderManager {
  constructor() {
    this.sessions = new Map();
    this.viewers = new Map();
    setInterval(() => this.pauseInactive(), VIEWER_CHECK_INTERVAL);
    setInterval(() => this.cleanupInactive(), VIEWER_CHECK_INTERVAL * 6);
  }

  trackViewerActivity(videoId, variantLabel, segment) {
    this.viewers.set(`${videoId}_${variantLabel}`, { lastAccess: Date.now(), lastSegment: segment });
  }

  async segmentExists(segmentPath) {
    try { await fs.access(segmentPath); return true; } catch { return false; }
  }

  async getExistingSegments(outputDir) {
    try {
      const files = await fs.readdir(outputDir);
      return files.filter(f => /^\d+\.ts$/.test(f)).map(f => parseInt(f,10)).sort((a,b)=>a-b);
    } catch { return []; }
  }

  async ensureVariantPlaylist(videoId, variantLabel, options = {}) {
    const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variantLabel);
    await ensureDir(outputDir);
    const playlistPath = path.join(outputDir, 'playlist.m3u8');
    
    // If playlist already exists, return its path
    try { await fs.access(playlistPath); return playlistPath; } catch {}
    
    // Locate source video
    const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);
    if (!videoPath) throw new Error(`Video not found: ${videoId}`);
    
    // Get segment boundaries using precomputed values or generate them
    const segments = await getSegmentBoundaries(videoId, videoPath);
    
    // Generate keyframe reference if it doesn't exist
    await generateKeyframeReference(videoId, videoPath);
    
    // Try to use the keyframe-based generator for more accurate playlists
    try {
      return await generateAccurateVariantPlaylist(videoId, variantLabel, options);
    } catch (err) {
      console.error(`Error generating accurate playlist from keyframe reference: ${err.message}`);
      console.log(`Falling back to standard playlist generation for ${videoId}/${variantLabel}`);
      
      // Fallback to standard method if keyframe reference fails
      const mediaInfo = await getMediaInfo(videoPath);
      const segmentDuration = await getOptimalSegmentDuration(videoPath, HLS_SEGMENT_TIME);
      
      // Get video/audio duration
      let mediaDuration = 0;
      
      if (variantLabel.startsWith('audio_')) {
        // For audio variants, use audio stream duration if available
        const audioStreams = (mediaInfo.streams || []).filter(s => s.codec_type === 'audio');
        if (options.mediaTrackIndex !== undefined && audioStreams[options.mediaTrackIndex]) {
          mediaDuration = parseFloat(audioStreams[options.mediaTrackIndex].duration || 0);
        }
      }
      
      // If audio duration not available or not an audio variant, try video duration
      if (mediaDuration <= 0) {
        const videoStream = (mediaInfo.streams || []).find(s => s.codec_type === 'video');
        mediaDuration = parseFloat(videoStream?.duration || 0);
      }
      
      // Cap at 24h or use default duration if still not determined
      const maxDuration = 24 * 60 * 60;
      if (mediaDuration <= 0) {
        mediaDuration = 2 * 60 * 60; // 2 hours default
      } else if (mediaDuration > maxDuration) {
        mediaDuration = maxDuration;
      }
      
      // Compute segment count
      const segmentCount = Math.ceil(mediaDuration / segmentDuration);
      console.log(`Creating playlist with ${segmentCount} segments (duration: ${mediaDuration}s)`);
      
      // Get appropriate file extension for this variant
      const ext = await getSegmentExtensionForVariant(videoId, variantLabel) || 'ts';
      
      // Build VOD playlist
      let playlist =
        '#EXTM3U\n' +
        '#EXT-X-VERSION:7\n' +
        `#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}\n` +
        '#EXT-X-MEDIA-SEQUENCE:0\n' +
        '#EXT-X-PLAYLIST-TYPE:VOD\n';
      
      // Use precomputed segment boundaries for precise durations and runtime offsets
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];

        // For every segment except the first, insert EXT-X-DISCONTINUITY
        if (i > 0) {
          playlist += '#EXT-X-DISCONTINUITY\n';
        }

        // Use actual segment duration instead of standard duration
        playlist += `#EXTINF:${(segment.durationSeconds).toFixed(6)},\n` +
                    `${i.toString().padStart(3, '0')}.${ext}?runtimeTicks=${segment.runtimeTicks}&actualSegmentLengthTicks=${segment.actualSegmentLengthTicks}\n`;
      }
      
      // Add ENDLIST tag
      playlist += '#EXT-X-ENDLIST\n';
      
      // Write the playlist file
      await fs.writeFile(playlistPath, playlist);
      console.log(`Created fallback playlist at ${playlistPath} with ${segmentCount} segments`);
      
      return playlistPath;
    }
  }

  async ensureSegment(videoId, variant, videoPath, segmentNumber) {
    this.trackViewerActivity(videoId, variant.label, segmentNumber);
    
    // Generate codec reference to ensure correct extension and variant naming
    await generateCodecReference(videoId, videoPath, [variant]);
    
    // Check for case-sensitive variant name issues and correct if needed
    const codecReference = await getCodecReference(videoId);
    const correctVariantLabel = findVariantIgnoreCase(codecReference.variants, variant.label);
    if (correctVariantLabel && correctVariantLabel !== variant.label) {
      console.log(`Using case-corrected variant name: ${variant.label} → ${correctVariantLabel}`);
      variant = { ...variant, label: correctVariantLabel };
    }
    
    const key = `${videoId}_${variant.label}`;
    let session = this.sessions.get(key);
    if (!session || session.detectSeek(segmentNumber)) {
      if (session) await session.stop();
      const SegClass = variant.trackIndex != null ? AudioTranscodingSession : TranscodingSession;
      session = new SegClass(videoId, variant, videoPath);
      this.sessions.set(key, session);
      const startTs = calculateSegmentTimestamp(segmentNumber, await getAlignedSegmentDuration(videoPath, videoId));
      await session.start(startTs, calculateSegmentNumber(startTs, await getAlignedSegmentDuration(videoPath, videoId)));
    }
    return session.waitForSegment(segmentNumber);
  }

  async ensureAudioSegment(videoId, audioVariant, videoPath, segmentNumber) {
    // identical to ensureSegment but variant.trackIndex is present
    return this.ensureSegment(videoId, audioVariant, videoPath, segmentNumber);
  }

  async stopSession(videoId, variantLabel) {
    const key = `${videoId}_${variantLabel}`;
    const session = this.sessions.get(key);
    if (session) { await session.stop(); this.sessions.delete(key); }
  }

  async pauseInactive() {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      const viewer = this.viewers.get(key);
      if (!viewer || now - viewer.lastAccess > TRANSCODING_PAUSE_THRESHOLD) {
        await session.pause();
      }
    }
  }

  async cleanupInactive() {
    const now = Date.now();
    for (const [key, viewer] of this.viewers.entries()) {
      if (now - viewer.lastAccess > VIEWER_INACTIVITY_THRESHOLD) {
        const [videoId, variantLabel] = key.split('_');
        await this.stopSession(videoId, variantLabel);
        this.viewers.delete(key);
      }
    }
  }
}

// Export a singleton manager
const manager = new JITTranscoderManager();
module.exports = {
  ensureSegment: manager.ensureSegment.bind(manager),
  ensureAudioSegment: manager.ensureAudioSegment.bind(manager),
  ensureVariantPlaylist: manager.ensureVariantPlaylist.bind(manager),
  segmentExists: manager.segmentExists.bind(manager),
  getExistingSegments: manager.getExistingSegments.bind(manager),
  trackViewerActivity: manager.trackViewerActivity.bind(manager),
  stopActiveTranscoding: manager.stopSession.bind(manager)
};
