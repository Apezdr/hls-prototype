// services/audio/audioEncoderRegistry.js

/**
 * Audio Encoder Registry
 * Manages available audio encoders and their capabilities
 */
class AudioEncoderRegistry {
  constructor() {
    this.encoders = this.initializeEncoders();
    this.codecAliases = this.initializeCodecAliases();
  }

  /**
   * Initialize the registry of available audio encoders
   * @returns {Object} Encoder registry
   */
  initializeEncoders() {
    return {
      // AAC Encoders
      'libfdk_aac': {
        name: 'libfdk_aac',
        codec: 'aac',
        quality: 'high',
        maxChannels: 8,
        supportedSampleRates: [8000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000],
        supportedBitrates: { min: 8000, max: 512000 },
        vbrSupport: true,
        hardwareAccelerated: false,
        containerSupport: ['mp4', 'ts', 'm4a', 'mov'],
        extraArgs: ['-profile:a', 'aac_low'],
        priority: 10 // Highest priority for AAC
      },
      'aac': {
        name: 'aac',
        codec: 'aac',
        quality: 'medium',
        maxChannels: 8,
        supportedSampleRates: [8000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000],
        supportedBitrates: { min: 8000, max: 512000 },
        vbrSupport: false,
        hardwareAccelerated: false,
        containerSupport: ['mp4', 'ts', 'm4a', 'mov'],
        extraArgs: ['-profile:a', 'aac_low'],
        priority: 8
      },
      'aac_at': {
        name: 'aac_at',
        codec: 'aac',
        quality: 'high',
        maxChannels: 8,
        supportedSampleRates: [8000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000],
        supportedBitrates: { min: 8000, max: 512000 },
        vbrSupport: true,
        hardwareAccelerated: true,
        containerSupport: ['mp4', 'ts', 'm4a', 'mov'],
        extraArgs: ['-profile:a', 'aac_low'],
        priority: 9, // High priority but slightly lower than libfdk_aac
        platform: 'darwin' // macOS only
      },

      // MP3 Encoders
      'libmp3lame': {
        name: 'libmp3lame',
        codec: 'mp3',
        quality: 'high',
        maxChannels: 2,
        supportedSampleRates: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
        supportedBitrates: { min: 32000, max: 320000 },
        vbrSupport: true,
        hardwareAccelerated: false,
        containerSupport: ['mp3', 'ts'],
        extraArgs: [],
        priority: 10
      },
      'mp3': {
        name: 'mp3',
        codec: 'mp3',
        quality: 'medium',
        maxChannels: 2,
        supportedSampleRates: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
        supportedBitrates: { min: 32000, max: 320000 },
        vbrSupport: false,
        hardwareAccelerated: false,
        containerSupport: ['mp3', 'ts'],
        extraArgs: [],
        priority: 7
      },

      // Opus Encoder
      'libopus': {
        name: 'libopus',
        codec: 'opus',
        quality: 'high',
        maxChannels: 8,
        supportedSampleRates: [8000, 12000, 16000, 24000, 48000],
        supportedBitrates: { min: 6000, max: 512000 },
        vbrSupport: true,
        hardwareAccelerated: false,
        containerSupport: ['webm', 'ogg', 'ts'],
        extraArgs: ['-application', 'audio'],
        priority: 9
      },

      // Vorbis Encoder
      'libvorbis': {
        name: 'libvorbis',
        codec: 'vorbis',
        quality: 'medium',
        maxChannels: 8,
        supportedSampleRates: [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000, 192000],
        supportedBitrates: { min: 45000, max: 500000 },
        vbrSupport: true,
        hardwareAccelerated: false,
        containerSupport: ['ogg', 'webm'],
        extraArgs: [],
        priority: 6
      },

      // FLAC Encoder
      'flac': {
        name: 'flac',
        codec: 'flac',
        quality: 'lossless',
        maxChannels: 8,
        supportedSampleRates: [8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000],
        supportedBitrates: { min: 'variable', max: 'variable' },
        vbrSupport: true,
        hardwareAccelerated: false,
        containerSupport: ['flac', 'ogg', 'mkv'],
        extraArgs: ['-compression_level', '5'],
        priority: 8
      },

      // AC-3 Encoder
      'ac3': {
        name: 'ac3',
        codec: 'ac3',
        quality: 'medium',
        maxChannels: 6,
        supportedSampleRates: [32000, 44100, 48000],
        supportedBitrates: { min: 32000, max: 640000 },
        vbrSupport: false,
        hardwareAccelerated: false,
        containerSupport: ['ts', 'mkv', 'mp4'],
        extraArgs: [],
        priority: 5
      },

      // EAC-3 Encoder
      'eac3': {
        name: 'eac3',
        codec: 'eac3',
        quality: 'high',
        maxChannels: 16,
        supportedSampleRates: [32000, 44100, 48000],
        supportedBitrates: { min: 32000, max: 1024000 },
        vbrSupport: false,
        hardwareAccelerated: false,
        containerSupport: ['ts', 'mkv', 'mp4'],
        extraArgs: [],
        priority: 6
      },

      // Copy encoder (no transcoding)
      'copy': {
        name: 'copy',
        codec: 'copy',
        quality: 'source',
        maxChannels: 16,
        supportedSampleRates: 'any',
        supportedBitrates: 'any',
        vbrSupport: true,
        hardwareAccelerated: true,
        containerSupport: 'any',
        extraArgs: [],
        priority: 15 // Highest priority when compatible
      }
    };
  }

