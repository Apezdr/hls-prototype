// services/audioBitrateCalculator.js

/**
 * Smart Audio Bitrate Calculator
 * Implements advanced bitrate calculation logic
 */
class AudioBitrateCalculator {
  /**
   * Codec-specific bitrate configurations
   * Based on advanced bitrate calculation methods
   */
  static CODEC_BITRATE_CONFIGS = {
    aac: {
      stereoBase: 128000,      // 128k for stereo
      channelRate: 128000,     // 128k per channel
      max6Channel: 640000,     // 640k max for 5.1
      maxTotal: 640000
    },
    mp3: {
      stereoBase: 128000,      // 128k for stereo  
      channelRate: 128000,     // 128k per channel
      max2Channel: 256000,     // MP3 limited to stereo
      maxTotal: 256000
    },
    opus: {
      stereoBase: 96000,       // 96k for stereo (more efficient)
      channelRate: 96000,      // 96k per channel
      max8Channel: 512000,     // 512k max for 7.1
      maxTotal: 512000
    },
    vorbis: {
      stereoBase: 128000,      // 128k for stereo
      channelRate: 128000,     // 128k per channel
      max8Channel: 640000,     // Similar to AAC
      maxTotal: 640000
    },
    ac3: {
      stereoBase: 192000,      // 192k for stereo
      channelRate: 136000,     // 136k per channel
      max6Channel: 640000,     // 640k max for 5.1
      maxTotal: 640000
    },
    eac3: {
      stereoBase: 192000,      // 192k for stereo
      channelRate: 136000,     // 136k per channel  
      max6Channel: 640000,     // 640k max for 5.1
      maxTotal: 640000
    },
    dts: {
      stereoBase: 192000,      // 192k for stereo
      channelRate: 136000,     // 136k per channel
      max6Channel: 768000,     // 768k max for 5.1 (higher than AC-3)
      maxTotal: 768000
    },
    flac: {
      // Lossless - bitrate varies with content
      dynamicBitrate: true,
      typical: 1000000         // ~1Mbps typical
    },
    alac: {
      // Lossless - bitrate varies with content
      dynamicBitrate: true,
      typical: 800000          // ~800kbps typical
    }
  };

  /**
   * Content type multipliers for bitrate adjustment
   */
  static CONTENT_TYPE_MULTIPLIERS = {
    music: 1.2,              // Higher quality for music
    speech: 0.8,             // Lower bitrate for speech
    mixed: 1.0,              // Default
    effects: 1.1,            // Slightly higher for sound effects
    broadcast: 0.9           // Lower for broadcast content
  };

  /**
   * Calculate optimal bitrate based on codec, channels, and source
   * @param {string} codec - Target codec
   * @param {number} channels - Number of channels
   * @param {number} sourceBitrate - Source bitrate (optional)
   * @param {boolean} isHighQuality - High quality mode
   * @param {string} contentType - Content type for optimization
   * @returns {number} Optimal bitrate in bps
   */
  calculateOptimalBitrate(codec, channels = 2, sourceBitrate = null, isHighQuality = false, contentType = 'mixed') {
    const config = AudioBitrateCalculator.CODEC_BITRATE_CONFIGS[codec.toLowerCase()];
    
    if (!config) {
      console.warn(`No bitrate config for codec: ${codec}, using AAC defaults`);
      return this.calculateOptimalBitrate('aac', channels, sourceBitrate, isHighQuality, contentType);
    }

    // Handle lossless codecs
    if (config.dynamicBitrate) {
      return this.calculateLosslessBitrate(codec, channels, sourceBitrate);
    }

    // Calculate base bitrate
    let bitrate = this.calculateBaseBitrate(config, channels);

    // Apply high quality multiplier
    if (isHighQuality) {
      bitrate = Math.floor(bitrate * 1.25);
    }

    // Apply content type optimization
    const contentMultiplier = AudioBitrateCalculator.CONTENT_TYPE_MULTIPLIERS[contentType] || 1.0;
    bitrate = Math.floor(bitrate * contentMultiplier);

    // Constrain to source bitrate if available (don't exceed unnecessarily)
    if (sourceBitrate && sourceBitrate > 0) {
      bitrate = this.constrainToSource(bitrate, sourceBitrate, isHighQuality);
    }

    // Apply codec-specific limits
    bitrate = Math.min(bitrate, config.maxTotal);

    return bitrate;
  }

  /**
   * Calculate base bitrate using advanced logic
   * @param {Object} config - Codec configuration
   * @param {number} channels - Number of channels
   * @returns {number} Base bitrate
   */
  calculateBaseBitrate(config, channels) {
    if (channels <= 2) {
      return config.stereoBase;
    }

    if (channels >= 6) {
      // Use max 6-channel rate if available, otherwise calculate
      return config.max6Channel || (config.channelRate * 6);
    }

    // Calculate for 3-5 channels
    return Math.min(
      config.channelRate * channels,
      config.maxTotal
    );
  }

  /**
   * Calculate bitrate for lossless codecs
   * @param {string} codec - Lossless codec
   * @param {number} channels - Number of channels
   * @param {number} sourceBitrate - Source bitrate
   * @returns {number} Estimated bitrate
   */
  calculateLosslessBitrate(codec, channels, sourceBitrate) {
    const config = AudioBitrateCalculator.CODEC_BITRATE_CONFIGS[codec.toLowerCase()];
    
    if (sourceBitrate && sourceBitrate > 0) {
      // Use source bitrate as reference for lossless
      return sourceBitrate;
    }

    // Use typical bitrate adjusted for channels
    const channelMultiplier = channels / 2; // Stereo baseline
    return Math.floor(config.typical * channelMultiplier);
  }

