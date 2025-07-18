// services/audio/audioSegmentTranscoder.js
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const { HLS_OUTPUT_DIR, FFMPEG_PATH } = require('../../config/config');
const { ensureDir, safeFilename } = require('../../utils/files');
const ffmpegValidator = require('../../utils/ffmpegEncoderValidator');

/**
 * Audio Segment Transcoder
 * Handles segment-specific transcoding with proper seeking and timing
 */
class AudioSegmentTranscoder {
  constructor() {
    this.activeProcesses = new Map();
  }

  /**
   * Transcode explicit audio segment with precise seeking
   * @param {Object} strategy - Audio processing strategy
   * @param {Object} audioVariant - Audio variant configuration
   * @param {string} videoPath - Source video path
   * @param {number} segmentNumber - Segment number
   * @param {number} startTicks - Start time in ticks
   * @param {number} durationTicks - Duration in ticks
   * @returns {Promise<string>} Path to transcoded segment
   */
  async transcodeExplicitSegment(strategy, audioVariant, videoPath, segmentNumber, startTicks, durationTicks) {
    // Use the same directory structure as video segments
    const videoId = path.basename(videoPath, path.extname(videoPath));
    const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariant.label);
    await ensureDir(outputDir);
    
    // Convert ticks to seconds
    const startSeconds = startTicks / 10000000;
    const durationSeconds = durationTicks / 10000000;

    // Build output path following the same pattern as video segments
    const segmentFile = `${segmentNumber.toString().padStart(3, '0')}.ts`;
    const outputPath = path.join(outputDir, segmentFile);

    // Check if segment already exists
    try {
      await fs.access(outputPath);
      console.log(`Audio segment ${segmentNumber} already exists at ${outputPath}`);
      return outputPath;
    } catch {
      // Need to transcode
      console.log(`Audio segment ${segmentNumber} doesn't exist, transcoding now...`);
    }

    // Build FFmpeg arguments for explicit segment
    const args = await this.buildExplicitSegmentArgs(
      strategy,
      videoPath,
      outputPath,
      startSeconds,
      durationSeconds,
      audioVariant
    );

    console.log(`Transcoding explicit audio segment ${segmentNumber}:`, args.join(' '));

