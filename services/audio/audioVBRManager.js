// services/audioVBRManager.js

/**
 * Audio VBR (Variable Bitrate) Manager
 * Handles quality-based encoding decisions and VBR parameter generation
 */
class AudioVBRManager {
  /**
   * VBR configurations for different encoders
   * Based on encoder-specific VBR implementations
   */
  static VBR_CONFIGS = {
    libfdk_aac: {
      type: 'vbr',
      parameter: '-vbr:a',
      ranges: [
        { maxBitrate: 32000, mode: 1, description: 'Very low quality' },
        { maxBitrate: 48000, mode: 2, description: 'Low quality' },
        { maxBitrate: 64000, mode: 3, description: 'Medium quality' },
        { maxBitrate: 96000, mode: 4, description: 'High quality' },
        { maxBitrate: Infinity, mode: 5, description: 'Very high quality' }
      ]
    },
    libmp3lame: {
      type: 'hybrid', // Can use VBR or ABR
      vbrParameter: '-qscale:a',
      abrParameter: '-abr:a',
      vbrThreshold: { min: 48000, max: 122500 }, // VBR works well in this range
      vbrRanges: [
        { maxBitrate: 64000, quality: 6, description: 'Low quality VBR' },
        { maxBitrate: 88000, quality: 4, description: 'Medium quality VBR' },
        { maxBitrate: 112000, quality: 2, description: 'High quality VBR' },
        { maxBitrate: Infinity, quality: 0, description: 'Highest quality VBR' }
      ]
    },
    aac_at: {
      type: 'cvbr', // Constrained VBR
      parameter: '-aac_at_mode:a',
      mode: 2, // CVBR mode
      bitrateParameter: '-b:a'
    },
    libvorbis: {
      type: 'quality',
      parameter: '-qscale:a',
      ranges: [
        { maxBitrate: 40000, quality: 0, description: 'Low quality' },
        { maxBitrate: 56000, quality: 2, description: 'Medium-low quality' },
        { maxBitrate: 80000, quality: 4, description: 'Medium quality' },
        { maxBitrate: 112000, quality: 6, description: 'High quality' },
        { maxBitrate: Infinity, quality: 8, description: 'Highest quality' }
      ]
    },
    libopus: {
      type: 'vbr',
      parameter: '-vbr',
      value: 'on',
      bitrateParameter: '-b:a' // Opus VBR still uses target bitrate
    }
  };

  /**
   * Default quality preferences by content type
   */
  static CONTENT_QUALITY_PREFERENCES = {
    music: { preferVBR: true, qualityBoost: 1.2 },
    speech: { preferVBR: false, qualityBoost: 0.8 },
    mixed: { preferVBR: true, qualityBoost: 1.0 },
    effects: { preferVBR: true, qualityBoost: 1.1 },
    broadcast: { preferVBR: false, qualityBoost: 0.9 }
  };

  /**
   * Get VBR configuration for encoder and target bitrate
   * @param {string} encoderName - Encoder name
   * @param {number} targetBitrate - Target bitrate in bps
   * @param {number} channels - Number of channels
   * @param {boolean} enableVBR - Whether VBR is enabled
   * @param {string} contentType - Content type for optimization
   * @returns {Object|null} VBR configuration or null if not applicable
   */
  getVBRConfig(encoderName, targetBitrate, channels = 2, enableVBR = true, contentType = 'mixed') {
    if (!enableVBR) {
      return null;
    }

    const config = AudioVBRManager.VBR_CONFIGS[encoderName];
    if (!config) {
      return null; // Encoder doesn't support VBR
    }

    const contentPref = AudioVBRManager.CONTENT_QUALITY_PREFERENCES[contentType] || 
                       AudioVBRManager.CONTENT_QUALITY_PREFERENCES.mixed;

    if (!contentPref.preferVBR) {
      return null; // Content type doesn't benefit from VBR
    }

    // Adjust target bitrate based on content type
    const adjustedBitrate = Math.floor(targetBitrate * contentPref.qualityBoost);

    return this.buildVBRArgs(config, adjustedBitrate, channels, encoderName);
  }

  /**
   * Build VBR arguments for specific encoder configuration
   * @param {Object} config - VBR configuration
   * @param {number} bitrate - Target bitrate
   * @param {number} channels - Number of channels
   * @param {string} encoderName - Encoder name
   * @returns {Object} VBR arguments and settings
   */
  buildVBRArgs(config, bitrate, channels, encoderName) {
    switch (config.type) {
      case 'vbr':
        return this.buildStandardVBR(config, bitrate, channels);
        
      case 'hybrid':
        return this.buildHybridVBR(config, bitrate, channels);
        
      case 'cvbr':
        return this.buildConstrainedVBR(config, bitrate, channels);
        
      case 'quality':
        return this.buildQualityVBR(config, bitrate, channels);
        
      default:
        console.warn(`Unknown VBR type: ${config.type} for encoder: ${encoderName}`);
        return null;
    }
  }

