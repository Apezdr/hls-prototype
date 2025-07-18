// services/audio/index.js

/**
 * Audio Services Module
 * Provides unified access to all audio-related services
 */

// Import all audio service modules
const { AudioCodecManager } = require('./audioCodecManager');
const { AudioBitrateCalculator } = require('./audioBitrateCalculator');
const { AudioStreamValidator } = require('./audioStreamValidator');
const { AudioVBRManager } = require('./audioVBRManager');
const { AudioSegmentTranscoder } = require('./audioSegmentTranscoder');
const { AudioQualityOptimizer } = require('./audioQualityOptimizer');

/**
 * Audio Processing Pipeline
 * Combines all audio services into a unified processing interface
 */
class AudioProcessingPipeline {
  constructor() {
    this.codecManager = new AudioCodecManager();
    this.bitrateCalculator = new AudioBitrateCalculator();
    this.streamValidator = new AudioStreamValidator();
    this.vbrManager = new AudioVBRManager();
    this.segmentTranscoder = new AudioSegmentTranscoder();
    this.qualityOptimizer = new AudioQualityOptimizer();
  }

  /**
   * Process audio stream configuration for transcoding
   * @param {Object} sourceStream - Source audio stream information
   * @param {Object} targetVariant - Target audio variant configuration
   * @param {Object} options - Processing options
   * @returns {Object} Complete audio processing strategy
   */
  async processAudioStream(sourceStream, targetVariant, options = {}) {
    try {
      // 1. Check if we can stream copy (but for explicit segments, we can't)
      const canCopy = this.streamValidator.canStreamCopy(sourceStream, targetVariant, 'explicit');
      
      // 2. Select appropriate encoder using the codec manager's encoder registry
      const encoder = this.codecManager.encoderRegistry.selectOptimalEncoder(
        targetVariant.codec,
        targetVariant.channels || sourceStream.channels || 2,
        16, // bit depth
        'ts' // container
      );

      if (!encoder) {
        throw new Error(`No suitable encoder found for codec: ${targetVariant.codec}`);
      }

      // 3. Calculate optimal bitrate (use simple calculation for now)
      const baseBitrate = targetVariant.bitrate || 128000;
      const channels = targetVariant.channels || sourceStream.channels || 2;
      const bitrate = Math.max(baseBitrate, channels * 64000); // 64kbps per channel minimum

      // 4. Configure VBR if beneficial
      const vbrConfig = this.vbrManager.getVBRConfig(
        encoder.name,
        bitrate,
        channels,
        options.enableVBR !== false,
        options.contentType || 'mixed'
      );

      // 5. Apply quality optimizations
      const qualityOptimization = this.qualityOptimizer.optimizeForContent(
        sourceStream,
        targetVariant,
        options.contentType || 'mixed',
        {
          deviceType: options.deviceType || 'desktop',
          normalizeLoudness: options.normalizeLoudness
        }
      );

      // 6. Build final transcoding strategy
      const strategy = {
        // Basic configuration
        encoder: encoder.name,
        container: 'ts',
        bitrate: bitrate,
        channels: Math.min(channels, encoder.maxChannels),
        sampleRate: targetVariant.sampleRate || sourceStream.sampleRate || 48000,
        
        // Advanced options
        vbr: vbrConfig,
        filters: qualityOptimization.filters || [],
        
        // FFmpeg arguments
        args: this.buildFFmpegArgs(encoder, bitrate, vbrConfig, qualityOptimization),
        
        // Metadata
        metadata: {
          sourceCodec: sourceStream.codec,
          targetCodec: encoder.name,
          qualityLevel: encoder.quality,
          optimization: qualityOptimization.description || 'Standard audio processing',
          canCopy: canCopy === true
        }
      };

      return strategy;
    } catch (error) {
      console.error('Audio processing pipeline error:', error);
      // Return a basic fallback strategy
      return {
        encoder: targetVariant.codec || 'aac',
        container: 'ts',
        bitrate: targetVariant.bitrate || 128000,
        channels: targetVariant.channels || sourceStream.channels || 2,
        sampleRate: targetVariant.sampleRate || sourceStream.sampleRate || 48000,
        vbr: null,
        filters: [],
        args: [
          '-c:a', targetVariant.codec || 'aac',
          '-b:a', String(targetVariant.bitrate || 128000),
          '-ac', String(targetVariant.channels || sourceStream.channels || 2),
          '-ar', String(targetVariant.sampleRate || sourceStream.sampleRate || 48000)
        ],
        metadata: {
          sourceCodec: sourceStream.codec,
          targetCodec: targetVariant.codec || 'aac',
          qualityLevel: 'fallback',
          optimization: 'Basic fallback configuration',
          canCopy: false
        }
      };
    }
  }