  /**
   * Initialize codec aliases for flexibility
   * @returns {Object} Codec aliases
   */
  initializeCodecAliases() {
    return {
      'aac-lc': 'aac',
      'aac_lc': 'aac',
      'he-aac': 'aac',
      'he_aac': 'aac',
      'mpeg4aac': 'aac',
      'mpeg-4 aac': 'aac',
      'mp3lame': 'libmp3lame',
      'lame': 'libmp3lame',
      'vorbis': 'libvorbis',
      'ogg': 'libvorbis',
      'opus': 'libopus'
    };
  }

  /**
   * Select the optimal encoder for the given requirements
   * @param {string} targetCodec - Target codec
   * @param {number} channels - Number of channels
   * @param {number} bitDepth - Bit depth
   * @param {string} container - Target container format
   * @returns {Object|null} Best encoder or null if none found
   */
  selectOptimalEncoder(targetCodec, channels = 2, bitDepth = 16, container = 'ts') {
    // Normalize codec name
    const normalizedCodec = this.codecAliases[targetCodec] || targetCodec;
    
    // Find encoders that support this codec
    const candidateEncoders = Object.values(this.encoders).filter(encoder => {
      return encoder.codec === normalizedCodec || encoder.name === normalizedCodec;
    });

    if (candidateEncoders.length === 0) {
      console.warn(`No encoders found for codec: ${targetCodec}`);
      return null;
    }

    // Filter by channel support
    const channelCompatibleEncoders = candidateEncoders.filter(encoder => {
      return channels <= encoder.maxChannels;
    });

    if (channelCompatibleEncoders.length === 0) {
      console.warn(`No encoders support ${channels} channels for codec: ${targetCodec}`);
      return candidateEncoders[0]; // Return best available, even if channel count is reduced
    }

    // Filter by container support
    const containerCompatibleEncoders = channelCompatibleEncoders.filter(encoder => {
      return encoder.containerSupport === 'any' || 
             encoder.containerSupport.includes(container);
    });

    const finalCandidates = containerCompatibleEncoders.length > 0 ? 
                           containerCompatibleEncoders : 
                           channelCompatibleEncoders;

    // Filter by platform if applicable
    const platformCompatibleEncoders = finalCandidates.filter(encoder => {
      if (!encoder.platform) return true;
      return encoder.platform === process.platform;
    });

    const bestCandidates = platformCompatibleEncoders.length > 0 ? 
                          platformCompatibleEncoders : 
                          finalCandidates;

    // Sort by priority (higher is better) and return the best
    bestCandidates.sort((a, b) => b.priority - a.priority);
    
    return bestCandidates[0];
  }

