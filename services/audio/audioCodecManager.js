// services/audioCodecManager.js
const { AudioEncoderRegistry } = require('./audioEncoderRegistry');
const { AudioBitrateCalculator } = require('./audioBitrateCalculator');
const { AudioStreamValidator } = require('./audioStreamValidator');
const { AudioVBRManager } = require('./audioVBRManager');
const { AudioSegmentTranscoder } = require('./audioSegmentTranscoder');
const { AudioQualityOptimizer } = require('./audioQualityOptimizer');

/**
 * Comprehensive Audio Codec Management System
 */
class AudioCodecManager {
  constructor() {
    this.encoderRegistry = new AudioEncoderRegistry();
    this.bitrateCalculator = new AudioBitrateCalculator();
    this.streamValidator = new AudioStreamValidator();
    this.vbrManager = new AudioVBRManager();
    this.segmentTranscoder = new AudioSegmentTranscoder();
    this.qualityOptimizer = new AudioQualityOptimizer();
  }

  /**
   * Main decision point: determine audio processing strategy
   * @param {Object} sourceStream - Source audio stream info
   * @param {Object} targetVariant - Target audio variant
   * @param {string} segmentType - 'explicit', 'streaming', or 'progressive'
   * @param {Object} options - Additional options
   * @returns {Object} Audio processing strategy
   */
  determineAudioStrategy(sourceStream, targetVariant, segmentType = 'streaming', options = {}) {
    // Validate inputs
    if (!sourceStream || !targetVariant) {
      throw new Error('Source stream and target variant are required');
    }

    // Check if we can stream copy
    const canCopy = this.streamValidator.canStreamCopy(sourceStream, targetVariant, segmentType);
    
    if (canCopy && !options.forceTranscode) {
      return {
        action: 'copy',
        codec: 'copy',
        args: [],
        filters: [],
        reason: 'Stream copy compatible'
      };
    }

    // Need to transcode - select optimal encoder
    const encoder = this.encoderRegistry.selectOptimalEncoder(
      targetVariant.codec, 
      targetVariant.channels || sourceStream.channels,
      sourceStream.bitDepth || 16
    );

    if (!encoder) {
      throw new Error(`No suitable encoder found for codec: ${targetVariant.codec}`);
    }

    // Calculate optimal bitrate
    const bitrate = this.bitrateCalculator.calculateOptimalBitrate(
      targetVariant.codec,
      targetVariant.channels || sourceStream.channels,
      sourceStream.bitRate,
      options.highQuality || false
    );

    // Determine if VBR should be used
    const vbrConfig = this.vbrManager.getVBRConfig(
      encoder.name,
      bitrate,
      targetVariant.channels || sourceStream.channels,
      options.enableVBR
    );

    // Get content-aware optimizations
    const contentOptimizations = this.qualityOptimizer.optimizeForContent(
      sourceStream,
      targetVariant,
      options.contentType || 'mixed'
    );

    return {
      action: 'transcode',
      encoder: encoder,
      codec: encoder.name,
      bitrate: bitrate,
      channels: Math.min(
        targetVariant.channels || sourceStream.channels,
        encoder.maxChannels
      ),
      sampleRate: targetVariant.sampleRate || sourceStream.sampleRate,
      vbr: vbrConfig,
      filters: contentOptimizations.filters,
      args: this.buildTranscodeArgs(encoder, bitrate, vbrConfig, contentOptimizations),
      reason: `Transcoding required: ${canCopy.reason || 'compatibility'}`
    };
  }

  /**
   * Build FFmpeg arguments for transcoding
   * @param {Object} encoder - Selected encoder
   * @param {number} bitrate - Target bitrate
   * @param {Object} vbrConfig - VBR configuration
   * @param {Object} optimizations - Content optimizations
   * @returns {Array} FFmpeg arguments
   */
  buildTranscodeArgs(encoder, bitrate, vbrConfig, optimizations) {
    const args = [];

    // Codec selection
    args.push('-c:a', encoder.name);

    // Bitrate/VBR configuration
    if (vbrConfig && vbrConfig.enabled) {
      args.push(...vbrConfig.args);
    } else {
      args.push('-b:a', `${bitrate}`);
    }

    // Channel configuration
    if (optimizations.channels) {
      args.push('-ac', optimizations.channels.toString());
    }

    // Sample rate
    if (optimizations.sampleRate) {
      args.push('-ar', optimizations.sampleRate.toString());
    }

    // Encoder-specific optimizations
    if (encoder.extraArgs) {
      args.push(...encoder.extraArgs);
    }

    return args;
  }

