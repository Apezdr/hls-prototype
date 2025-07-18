// services/audioStreamValidator.js

/**
 * Audio Stream Validator
 * Determines when audio can be stream copied vs when transcoding is required
 */
class AudioStreamValidator {
  constructor() {
    // Web-supported codecs for direct playback
    this.webSupportedCodecs = [
      'aac', 'mp3', 'opus', 'vorbis', 'flac'
    ];
    
    // Codecs that generally work with copy mode
    this.copyCompatibleCodecs = [
      'aac', 'mp3', 'ac3', 'eac3', 'opus', 'vorbis', 'flac', 'alac'
    ];
  }

  /**
   * Main copy compatibility check
   * @param {Object} sourceStream - Source audio stream info
   * @param {Object} targetVariant - Target audio variant
   * @param {string} segmentType - Type of segmentation ('explicit', 'streaming', 'progressive')
   * @returns {boolean|Object} True if copy compatible, object with reason if not
   */
  canStreamCopy(sourceStream, targetVariant, segmentType = 'streaming') {
    // Check each compatibility factor
    const codecCheck = this.validateCodec(sourceStream, targetVariant);
    if (codecCheck !== true) {
      return { compatible: false, reason: codecCheck.reason };
    }

    const channelCheck = this.validateChannels(sourceStream, targetVariant);
    if (channelCheck !== true) {
      return { compatible: false, reason: channelCheck.reason };
    }

    const bitrateCheck = this.validateBitrate(sourceStream, targetVariant);
    if (bitrateCheck !== true) {
      return { compatible: false, reason: bitrateCheck.reason };
    }

    const sampleRateCheck = this.validateSampleRate(sourceStream, targetVariant);
    if (sampleRateCheck !== true) {
      return { compatible: false, reason: sampleRateCheck.reason };
    }

    const segmentCheck = this.validateSegmentCompatibility(segmentType);
    if (segmentCheck !== true) {
      return { compatible: false, reason: segmentCheck.reason };
    }

    const containerCheck = this.validateContainerCompatibility(sourceStream, targetVariant);
    if (containerCheck !== true) {
      return { compatible: false, reason: containerCheck.reason };
    }

    return true;
  }

  /**
   * Validate codec compatibility
   * @param {Object} sourceStream - Source audio stream
   * @param {Object} targetVariant - Target variant
   * @returns {boolean|Object} Compatibility result
   */
  validateCodec(sourceStream, targetVariant) {
    const sourceCodec = sourceStream.codec?.toLowerCase();
    const targetCodec = targetVariant.codec?.toLowerCase();

    if (!sourceCodec || !targetCodec) {
      return { reason: 'Missing codec information' };
    }

    // Exact match is always compatible
    if (sourceCodec === targetCodec) {
      return true;
    }

    // Check for codec aliases (h264/avc, h265/hevc, etc.)
    if (this.areCodecAliases(sourceCodec, targetCodec)) {
      return true;
    }

    // Different codecs require transcoding
    return { reason: `Codec mismatch: ${sourceCodec} -> ${targetCodec}` };
  }

  /**
   * Validate channel configuration
   * @param {Object} sourceStream - Source audio stream
   * @param {Object} targetVariant - Target variant
   * @returns {boolean|Object} Compatibility result
   */
  validateChannels(sourceStream, targetVariant) {
    const sourceChannels = sourceStream.channels || 2;
    const targetChannels = targetVariant.channels;

    // If target doesn't specify channels, assume compatible
    if (!targetChannels) {
      return true;
    }

    // Exact match
    if (sourceChannels === targetChannels) {
      return true;
    }

    // Check if downmixing is requested
    if (targetChannels < sourceChannels) {
      return { reason: `Channel downmix required: ${sourceChannels} -> ${targetChannels}` };
    }

    // Upmixing generally not supported in copy mode
    if (targetChannels > sourceChannels) {
      return { reason: `Channel upmix required: ${sourceChannels} -> ${targetChannels}` };
    }

    return true;
  }

  /**
   * Validate bitrate compatibility
   * @param {Object} sourceStream - Source audio stream
   * @param {Object} targetVariant - Target variant
   * @returns {boolean|Object} Compatibility result
   */
  validateBitrate(sourceStream, targetVariant) {
    const sourceBitrate = sourceStream.bitRate;
    const targetBitrate = targetVariant.bitrate;

    // If no target bitrate specified, assume compatible
    if (!targetBitrate) {
      return true;
    }

    // If no source bitrate info, assume compatible
    if (!sourceBitrate) {
      return true;
    }

    // Check if source exceeds target by significant margin
    const bitrateRatio = sourceBitrate / targetBitrate;
    
    // Allow some tolerance (10%)
    if (bitrateRatio > 1.1) {
      return { reason: `Source bitrate too high: ${sourceBitrate} > ${targetBitrate}` };
    }

    return true;
  }

  /**
   * Validate sample rate compatibility
   * @param {Object} sourceStream - Source audio stream
   * @param {Object} targetVariant - Target variant
   * @returns {boolean|Object} Compatibility result
   */
  validateSampleRate(sourceStream, targetVariant) {
    const sourceSampleRate = sourceStream.sampleRate;
    const targetSampleRate = targetVariant.sampleRate;

    // If no target sample rate specified, assume compatible
    if (!targetSampleRate) {
      return true;
    }

    // If no source sample rate info, assume compatible
    if (!sourceSampleRate) {
      return true;
    }

    // Exact match
    if (sourceSampleRate === targetSampleRate) {
      return true;
    }

    // Different sample rates require resampling
    return { reason: `Sample rate mismatch: ${sourceSampleRate} -> ${targetSampleRate}` };
  }

