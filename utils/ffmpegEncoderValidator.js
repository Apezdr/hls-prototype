// utils/ffmpegEncoderValidator.js
const { spawn } = require('child_process');
const { FFMPEG_PATH } = require('../config/config');

/**
 * FFmpeg Encoder Validator
 * Tests which audio and video encoders are actually available in the current FFmpeg installation
 */
class FFmpegEncoderValidator {
  constructor() {
    this.availableEncoders = null;
    this.lastValidated = null;
    this.cacheExpiry = 30000; // 30 seconds cache
  }

  /**
   * Get list of all available encoders from FFmpeg
   * @returns {Promise<Object>} Available encoders categorized by type
   */
  async getAvailableEncoders() {
    // Return cached result if recent
    if (this.availableEncoders && this.lastValidated && 
        (Date.now() - this.lastValidated) < this.cacheExpiry) {
      return this.availableEncoders;
    }

    return new Promise((resolve, reject) => {
      const process = spawn(FFMPEG_PATH, ['-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`FFmpeg encoder query failed: ${stderr}`));
          return;
        }

        try {
          const encoders = this.parseEncoderList(stdout);
          this.availableEncoders = encoders;
          this.lastValidated = Date.now();
          resolve(encoders);
        } catch (err) {
          reject(new Error(`Failed to parse encoder list: ${err.message}`));
        }
      });

      process.on('error', (err) => {
        reject(new Error(`FFmpeg process error: ${err.message}`));
      });
    });
  }

  /**
   * Parse FFmpeg encoder list output
   * @param {string} output - Raw FFmpeg -encoders output
   * @returns {Object} Parsed encoder categories
   */
  parseEncoderList(output) {
    const lines = output.split('\n');
    const encoders = {
      audio: new Set(),
      video: new Set(),
      subtitle: new Set()
    };

    let inEncoderSection = false;

    for (const line of lines) {
      // Skip until we reach the encoder section
      if (line.includes('Encoders:')) {
        inEncoderSection = true;
        continue;
      }

      if (!inEncoderSection) continue;

      // Skip header lines and empty lines
      if (line.startsWith(' ------') || line.trim() === '' || 
          line.includes('V..... = Video') || line.includes('A..... = Audio') || 
          line.includes('S..... = Subtitle')) {
        continue;
      }

      // Parse encoder line format: " A..... aac                  AAC (Advanced Audio Coding)"
      const match = line.match(/^\s+([VAS])([A-Z\.]{5})\s+(\S+)\s+(.*)$/);
      if (match) {
        const [, type, flags, name, description] = match;
        
        switch (type) {
          case 'V':
            encoders.video.add(name);
            break;
          case 'A':
            encoders.audio.add(name);
            break;
          case 'S':
            encoders.subtitle.add(name);
            break;
        }
      }
    }

    return {
      audio: Array.from(encoders.audio).sort(),
      video: Array.from(encoders.video).sort(),
      subtitle: Array.from(encoders.subtitle).sort()
    };
  }

  /**
   * Check if a specific audio encoder is available
   * @param {string} encoderName - Name of the encoder to check
   * @returns {Promise<boolean>} True if encoder is available
   */
  async isAudioEncoderAvailable(encoderName) {
    try {
      const encoders = await this.getAvailableEncoders();
      return encoders.audio.includes(encoderName);
    } catch (err) {
      console.warn(`Error checking encoder availability: ${err.message}`);
      return false;
    }
  }

  /**
   * Check if a specific video encoder is available
   * @param {string} encoderName - Name of the encoder to check
   * @returns {Promise<boolean>} True if encoder is available
   */
  async isVideoEncoderAvailable(encoderName) {
    try {
      const encoders = await this.getAvailableEncoders();
      return encoders.video.includes(encoderName);
    } catch (err) {
      console.warn(`Error checking encoder availability: ${err.message}`);
      return false;
    }
  }

  /**
   * Find the best available audio encoder from a list of preferences
   * @param {Array<string>} preferredEncoders - List of encoder names in order of preference
   * @returns {Promise<string|null>} Best available encoder or null
   */
  async findBestAvailableAudioEncoder(preferredEncoders) {
    try {
      console.log(`Finding best audio encoder from preferences: ${preferredEncoders.join(', ')}`);
      
      // Special handling for ac3 and eac3 - direct test instead of relying on encoder list
      for (const encoder of preferredEncoders) {
        if (encoder === 'ac3' || encoder === 'eac3') {
          console.log(`Performing direct test for ${encoder} encoder`);
          const available = await this.testEncoder(encoder);
          if (available) {
            console.log(`Direct test confirmed ${encoder} is available`);
            return encoder;
          } else {
            console.log(`Direct test showed ${encoder} is NOT available`);
          }
        }
      }
      
      // Get fresh encoder list
      const encoders = await this.getAvailableEncoders();
      console.log(`Available audio encoders: ${encoders.audio.join(', ')}`);
      
      // Try finding any of the preferred encoders
      for (const encoder of preferredEncoders) {
        if (encoders.audio.includes(encoder)) {
          console.log(`Found available encoder from list: ${encoder}`);
          return encoder;
        }
      }
      
      console.log(`No preferred encoder found among available encoders`);
      return null;
    } catch (err) {
      console.warn(`Error finding best encoder: ${err.message}`);
      return null;
    }
  }

  /**
   * Get all available encoders for a specific codec type
   * @param {string} codecType - 'aac', 'mp3', 'opus', etc.
   * @returns {Promise<Array<string>>} Available encoders for the codec
   */
  async getAvailableCodecEncoders(codecType) {
    try {
      const encoders = await this.getAvailableEncoders();
      const codecEncoders = [];

      // Define codec-to-encoder mappings
      const codecMappings = {
        'aac': ['libfdk_aac', 'aac', 'aac_at'],
        'mp3': ['libmp3lame', 'mp3'],
        'opus': ['libopus'],
        'vorbis': ['libvorbis'],
        'flac': ['flac'],
        'ac3': ['ac3'],
        'eac3': ['eac3']
      };

      const possibleEncoders = codecMappings[codecType] || [codecType];
      
      for (const encoder of possibleEncoders) {
        if (encoders.audio.includes(encoder)) {
          codecEncoders.push(encoder);
        }
      }

      return codecEncoders;
    } catch (err) {
      console.warn(`Error getting codec encoders: ${err.message}`);
      return [];
    }
  }

  /**
   * Test a specific encoder with actual encoding (more thorough than just listing)
   * @param {string} encoderName - Name of encoder to test
   * @returns {Promise<boolean>} True if encoder works
   */
  async testEncoder(encoderName) {
    return new Promise((resolve) => {
      console.log(`Directly testing encoder: ${encoderName}`);
      
      // Different testing approach for Dolby encoders
      let args;
      if (encoderName === 'eac3' || encoderName === 'ac3') {
        // For Dolby encoders, create a simple output with specific parameters
        args = [
          '-f', 'lavfi',
          '-i', 'sine=frequency=1000:duration=0.1:sample_rate=48000',
          '-c:a', encoderName,
          '-b:a', '384k',      // Required bitrate
          '-ac', '6',          // 5.1 channels
          '-ar', '48000',      // Sample rate
          '-f', 'null',
          '-'
        ];
      } else {
        // Standard test for other encoders
        args = [
          '-f', 'lavfi',
          '-i', 'sine=frequency=1000:duration=0.1',
          '-c:a', encoderName,
          '-f', 'null',
          '-'
        ];
      }

      const process = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        const success = code === 0 && !stderr.toLowerCase().includes('unknown encoder');
        console.log(`Encoder ${encoderName} test result: ${success ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
        if (!success) {
          console.log(`Test failure reason: ${stderr}`);
        }
        resolve(success);
      });

      process.on('error', (err) => {
        console.log(`Encoder test error: ${err.message}`);
        resolve(false);
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        process.kill();
        console.log(`Encoder test timed out after 5 seconds`);
        resolve(false);
      }, 5000);
    });
  }

  /**
   * Get system codec preferences based on platform and available encoders
   * @returns {Promise<Object>} Recommended encoder preferences
   */
  async getSystemPreferences() {
    try {
      const encoders = await this.getAvailableEncoders();
      const preferences = {
        aac: [],
        mp3: [],
        opus: [],
        fallback: 'aac' // Always available fallback
      };

      // AAC encoder preferences (in order)
      if (encoders.audio.includes('libfdk_aac')) {
        preferences.aac.push('libfdk_aac');
      }
      if (encoders.audio.includes('aac_at') && process.platform === 'darwin') {
        preferences.aac.push('aac_at');
      }
      if (encoders.audio.includes('aac')) {
        preferences.aac.push('aac');
      }

      // MP3 encoder preferences
      if (encoders.audio.includes('libmp3lame')) {
        preferences.mp3.push('libmp3lame');
      }
      if (encoders.audio.includes('mp3')) {
        preferences.mp3.push('mp3');
      }

      // Opus encoder preferences
      if (encoders.audio.includes('libopus')) {
        preferences.opus.push('libopus');
      }

      return preferences;
    } catch (err) {
      console.warn(`Error getting system preferences: ${err.message}`);
      // Return safe defaults
      return {
        aac: ['aac'],
        mp3: ['libmp3lame'],
        opus: ['libopus'],
        fallback: 'aac'
      };
    }
  }

  /**
   * Clear the encoder cache (useful for testing or after FFmpeg updates)
   */
  clearCache() {
    this.availableEncoders = null;
    this.lastValidated = null;
  }
}

// Export singleton instance
module.exports = new FFmpegEncoderValidator();
