// services/audioQualityOptimizer.js

/**
 * Audio Quality Optimizer
 * Provides content-aware audio processing optimizations
 */
class AudioQualityOptimizer {
  /**
   * Content-specific optimization profiles
   */
  static CONTENT_PROFILES = {
    music: {
      description: 'Optimized for music content',
      qualityBoost: 1.2,
      preserveDynamics: true,
      enhanceStereoField: true,
      filters: []
    },
    speech: {
      description: 'Optimized for speech/dialogue',
      qualityBoost: 0.8,
      compressDynamics: true,
      enhanceVocals: true,
      filters: [
        'highpass=f=80', // Remove low rumble
        'lowpass=f=8000' // Remove high frequency noise
      ]
    },
    mixed: {
      description: 'Balanced optimization for mixed content',
      qualityBoost: 1.0,
      preserveDynamics: false,
      enhanceStereoField: false,
      filters: []
    },
    effects: {
      description: 'Optimized for sound effects',
      qualityBoost: 1.1,
      preserveDynamics: true,
      enhanceTransients: true,
      filters: []
    },
    broadcast: {
      description: 'Broadcast/TV content optimization',
      qualityBoost: 0.9,
      compressDynamics: true,
      normalizeLoudness: true,
      filters: [
        'dynaudnorm=f=500:g=31:p=0.95:m=10.0:r=0.0:n=1'
      ]
    }
  };

  /**
   * Streaming-specific optimizations
   */
  static STREAMING_OPTIMIZATIONS = {
    mobile: {
      description: 'Mobile device optimization',
      compressDynamics: true,
      reduceBass: true,
      filters: [
        'equalizer=f=100:t=h:w=200:g=-3', // Reduce bass
        'compand=0.3|0.3:1|1:-90/-90|-60/-40|-40/-30|-20/-20:6:0:-90:0.2' // Gentle compression
      ]
    },
    desktop: {
      description: 'Desktop/headphone optimization',
      enhanceStereoField: true,
      preserveDynamics: true,
      filters: []
    },
    tv: {
      description: 'TV/living room optimization',
      compressDynamics: true,
      enhanceDialogue: true,
      filters: [
        'dynaudnorm=f=500:g=31:p=0.95:m=10.0:r=0.0:n=1', // Dynamic normalization
        'equalizer=f=1000:t=h:w=1000:g=2' // Enhance vocal range
      ]
    }
  };

  /**
   * Optimize audio processing for specific content type
   * @param {Object} sourceStream - Source audio stream information
   * @param {Object} targetVariant - Target audio variant
   * @param {string} contentType - Type of content ('music', 'speech', etc.)
   * @param {Object} options - Additional optimization options
   * @returns {Object} Optimization configuration
   */
  optimizeForContent(sourceStream, targetVariant, contentType = 'mixed', options = {}) {
    const profile = AudioQualityOptimizer.CONTENT_PROFILES[contentType] || 
                   AudioQualityOptimizer.CONTENT_PROFILES.mixed;

    const streamingProfile = this.getStreamingProfile(options.deviceType || 'desktop');

    // Merge profiles
    const optimization = {
      contentType: contentType,
      description: profile.description,
      qualityBoost: profile.qualityBoost,
      channels: this.optimizeChannels(sourceStream, targetVariant, profile),
      sampleRate: this.optimizeSampleRate(sourceStream, targetVariant, profile),
      filters: this.buildAudioFilters(sourceStream, targetVariant, profile, streamingProfile, options),
      postProcessing: this.getPostProcessingOptions(profile, streamingProfile)
    };

    return optimization;
  }

  /**
   * Get streaming profile for device type
   * @param {string} deviceType - Device type ('mobile', 'desktop', 'tv')
   * @returns {Object} Streaming profile
   */
  getStreamingProfile(deviceType) {
    return AudioQualityOptimizer.STREAMING_OPTIMIZATIONS[deviceType] || 
           AudioQualityOptimizer.STREAMING_OPTIMIZATIONS.desktop;
  }

  /**
   * Optimize channel configuration
   * @param {Object} sourceStream - Source stream info
   * @param {Object} targetVariant - Target variant
   * @param {Object} profile - Content profile
   * @returns {number} Optimized channel count
   */
  optimizeChannels(sourceStream, targetVariant, profile) {
    const sourceChannels = sourceStream.channels || 2;
    const targetChannels = targetVariant.channels || sourceChannels;

    // Speech content works well in stereo
    if (profile.description.includes('speech') && targetChannels > 2) {
      return 2;
    }

    // Music content benefits from multichannel if available
    if (profile.description.includes('music') && sourceChannels > 2) {
      return Math.min(sourceChannels, 6); // Cap at 5.1
    }

    return targetChannels;
  }