  /**
   * Validate segment type compatibility with copy mode
   * @param {string} segmentType - Type of segmentation
   * @returns {boolean|Object} Compatibility result
   */
  validateSegmentCompatibility(segmentType) {
    switch (segmentType) {
      case 'explicit':
        // Copy mode fails with precise seeking for explicit segments
        return { reason: 'Copy mode incompatible with explicit segment seeking' };
        
      case 'streaming':
      case 'progressive':
        // These are compatible with copy mode
        return true;
        
      default:
        return true;
    }
  }

  /**
   * Validate container compatibility
   * @param {Object} sourceStream - Source audio stream
   * @param {Object} targetVariant - Target variant
   * @returns {boolean|Object} Compatibility result
   */
  validateContainerCompatibility(sourceStream, targetVariant) {
    // Check for specific codec/container combinations that don't work
    const sourceCodec = sourceStream.codec?.toLowerCase();
    const targetContainer = targetVariant.container?.toLowerCase();

    // TrueHD needs special handling
    if (sourceCodec === 'truehd') {
      return { reason: 'TrueHD requires transcoding for web compatibility' };
    }

    // DTS in HLS/web containers needs transcoding
    if (sourceCodec === 'dts' && (targetContainer === 'hls' || targetContainer === 'm3u8')) {
      return { reason: 'DTS not compatible with HLS containers' };
    }

    // Check for ADTS header compatibility
    if (sourceCodec === 'aac' && targetContainer === 'mp4') {
      // May need bitstream filtering, but generally compatible
      return true;
    }

    return true;
  }

  /**
   * Check if two codec names are aliases for the same codec
   * @param {string} codec1 - First codec name
   * @param {string} codec2 - Second codec name
   * @returns {boolean} True if they're aliases
   */
  areCodecAliases(codec1, codec2) {
    const aliases = {
      'aac': ['aac', 'aac_latm'],
      'h264': ['h264', 'avc'],
      'h265': ['h265', 'hevc'],
      'ac3': ['ac3', 'dolby_digital'],
      'eac3': ['eac3', 'dolby_digital_plus'],
      'dts': ['dts', 'dca']
    };

    for (const [canonical, codecList] of Object.entries(aliases)) {
      if (codecList.includes(codec1) && codecList.includes(codec2)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if codec is web-compatible for direct playback
   * @param {string} codec - Codec name
   * @returns {boolean} True if web-compatible
   */
  isWebCompatible(codec) {
    return this.webSupportedCodecs.includes(codec.toLowerCase());
  }

  /**
   * Check if codec generally supports copy mode
   * @param {string} codec - Codec name
   * @returns {boolean} True if copy-compatible
   */
  isCopyCompatible(codec) {
    return this.copyCompatibleCodecs.includes(codec.toLowerCase());
  }

  /**
   * Get copy incompatibility reasons for troubleshooting
   * @param {Object} sourceStream - Source audio stream
   * @param {Object} targetVariant - Target variant
   * @param {string} segmentType - Segment type
   * @returns {Array} List of incompatibility reasons
   */
  getIncompatibilityReasons(sourceStream, targetVariant, segmentType = 'streaming') {
    const reasons = [];

    const codecCheck = this.validateCodec(sourceStream, targetVariant);
    if (codecCheck !== true) reasons.push(codecCheck.reason);

    const channelCheck = this.validateChannels(sourceStream, targetVariant);
    if (channelCheck !== true) reasons.push(channelCheck.reason);

    const bitrateCheck = this.validateBitrate(sourceStream, targetVariant);
    if (bitrateCheck !== true) reasons.push(bitrateCheck.reason);

    const sampleRateCheck = this.validateSampleRate(sourceStream, targetVariant);
    if (sampleRateCheck !== true) reasons.push(sampleRateCheck.reason);

    const segmentCheck = this.validateSegmentCompatibility(segmentType);
    if (segmentCheck !== true) reasons.push(segmentCheck.reason);

    const containerCheck = this.validateContainerCompatibility(sourceStream, targetVariant);
    if (containerCheck !== true) reasons.push(containerCheck.reason);

    return reasons;
  }

  /**
   * Suggest optimal transcoding parameters when copy is not possible
   * @param {Object} sourceStream - Source audio stream
   * @param {Object} targetVariant - Target variant
   * @returns {Object} Suggested transcoding parameters
   */
  suggestTranscodingParams(sourceStream, targetVariant) {
    const suggestions = {
      codec: targetVariant.codec || 'aac',
      channels: Math.min(sourceStream.channels || 2, targetVariant.channels || 6),
      sampleRate: targetVariant.sampleRate || sourceStream.sampleRate || 48000,
      bitrate: null // Will be calculated by BitrateCalculator
    };

    // Codec-specific optimizations
    switch (suggestions.codec.toLowerCase()) {
      case 'aac':
        // AAC works well for most content
        if (suggestions.channels > 6) suggestions.channels = 6;
        break;
        
      case 'mp3':
        // MP3 limited to stereo
        suggestions.channels = Math.min(suggestions.channels, 2);
        break;
        
      case 'opus':
        // Opus is very efficient, can handle more channels
        break;
        
      case 'ac3':
        // AC3 limited to 5.1
        suggestions.channels = Math.min(suggestions.channels, 6);
        break;
    }

    return suggestions;
  }
}

module.exports = { AudioStreamValidator };