    return new Promise((resolve, reject) => {
      const process = spawn(FFMPEG_PATH, args);
      const processId = `explicit_${audioVariant.label}_${segmentNumber}`;
      
      this.activeProcesses.set(processId, process);

      let stderrOutput = '';

      process.stderr.on('data', (data) => {
        stderrOutput += data.toString();
      });

      process.on('close', (code) => {
        this.activeProcesses.delete(processId);
        
        if (code === 0) {
          console.log(`Audio segment ${segmentNumber} transcoded successfully`);
          resolve(outputPath);
        } else {
          console.error(`Audio segment transcoding failed with code ${code}:`, stderrOutput);
          reject(new Error(`Transcoding failed: ${stderrOutput}`));
        }
      });

      process.on('error', (err) => {
        this.activeProcesses.delete(processId);
        console.error(`FFmpeg process error:`, err);
        reject(err);
      });
    });
  }

  /**
   * Transcode streaming audio segments
   * @param {Object} strategy - Audio processing strategy
   * @param {Object} audioVariant - Audio variant configuration
   * @param {string} videoPath - Source video path
   * @param {number} startNumber - Starting segment number
   * @returns {Promise<Object>} FFmpeg process information
   */
  async transcodeStreamingSegment(strategy, audioVariant, videoPath, startNumber = 0) {
    const videoId = path.basename(videoPath, path.extname(videoPath));
    const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariant.label);
    await ensureDir(outputDir);
    
    const outputPattern = path.join(outputDir, '%03d.ts');
    
    // Build FFmpeg arguments for streaming segments
    const args = await this.buildStreamingSegmentArgs(
      strategy,
      videoPath,
      outputPattern,
      startNumber,
      audioVariant
    );

    console.log(`Starting streaming audio transcoding:`, args.join(' '));

    return new Promise((resolve, reject) => {
      const process = spawn(FFMPEG_PATH, args);
      const processId = `streaming_${audioVariant.label}`;
      
      this.activeProcesses.set(processId, process);

      let stderrOutput = '';

      process.stderr.on('data', (data) => {
        stderrOutput += data.toString();
        // Log progress periodically
        if (stderrOutput.includes('time=')) {
          const timeMatch = stderrOutput.match(/time=(\d+:\d+:\d+\.\d+)/);
          if (timeMatch) {
            console.log(`Audio transcoding progress: ${timeMatch[1]}`);
          }
        }
      });

      process.on('close', (code) => {
        this.activeProcesses.delete(processId);
        
        if (code === 0) {
          console.log(`Streaming audio transcoding completed`);
        } else {
          console.error(`Streaming audio transcoding failed with code ${code}:`, stderrOutput);
        }
      });

      process.on('error', (err) => {
        this.activeProcesses.delete(processId);
        console.error(`FFmpeg streaming process error:`, err);
        reject(err);
      });

      // Return process info immediately for streaming
      resolve({
        process: process,
        processId: processId,
        outputPattern: outputPattern
      });
    });
  }

  /**
   * Build FFmpeg arguments for explicit segment transcoding
   * @param {Object} strategy - Processing strategy
   * @param {string} inputPath - Input video path
   * @param {string} outputPath - Output segment path
   * @param {number} startSeconds - Start time in seconds
   * @param {number} durationSeconds - Duration in seconds
   * @param {Object} audioVariant - Audio variant configuration
   * @returns {Promise<Array>} FFmpeg arguments with validated encoders
   */
  async buildExplicitSegmentArgs(strategy, inputPath, outputPath, startSeconds, durationSeconds, audioVariant) {
    // Avoiding conflicting timestamp flags (-copyts, -avoid_negative_ts, -start_at_zero)
const args = [
      '-y', // Overwrite output files
      '-hide_banner', // Hide FFmpeg banner
      '-loglevel', 'info', // Set log level
      '-avoid_negative_ts', 'make_zero', // Avoid negative timestamps
      '-fflags', '+genpts' // Generate presentation timestamps to avoid drift
    ];

    // Input seeking - use pre-input seeking for better performance
    if (startSeconds > 0) {
      args.push('-ss', startSeconds.toString());
    }

    // Input file
    args.push('-i', inputPath);

    // Duration
    if (durationSeconds > 0) {
      args.push('-t', durationSeconds.toString());
    }

    // Audio stream selection
    if (audioVariant.trackIndex !== undefined) {
      args.push('-map', `0:a:${audioVariant.trackIndex}`);
    } else {
      args.push('-map', '0:a:0'); // First audio stream
    }

    // Add transcoding arguments from strategy with encoder validation
    if (strategy.args && strategy.args.length > 0) {
      const validatedArgs = await this.validateAndFixEncoderArgs(strategy.args);
      args.push(...validatedArgs);
    }

    // Reset PTS at segment start
    args.push('-reset_timestamps', '1');

    // Output format - always use MPEG-TS for audio segments
    args.push('-f', 'mpegts');

    // Output path
    args.push(outputPath);

    return args;
  }

  /**
   * Build FFmpeg arguments for streaming segment transcoding
   * @param {Object} strategy - Processing strategy
   * @param {string} inputPath - Input video path
   * @param {string} outputPattern - Output pattern for segments
   * @param {number} startNumber - Starting segment number
   * @param {Object} audioVariant - Audio variant configuration
   * @returns {Promise<Array>} FFmpeg arguments with validated encoders
   */
  async buildStreamingSegmentArgs(strategy, inputPath, outputPattern, startNumber, audioVariant) {
    const args = [
      '-y', // Overwrite output files
      '-hide_banner',
      '-loglevel', 'info'
    ];

    // Input file
    args.push('-i', inputPath);

    // Audio stream selection
    if (audioVariant.trackIndex !== undefined) {
      args.push('-map', `0:a:${audioVariant.trackIndex}`);
    } else {
      args.push('-map', '0:a:0');
    }

    // Add transcoding arguments from strategy with encoder validation
    if (strategy.args && strategy.args.length > 0) {
      const validatedArgs = await this.validateAndFixEncoderArgs(strategy.args);
      args.push(...validatedArgs);
    }

    // HLS segmentation options
    args.push(
      '-f', 'hls',
      '-hls_time', audioVariant.segmentDuration || '10',
      '-hls_list_size', '0', // Keep all segments in playlist
      '-hls_segment_filename', outputPattern,
      '-start_number', startNumber.toString()
    );

    // Output playlist
    const playlistPath = outputPattern.replace('%03d.ts', 'playlist.m3u8');
    args.push(playlistPath);

    return args;
  }

  /**
   * Validate and fix encoder arguments using the ffmpegValidator
   * @param {Array} args - Original strategy arguments
   * @returns {Promise<Array>} Fixed arguments with available encoders
   */
  async validateAndFixEncoderArgs(args) {
    try {
      const fixedArgs = [...args];
      const codecIndex = fixedArgs.findIndex(arg => arg === '-c:a');
      
      if (codecIndex !== -1 && codecIndex + 1 < fixedArgs.length) {
        const selectedEncoder = fixedArgs[codecIndex + 1];
        
        // Force clear the validator cache to ensure fresh detection
        ffmpegValidator.clearCache();
        
        // Special handling for eac3 and ac3 - directly test them
        if (selectedEncoder === 'eac3' || selectedEncoder === 'ac3') {
          // Remove incompatible parameters for Dolby encoders
          const profileIndex = fixedArgs.indexOf('-profile:a');
          if (profileIndex !== -1) {
            fixedArgs.splice(profileIndex, 2); // Remove both the flag and its value
          }
          
          // Remove VBR if present (not supported by eac3/ac3)
          const vbrIndex = fixedArgs.indexOf('-vbr:a');
          if (vbrIndex !== -1) {
            fixedArgs.splice(vbrIndex, 2); // Remove both the flag and its value
          }
          
          // Direct test for the encoder
          const encoderAvailable = await ffmpegValidator.testEncoder(selectedEncoder);
          if (encoderAvailable) {
            console.log(`${selectedEncoder.toUpperCase()} encoder is directly verified as available`);
            return fixedArgs; // Keep the encoder with fixed arguments
          } else {
            console.warn(`${selectedEncoder.toUpperCase()} encoder direct test failed, will try fallbacks`);
          }
        }
        
        // Check if the encoder is available
        const isAvailable = await ffmpegValidator.isAudioEncoderAvailable(selectedEncoder);
        
        if (!isAvailable) {
          console.warn(`Audio encoder ${selectedEncoder} not available, finding fallback...`);
          
          // Force clear cache and refresh encoders
          ffmpegValidator.clearCache();
          await ffmpegValidator.getAvailableEncoders();
          
          // Use the validator to find the best available encoder
          const preferences = ['eac3', 'libfdk_aac', 'aac', 'libmp3lame', 'ac3'];
          const bestEncoder = await ffmpegValidator.findBestAvailableAudioEncoder(preferences);
          
          if (bestEncoder) {
            console.log(`Replacing ${selectedEncoder} with ${bestEncoder}`);
            fixedArgs[codecIndex + 1] = bestEncoder;
            
            // Add appropriate profile for native aac
            if (bestEncoder === 'aac' && !fixedArgs.includes('-profile:a')) {
              fixedArgs.push('-profile:a', 'aac_low');
            } else if (bestEncoder === 'eac3' || bestEncoder === 'ac3') {
              // Remove profile and vbr parameters - not applicable to dolby encoders
              const profileIndex = fixedArgs.indexOf('-profile:a');
              if (profileIndex !== -1) {
                fixedArgs.splice(profileIndex, 2); // Remove both the flag and its value
              }
              
              // Remove VBR if present (not supported by eac3/ac3)
              const vbrIndex = fixedArgs.indexOf('-vbr:a');
              if (vbrIndex !== -1) {
                fixedArgs.splice(vbrIndex, 2); // Remove both the flag and its value
              }
            }
          } else {
            // Last resort fallback
            console.warn('No suitable encoder found, using native aac as fallback');
            fixedArgs[codecIndex + 1] = 'aac';
            if (!fixedArgs.includes('-profile:a')) {
              fixedArgs.push('-profile:a', 'aac_low');
            }
          }
        } else {
          console.log(`Audio encoder ${selectedEncoder} is available`);
        }
      }
      
      return fixedArgs;
    } catch (err) {
      console.warn(`Error validating encoder arguments: ${err.message}, using original arguments`);
      return args;
    }
  }

  /**
   * Stop active transcoding process
   * @param {string} processId - Process identifier
   * @returns {boolean} True if process was stopped
   */
  stopProcess(processId) {
    const process = this.activeProcesses.get(processId);
    if (process) {
      process.kill('SIGTERM');
      this.activeProcesses.delete(processId);
      console.log(`Stopped audio transcoding process: ${processId}`);
      return true;
    }
    return false;
  }

  /**
   * Stop all active processes
   */
  stopAllProcesses() {
    for (const [processId, process] of this.activeProcesses) {
      process.kill('SIGTERM');
      console.log(`Stopped audio transcoding process: ${processId}`);
    }
    this.activeProcesses.clear();
  }

  /**
   * Get status of active processes
   * @returns {Array} Active process information
   */
  getActiveProcesses() {
    return Array.from(this.activeProcesses.keys()).map(processId => ({
      id: processId,
      pid: this.activeProcesses.get(processId).pid
    }));
  }

  /**
   * Check if segment file exists and is valid
   * @param {string} segmentPath - Path to segment file
   * @returns {Promise<boolean>} True if segment is valid
   */
  async validateSegment(segmentPath) {
    try {
      const stats = await fs.stat(segmentPath);
      
      // Check if file exists and has content
      if (stats.size === 0) {
        console.warn(`Audio segment is empty: ${segmentPath}`);
        return false;
      }

      // Minimum viable segment size (1KB)
      if (stats.size < 1024) {
        console.warn(`Audio segment too small: ${segmentPath} (${stats.size} bytes)`);
        return false;
      }

      return true;
    } catch (err) {
      console.warn(`Audio segment validation failed: ${segmentPath}`, err);
      return false;
    }
  }

  /**
   * Clean up old segment files
   * @param {Object} audioVariant - Audio variant configuration
   * @param {number} keepCount - Number of recent segments to keep
   */
  async cleanupOldSegments(audioVariant, keepCount = 10) {
    try {
      const videoId = audioVariant.videoId; // Assume this is available
      const outputDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), audioVariant.label);
      
      const files = await fs.readdir(outputDir);
      
      const segmentFiles = files
        .filter(file => file.endsWith('.ts') && /\d{3}\.ts$/.test(file))
        .map(file => ({
          name: file,
          path: path.join(outputDir, file),
          number: this.extractSegmentNumber(file)
        }))
        .filter(file => file.number !== null)
        .sort((a, b) => b.number - a.number); // Sort by segment number, newest first

      // Keep only the most recent segments
      const filesToDelete = segmentFiles.slice(keepCount);
      
      for (const file of filesToDelete) {
        try {
          await fs.unlink(file.path);
          console.log(`Cleaned up old audio segment: ${file.name}`);
        } catch (err) {
          console.warn(`Failed to delete old segment: ${file.name}`, err);
        }
      }
    } catch (err) {
      console.warn(`Segment cleanup failed:`, err);
    }
  }

  /**
   * Extract segment number from filename
   * @param {string} filename - Segment filename
   * @returns {number|null} Segment number or null if not found
   */
  extractSegmentNumber(filename) {
    const match = filename.match(/(\d{3})\.ts$/);
    return match ? parseInt(match[1], 10) : null;
  }
}

module.exports = { AudioSegmentTranscoder };