  /**
   * Optimize sample rate
   * @param {Object} sourceStream - Source stream info
   * @param {Object} targetVariant - Target variant
   * @param {Object} profile - Content profile
   * @returns {number} Optimized sample rate
   */
  optimizeSampleRate(sourceStream, targetVariant, profile) {
    const sourceSampleRate = sourceStream.sampleRate || 48000;
    const targetSampleRate = targetVariant.sampleRate || sourceSampleRate;

    // For speech, 44.1kHz or 48kHz is sufficient
    if (profile.description.includes('speech') && targetSampleRate > 48000) {
      return 48000;
    }

    // For music, prefer to maintain high sample rates
    if (profile.description.includes('music') && sourceSampleRate > targetSampleRate) {
      return sourceSampleRate;
    }

    return targetSampleRate;
  }

  /**
   * Build audio filter chain
   * @param {Object} sourceStream - Source stream info
   * @param {Object} targetVariant - Target variant
   * @param {Object} contentProfile - Content-specific profile
   * @param {Object} streamingProfile - Streaming-specific profile
   * @param {Object} options - Additional options
   * @returns {Array} Audio filters
   */
  buildAudioFilters(sourceStream, targetVariant, contentProfile, streamingProfile, options) {
    const filters = [];

    // Add content-specific filters
    if (contentProfile.filters && contentProfile.filters.length > 0) {
      filters.push(...contentProfile.filters);
    }

    // Add streaming-specific filters
    if (streamingProfile.filters && streamingProfile.filters.length > 0) {
      filters.push(...streamingProfile.filters);
    }

    // Add channel mixing filters if needed
    const channelFilter = this.getChannelMixingFilter(sourceStream, targetVariant, contentProfile);
    if (channelFilter) {
      filters.push(channelFilter);
    }

    // Add loudness normalization for streaming
    if (options.normalizeLoudness !== false) {
      const loudnessFilter = this.getLoudnessNormalizationFilter(contentProfile, options);
      if (loudnessFilter) {
        filters.push(loudnessFilter);
      }
    }

    // Add dynamic range processing
    const dynamicsFilter = this.getDynamicsFilter(contentProfile, streamingProfile);
    if (dynamicsFilter) {
      filters.push(dynamicsFilter);
    }

    return filters;
  }

  /**
   * Get channel mixing filter for downmixing
   * @param {Object} sourceStream - Source stream info
   * @param {Object} targetVariant - Target variant
   * @param {Object} profile - Content profile
   * @returns {string|null} Channel mixing filter or null
   */
  getChannelMixingFilter(sourceStream, targetVariant, profile) {
    const sourceChannels = sourceStream.channels || 2;
    const targetChannels = targetVariant.channels || sourceChannels;

    if (sourceChannels <= targetChannels) {
      return null; // No downmixing needed
    }

    // Smart downmixing based on content type
    if (sourceChannels === 6 && targetChannels === 2) {
      // 5.1 to stereo downmix
      if (profile.description.includes('music')) {
        // Preserve stereo field for music
        return 'pan=stereo|FL=0.5*FL+0.707*FC+0.707*BL|FR=0.5*FR+0.707*FC+0.707*BR';
      } else {
        // Standard downmix for other content
        return 'pan=stereo|FL=FL+0.707*FC+0.707*BL|FR=FR+0.707*FC+0.707*BR';
      }
    }

    if (sourceChannels > 2 && targetChannels === 2) {
      // General multichannel to stereo
      return `pan=stereo|FL<FL+0.707*FC|FR<FR+0.707*FC`;
    }

    return null;
  }

  /**
   * Get loudness normalization filter
   * @param {Object} profile - Content profile
   * @param {Object} options - Options
   * @returns {string|null} Loudness filter or null
   */
  getLoudnessNormalizationFilter(profile, options) {
    if (!profile.normalizeLoudness && !options.normalizeLoudness) {
      return null;
    }

    // Use EBU R128 loudness normalization for broadcast content
    if (profile.description.includes('broadcast')) {
      return 'loudnorm=I=-23:TP=-2:LRA=7';
    }

    // Use streaming-friendly loudness for other content
    return 'loudnorm=I=-16:TP=-1.5:LRA=11';
  }

  /**
   * Get dynamics processing filter
   * @param {Object} contentProfile - Content profile
   * @param {Object} streamingProfile - Streaming profile
   * @returns {string|null} Dynamics filter or null
   */
  getDynamicsFilter(contentProfile, streamingProfile) {
    // Apply compression if either profile requests it
    if (contentProfile.compressDynamics || streamingProfile.compressDynamics) {
      if (contentProfile.description.includes('music')) {
        // Gentle compression for music
        return 'compand=0.02|0.02:0.05|0.05:-50/-50|-40/-30|-30/-20|-20/-10:5:0';
      } else {
        // Standard compression for speech/mixed content
        return 'compand=0.1|0.1:0.2|0.2:-50/-50|-40/-25|-25/-15|-15/-10:5:0';
      }
    }

    return null;
  }