  /**
   * Process explicit audio segment with proper handling
   * @param {Object} audioVariant - Audio variant info
   * @param {string} videoPath - Source video path
   * @param {number} segmentNumber - Segment number
   * @param {number} startTicks - Start time in ticks
   * @param {number} durationTicks - Duration in ticks
   * @param {Object} options - Additional options
   * @returns {Promise<string>} Path to transcoded segment
   */
  async processExplicitSegment(audioVariant, videoPath, segmentNumber, startTicks, durationTicks, options = {}) {
    const sourceStream = await this.getSourceAudioInfo(videoPath, audioVariant.trackIndex);
    
    // Force transcoding for explicit segments (copy mode fails with precise seeking)
    const strategy = this.determineAudioStrategy(
      sourceStream, 
      audioVariant, 
      'explicit',
      { ...options, forceTranscode: true }
    );

    return this.segmentTranscoder.transcodeExplicitSegment(
      strategy,
      audioVariant,
      videoPath,
      segmentNumber,
      startTicks,
      durationTicks
    );
  }

  /**
   * Process streaming audio segment
   * @param {Object} audioVariant - Audio variant info
   * @param {string} videoPath - Source video path
   * @param {number} startNumber - Starting segment number
   * @param {Object} options - Additional options
   * @returns {Promise} FFmpeg process
   */
  async processStreamingSegment(audioVariant, videoPath, startNumber = 0, options = {}) {
    const sourceStream = await this.getSourceAudioInfo(videoPath, audioVariant.trackIndex);
    
    const strategy = this.determineAudioStrategy(
      sourceStream, 
      audioVariant, 
      'streaming',
      options
    );

    return this.segmentTranscoder.transcodeStreamingSegment(
      strategy,
      audioVariant,
      videoPath,
      startNumber
    );
  }

  /**
   * Get source audio stream information
   * @param {string} videoPath - Path to video file
   * @param {number} trackIndex - Audio track index
   * @returns {Promise<Object>} Audio stream info
   */
  async getSourceAudioInfo(videoPath, trackIndex) {
    // This would interface with your existing audio analysis utilities
    const { getAudioChannelCount, getAudioCodec } = require('../../utils/audio');
    const { getMediaInfo } = require('../../utils/ffprobe');
    
    try {
      const [channels, codec, mediaInfo] = await Promise.all([
        getAudioChannelCount(videoPath, trackIndex),
        getAudioCodec(videoPath, trackIndex),
        getMediaInfo(videoPath)
      ]);

      const audioStream = mediaInfo.streams?.find(s => 
        s.codec_type === 'audio' && s.index === trackIndex
      );

      return {
        channels: channels,
        codec: codec,
        bitRate: audioStream?.bit_rate ? parseInt(audioStream.bit_rate) : null,
        sampleRate: audioStream?.sample_rate ? parseInt(audioStream.sample_rate) : null,
        bitDepth: audioStream?.bits_per_sample || 16,
        profile: audioStream?.profile,
        duration: audioStream?.duration ? parseFloat(audioStream.duration) : null
      };
    } catch (err) {
      console.warn(`Error getting audio info for track ${trackIndex}:`, err);
      // Return safe defaults
      return {
        channels: 2,
        codec: 'aac',
        bitRate: 128000,
        sampleRate: 48000,
        bitDepth: 16
      };
    }
  }

  /**
   * Validate encoder availability
   * @returns {Promise<Object>} Available encoders
   */
  async validateEncoders() {
    return this.encoderRegistry.validateAvailableEncoders();
  }

  /**
   * Get supported audio codecs
   * @returns {Array<string>} Supported codec names
   */
  getSupportedCodecs() {
    return this.encoderRegistry.getSupportedCodecs();
  }

  /**
   * Get encoder information
   * @param {string} codec - Codec name
   * @returns {Object} Encoder information
   */
  getEncoderInfo(codec) {
    return this.encoderRegistry.getEncoderInfo(codec);
  }
}

module.exports = { AudioCodecManager };