  /**
   * Build FFmpeg arguments from processing strategy
   * @param {Object} encoder - Selected encoder info
   * @param {number} bitrate - Target bitrate
   * @param {Object} vbrConfig - VBR configuration
   * @param {Object} qualityOptimization - Quality optimization settings
   * @returns {Array} FFmpeg arguments
   */
  buildFFmpegArgs(encoder, bitrate, vbrConfig, qualityOptimization) {
    const args = [];

    // Audio codec
    args.push('-c:a', encoder.name);

    // Bitrate/VBR configuration
    if (vbrConfig && vbrConfig.enabled) {
      // Use VBR arguments
      args.push(...vbrConfig.args);
    } else {
      // Use CBR
      args.push('-b:a', bitrate.toString());
    }

    // Channel configuration
    if (qualityOptimization.channels) {
      args.push('-ac', qualityOptimization.channels.toString());
    }

    // Sample rate
    if (qualityOptimization.sampleRate) {
      args.push('-ar', qualityOptimization.sampleRate.toString());
    }

    // Audio filters
    if (qualityOptimization.filters && qualityOptimization.filters.length > 0) {
      try {
        const filterChain = qualityOptimization.filters.join(',');
        if (filterChain) {
          args.push('-af', filterChain);
        }
      } catch (err) {
        console.warn('Error building filter chain:', err);
      }
    }

    // Encoder-specific arguments
    if (encoder.extraArgs && encoder.extraArgs.length > 0) {
      args.push(...encoder.extraArgs);
    }

    return args;
  }

  /**
   * Transcode audio segment using the processing pipeline
   * @param {Object} strategy - Audio processing strategy
   * @param {Object} audioVariant - Audio variant configuration
   * @param {string} videoPath - Source video path
   * @param {number} segmentNumber - Segment number
   * @param {number} startTicks - Start time in ticks
   * @param {number} durationTicks - Duration in ticks
   * @returns {Promise<string>} Path to transcoded segment
   */
  async transcodeSegment(strategy, audioVariant, videoPath, segmentNumber, startTicks, durationTicks) {
    try {
      return await this.segmentTranscoder.transcodeExplicitSegment(
        strategy,
        audioVariant,
        videoPath,
        segmentNumber,
        startTicks,
        durationTicks
      );
    } catch (error) {
      console.error('Audio segment transcoding error:', error);
      throw error;
    }
  }

  /**
   * Start streaming audio transcoding
   * @param {Object} strategy - Audio processing strategy
   * @param {Object} audioVariant - Audio variant configuration
   * @param {string} videoPath - Source video path
   * @param {number} startNumber - Starting segment number
   * @returns {Promise<Object>} FFmpeg process information
   */
  async startStreamingTranscode(strategy, audioVariant, videoPath, startNumber = 0) {
    try {
      return await this.segmentTranscoder.transcodeStreamingSegment(
        strategy,
        audioVariant,
        videoPath,
        startNumber
      );
    } catch (error) {
      console.error('Audio streaming transcoding error:', error);
      throw error;
    }
  }
}

// Export individual services and the processing pipeline
module.exports = {
  // Individual services
  AudioCodecManager,
  AudioBitrateCalculator,
  AudioStreamValidator,
  AudioVBRManager,
  AudioSegmentTranscoder,
  AudioQualityOptimizer,
  
  // Unified processing pipeline
  AudioProcessingPipeline
};