  /**
   * Get post-processing options
   * @param {Object} contentProfile - Content profile
   * @param {Object} streamingProfile - Streaming profile
   * @returns {Object} Post-processing options
   */
  getPostProcessingOptions(contentProfile, streamingProfile) {
    return {
      preserveDynamics: contentProfile.preserveDynamics || streamingProfile.preserveDynamics,
      enhanceStereoField: contentProfile.enhanceStereoField || streamingProfile.enhanceStereoField,
      enhanceVocals: contentProfile.enhanceVocals || streamingProfile.enhanceDialogue,
      compressDynamics: contentProfile.compressDynamics || streamingProfile.compressDynamics
    };
  }

  /**
   * Get content-aware EQ filter
   * @param {string} contentType - Content type
   * @param {Object} options - EQ options
   * @returns {string|null} EQ filter or null
   */
  getContentEQ(contentType, options = {}) {
    switch (contentType) {
      case 'speech':
        // Enhance speech clarity
        return 'equalizer=f=2500:t=h:w=1500:g=3';
        
      case 'music':
        // Subtle enhancement for music
        return options.enhanceBass ? 
          'equalizer=f=60:t=h:w=50:g=2,equalizer=f=10000:t=h:w=3000:g=1' : null;
          
      case 'broadcast':
        // TV broadcast EQ
        return 'equalizer=f=1000:t=h:w=800:g=2,equalizer=f=4000:t=h:w=2000:g=1';
        
      default:
        return null;
    }
  }

  /**
   * Get stereo field enhancement filter
   * @param {Object} sourceStream - Source stream info
   * @param {Object} options - Enhancement options
   * @returns {string|null} Stereo enhancement filter or null
   */
  getStereoEnhancement(sourceStream, options = {}) {
    // Only apply to stereo content
    if (sourceStream.channels !== 2) {
      return null;
    }

    const intensity = options.intensity || 0.5; // 0.0 to 1.0
    
    if (intensity > 0) {
      // Use extrastereo filter for stereo field enhancement
      return `extrastereo=m=${intensity}:c=0`;
    }

    return null;
  }

  /**
   * Get adaptive filter based on source analysis
   * @param {Object} sourceStream - Source stream info
   * @param {Object} targetVariant - Target variant
   * @param {string} contentType - Content type
   * @returns {Array} Adaptive filters
   */
  getAdaptiveFilters(sourceStream, targetVariant, contentType) {
    const filters = [];
    const sourceBitrate = sourceStream.bitRate || 0;
    const targetBitrate = targetVariant.bitrate || 128000;

    // If we're significantly reducing bitrate, add pre-emphasis
    if (sourceBitrate > 0 && targetBitrate < sourceBitrate * 0.5) {
      // Add subtle high-frequency pre-emphasis to combat codec artifacts
      filters.push('equalizer=f=8000:t=h:w=4000:g=1');
    }

    // If source has very high sample rate, add anti-aliasing filter
    if (sourceStream.sampleRate > 48000 && targetVariant.sampleRate <= 48000) {
      filters.push('lowpass=f=20000');
    }

    return filters;
  }

  /**
   * Validate and sanitize filter chain
   * @param {Array} filters - Filter array
   * @returns {Array} Validated filter array
   */
  validateFilters(filters) {
    return filters
      .filter(filter => typeof filter === 'string' && filter.length > 0)
      .map(filter => filter.trim())
      .filter(filter => !filter.includes(';')); // Security: prevent command injection
  }

  /**
   * Get quality level recommendation
   * @param {Object} sourceStream - Source stream info
   * @param {Object} targetVariant - Target variant
   * @param {string} contentType - Content type
   * @returns {string} Quality recommendation
   */
  getQualityRecommendation(sourceStream, targetVariant, contentType) {
    const profile = AudioQualityOptimizer.CONTENT_PROFILES[contentType];
    const sourceBitrate = sourceStream.bitRate || 0;
    const targetBitrate = targetVariant.bitrate || 128000;

    if (contentType === 'music' && targetBitrate < 192000) {
      return 'Consider higher bitrate for music content';
    }

    if (contentType === 'speech' && targetBitrate > 96000) {
      return 'Lower bitrate sufficient for speech content';
    }

    if (sourceBitrate > 0 && targetBitrate > sourceBitrate * 1.5) {
      return 'Target bitrate higher than source - consider reducing';
    }

    return 'Optimal quality settings';
  }
}

module.exports = { AudioQualityOptimizer };