  /**
   * Constrain bitrate to source quality
   * @param {number} calculatedBitrate - Calculated target bitrate
   * @param {number} sourceBitrate - Source bitrate
   * @param {boolean} isHighQuality - High quality mode
   * @returns {number} Constrained bitrate
   */
  constrainToSource(calculatedBitrate, sourceBitrate, isHighQuality) {
    // Don't go higher than source unless specifically requested
    if (!isHighQuality && calculatedBitrate > sourceBitrate) {
      return sourceBitrate;
    }

    // For very low source bitrates, allow some upscaling
    const minScaleFactor = this.getMinScaleFactor(sourceBitrate);
    const minBitrate = Math.floor(sourceBitrate * minScaleFactor);

    return Math.max(calculatedBitrate, minBitrate);
  }

  /**
   * Get minimum scale factor based on source bitrate
   * @param {number} sourceBitrate - Source bitrate
   * @returns {number} Scale factor
   */
  getMinScaleFactor(sourceBitrate) {
    // Scaling logic for low bitrate streams
    if (sourceBitrate <= 64000) {
      return 2.5;  // 2.5x for very low bitrate
    } else if (sourceBitrate <= 128000) {
      return 2.0;  // 2x for low bitrate
    } else if (sourceBitrate <= 192000) {
      return 1.5;  // 1.5x for medium-low bitrate
    }
    
    return 1.0;  // No scaling for higher bitrates
  }

  /**
   * Get bitrate range for codec and channels
   * @param {string} codec - Codec name
   * @param {number} channels - Number of channels
   * @returns {Object} Min and max bitrate range
   */
  getBitrateRange(codec, channels = 2) {
    const config = AudioBitrateCalculator.CODEC_BITRATE_CONFIGS[codec.toLowerCase()];
    
    if (!config) {
      return { min: 64000, max: 320000 }; // Sensible defaults
    }

    if (config.dynamicBitrate) {
      return { 
        min: Math.floor(config.typical * 0.5), 
        max: Math.floor(config.typical * 2.0) 
      };
    }

    const maxBitrate = this.calculateBaseBitrate(config, channels);
    const minBitrate = Math.floor(maxBitrate * 0.25); // 25% of max as minimum

    return { min: minBitrate, max: maxBitrate };
  }

  /**
   * Get recommended VBR quality level
   * @param {string} codec - Codec name
   * @param {number} targetBitrate - Target bitrate
   * @param {number} channels - Number of channels
   * @returns {number|null} VBR quality level or null if not applicable
   */
  getVBRQualityLevel(codec, targetBitrate, channels = 2) {
    const bitratePerChannel = targetBitrate / Math.max(channels, 1);
    
    // Return quality levels based on codec
    switch (codec.toLowerCase()) {
      case 'libfdk_aac':
        if (bitratePerChannel < 32000) return 1;
        if (bitratePerChannel < 48000) return 2;
        if (bitratePerChannel < 64000) return 3;
        if (bitratePerChannel < 96000) return 4;
        return 5;
        
      case 'libmp3lame':
        if (bitratePerChannel < 64000) return 6;
        if (bitratePerChannel < 88000) return 4;
        if (bitratePerChannel < 112000) return 2;
        return 0;
        
      case 'libvorbis':
        if (bitratePerChannel < 40000) return 0;
        if (bitratePerChannel < 56000) return 2;
        if (bitratePerChannel < 80000) return 4;
        if (bitratePerChannel < 112000) return 6;
        return 8;
        
      default:
        return null;
    }
  }

  /**
   * Check if bitrate should use ABR mode instead of VBR
   * @param {string} codec - Codec name
   * @param {number} bitrate - Target bitrate
   * @returns {boolean} True if ABR should be used
   */
  shouldUseABR(codec, bitrate) {
    // MP3 uses ABR for very low and very high bitrates
    if (codec.toLowerCase() === 'libmp3lame') {
      return bitrate <= 48000 || bitrate >= 122500;
    }
    
    return false;
  }

  /**
   * Get codec efficiency factor for comparison
   * @param {string} codec - Codec name
   * @returns {number} Efficiency factor (higher = more efficient)
   */
  getCodecEfficiency(codec) {
    const efficiencyMap = {
      'opus': 1.3,       // Most efficient
      'aac': 1.1,        // Good efficiency
      'vorbis': 1.0,     // Baseline
      'mp3': 0.8,        // Less efficient
      'ac3': 0.7,        // Legacy, less efficient
      'eac3': 0.75,      // Slightly better than AC3
      'dts': 0.6         // Least efficient for file size
    };
    
    return efficiencyMap[codec.toLowerCase()] || 1.0;
  }

  /**
   * Adjust bitrate based on sample rate
   * @param {number} bitrate - Base bitrate
   * @param {number} sampleRate - Sample rate in Hz
   * @returns {number} Adjusted bitrate
   */
  adjustForSampleRate(bitrate, sampleRate) {
    // Higher sample rates may benefit from slightly higher bitrates
    if (sampleRate >= 96000) {
      return Math.floor(bitrate * 1.1);
    } else if (sampleRate >= 48000) {
      return bitrate; // Standard
    } else if (sampleRate >= 44100) {
      return bitrate; // CD quality
    } else {
      // Lower sample rates can use lower bitrates
      return Math.floor(bitrate * 0.9);
    }
  }
}

module.exports = { AudioBitrateCalculator };