  /**
   * Validate which encoders are actually available in the current FFmpeg installation
   * @returns {Promise<Object>} Available encoders
   */
  async validateAvailableEncoders() {
    // This would normally test FFmpeg for available encoders
    // For now, return all encoders as potentially available
    const available = {};
    const unavailable = {};

    for (const [name, encoder] of Object.entries(this.encoders)) {
      // Simple platform check
      if (encoder.platform && encoder.platform !== process.platform) {
        unavailable[name] = { ...encoder, reason: 'Platform incompatible' };
        continue;
      }

      // Assume all others are available for now
      // In a real implementation, you'd test with FFmpeg
      available[name] = encoder;
    }

    return {
      available,
      unavailable,
      total: Object.keys(this.encoders).length,
      availableCount: Object.keys(available).length
    };
  }

  /**
   * Get list of supported codec names
   * @returns {Array<string>} Supported codec names
   */
  getSupportedCodecs() {
    const codecs = new Set();
    
    Object.values(this.encoders).forEach(encoder => {
      codecs.add(encoder.codec);
    });

    return Array.from(codecs).sort();
  }

  /**
   * Get detailed information about an encoder
   * @param {string} codecOrEncoder - Codec name or encoder name
   * @returns {Object|null} Encoder information
   */
  getEncoderInfo(codecOrEncoder) {
    // First try as encoder name
    if (this.encoders[codecOrEncoder]) {
      return this.encoders[codecOrEncoder];
    }

    // Then try as codec name
    const encoder = this.selectOptimalEncoder(codecOrEncoder);
    return encoder;
  }

  /**
   * Get all encoders for a specific codec
   * @param {string} codec - Codec name
   * @returns {Array} All encoders supporting the codec
   */
  getEncodersForCodec(codec) {
    const normalizedCodec = this.codecAliases[codec] || codec;
    
    return Object.values(this.encoders).filter(encoder => {
      return encoder.codec === normalizedCodec;
    }).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Check if a specific encoder is available
   * @param {string} encoderName - Encoder name
   * @returns {boolean} Whether encoder is available
   */
  isEncoderAvailable(encoderName) {
    const encoder = this.encoders[encoderName];
    if (!encoder) return false;
    
    // Platform check
    if (encoder.platform && encoder.platform !== process.platform) {
      return false;
    }

    return true;
  }

  /**
   * Get recommended encoder for streaming
   * @param {string} codec - Target codec
   * @param {number} channels - Channel count
   * @param {boolean} lowLatency - Whether low latency is required
   * @returns {Object|null} Recommended encoder
   */
  getStreamingEncoder(codec, channels = 2, lowLatency = false) {
    const encoders = this.getEncodersForCodec(codec);
    
    if (lowLatency) {
      // Prefer hardware encoders for low latency
      const hardwareEncoders = encoders.filter(e => e.hardwareAccelerated);
      if (hardwareEncoders.length > 0) {
        return hardwareEncoders[0];
      }
    }

    // Default to best quality encoder
    return this.selectOptimalEncoder(codec, channels);
  }

  /**
   * Get quality assessment for an encoder
   * @param {string} encoderName - Encoder name
   * @returns {Object} Quality assessment
   */
  getQualityAssessment(encoderName) {
    const encoder = this.encoders[encoderName];
    if (!encoder) {
      return { quality: 'unknown', score: 0 };
    }

    const qualityScores = {
      'lossless': 10,
      'high': 8,
      'medium': 6,
      'low': 4,
      'source': 10
    };

    return {
      quality: encoder.quality,
      score: qualityScores[encoder.quality] || 5,
      vbrSupport: encoder.vbrSupport,
      hardwareAccelerated: encoder.hardwareAccelerated,
      maxChannels: encoder.maxChannels
    };
  }
}

module.exports = { AudioEncoderRegistry };