  /**
   * Build standard VBR arguments (libfdk_aac style)
   * @param {Object} config - VBR configuration
   * @param {number} bitrate - Target bitrate
   * @param {number} channels - Number of channels
   * @returns {Object} VBR configuration
   */
  buildStandardVBR(config, bitrate, channels) {
    // Calculate per-channel bitrate for quality selection
    const bitratePerChannel = bitrate / Math.max(channels, 1);
    
    // Find appropriate VBR mode
    const range = config.ranges.find(r => bitratePerChannel <= r.maxBitrate);
    const vbrMode = range ? range.mode : config.ranges[config.ranges.length - 1].mode;

    return {
      enabled: true,
      type: 'vbr',
      args: [config.parameter, vbrMode.toString()],
      description: range ? range.description : 'High quality VBR',
      estimatedBitrate: bitrate
    };
  }

  /**
   * Build hybrid VBR/ABR arguments (libmp3lame style)
   * @param {Object} config - VBR configuration
   * @param {number} bitrate - Target bitrate
   * @param {number} channels - Number of channels
   * @returns {Object} VBR configuration
   */
  buildHybridVBR(config, bitrate, channels) {
    const bitratePerChannel = bitrate / Math.max(channels, 1);
    
    // Check if bitrate is in VBR-friendly range
    const useVBR = bitratePerChannel >= config.vbrThreshold.min && 
                   bitratePerChannel <= config.vbrThreshold.max;

    if (useVBR) {
      // Use VBR mode
      const range = config.vbrRanges.find(r => bitratePerChannel <= r.maxBitrate);
      const quality = range ? range.quality : config.vbrRanges[config.vbrRanges.length - 1].quality;

      return {
        enabled: true,
        type: 'vbr',
        args: [config.vbrParameter, quality.toString()],
        description: range ? range.description : 'High quality VBR',
        estimatedBitrate: bitrate
      };
    } else {
      // Use ABR mode for very low or very high bitrates
      return {
        enabled: true,
        type: 'abr',
        args: [config.abrParameter, '1', '-b:a', bitrate.toString()],
        description: 'Average bitrate mode',
        estimatedBitrate: bitrate
      };
    }
  }

  /**
   * Build constrained VBR arguments (aac_at style)
   * @param {Object} config - VBR configuration
   * @param {number} bitrate - Target bitrate
   * @param {number} channels - Number of channels
   * @returns {Object} VBR configuration
   */
  buildConstrainedVBR(config, bitrate, channels) {
    return {
      enabled: true,
      type: 'cvbr',
      args: [
        config.parameter, config.mode.toString(),
        config.bitrateParameter, bitrate.toString()
      ],
      description: 'Constrained VBR',
      estimatedBitrate: bitrate
    };
  }

  /**
   * Build quality-based VBR arguments (libvorbis style)
   * @param {Object} config - VBR configuration
   * @param {number} bitrate - Target bitrate
   * @param {number} channels - Number of channels
   * @returns {Object} VBR configuration
   */
  buildQualityVBR(config, bitrate, channels) {
    const bitratePerChannel = bitrate / Math.max(channels, 1);
    
    // Find appropriate quality level
    const range = config.ranges.find(r => bitratePerChannel <= r.maxBitrate);
    const quality = range ? range.quality : config.ranges[config.ranges.length - 1].quality;

    return {
      enabled: true,
      type: 'quality',
      args: [config.parameter, quality.toString()],
      description: range ? range.description : 'High quality',
      estimatedBitrate: bitrate
    };
  }

  /**
   * Check if encoder supports VBR
   * @param {string} encoderName - Encoder name
   * @returns {boolean} True if VBR is supported
   */
  supportsVBR(encoderName) {
    return AudioVBRManager.VBR_CONFIGS.hasOwnProperty(encoderName);
  }

  /**
   * Determine if VBR is beneficial for given parameters
   * @param {string} encoderName - Encoder name
   * @param {number} bitrate - Target bitrate
   * @param {number} channels - Number of channels
   * @param {string} contentType - Content type
   * @returns {boolean} True if VBR is recommended
   */
  shouldUseVBR(encoderName, bitrate, channels, contentType = 'mixed') {
    // Check if encoder supports VBR
    if (!this.supportsVBR(encoderName)) {
      return false;
    }

    // Check content type preference
    const contentPref = AudioVBRManager.CONTENT_QUALITY_PREFERENCES[contentType];
    if (contentPref && !contentPref.preferVBR) {
      return false;
    }

    // Check if bitrate is suitable for VBR
    const config = AudioVBRManager.VBR_CONFIGS[encoderName];
    if (config.type === 'hybrid' && config.vbrThreshold) {
      const bitratePerChannel = bitrate / Math.max(channels, 1);
      return bitratePerChannel >= config.vbrThreshold.min && 
             bitratePerChannel <= config.vbrThreshold.max;
    }

    // Generally beneficial for quality-focused encoders
    return true;
  }
}

module.exports = { AudioVBRManager };
