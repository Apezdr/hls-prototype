// utils/audio.js
const { spawn } = require('child_process');

/**
 * Uses ffprobe to get the number of channels for a specific audio track.
 * @param {string} videoPath - The full path to the source video file.
 * @param {number|string} audioTrackIndex - The zero-based index of the audio track.
 * @returns {Promise<number>} - Resolves with the channel count.
 */
function getAudioChannelCount(videoPath, audioTrackIndex) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', `a:${audioTrackIndex}`,
      '-show_entries', 'stream=channels',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ]);

    let output = '';
    ffprobe.stdout.on('data', (data) => output += data);
    ffprobe.stderr.on('data', (data) => console.error(`ffprobe stderr: ${data}`));
    ffprobe.on('close', (code) => {
      if (code === 0) {
        const channels = parseInt(output.trim(), 10);
        resolve(channels);
      } else {
        reject(new Error(`ffprobe exited with code ${code}`));
      }
    });
  });
}


/**
 * Uses ffprobe to get the audio codec for a specific audio track.
 * @param {string} videoPath - The full path to the source video file.
 * @param {number|string} audioTrackIndex - The zero-based index of the audio track.
 * @returns {Promise<string>} - Resolves with the audio codec.
 */
function getAudioCodec(videoPath, audioTrackIndex) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', `a:${audioTrackIndex}`,
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ]);

    let output = '';
    ffprobe.stdout.on('data', (data) => output += data);
    ffprobe.stderr.on('data', (data) => console.error(`ffprobe stderr: ${data}`));
    ffprobe.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`ffprobe exited with code ${code}`));
      }
    });
  });
}

/**
 * Maps an audio stream codec to its corresponding codec string; using ffprobe data.
 * Mostly used for HLS playlists.
 *
 * @param {Object} audioStream - The audio stream object.
 * @param {string} audioStream.codec_name - The name of the codec.
 * @param {string} [audioStream.profile] - The profile of the codec (applicable for AAC).
 * @returns {string} The mapped codec string. Returns 'unknown' if the codec is not recognized.
 */
function mapCodec(audioStream) {
  switch (audioStream.codec_name) {
    case 'aac':
      switch (audioStream.profile) { // Check the AAC profile
        case 'LC': 
          return 'mp4a.40.2';
        case 'HE-AAC': 
          return 'mp4a.40.5';
        case 'HE-AACv2': 
          return 'mp4a.40.29';
        case 'Dolby TrueHD + Dolby Atmos': 
          return 'mp4a.40.7';
        default:
          console.warn(`Unknown AAC profile: ${audioStream.profile}`); // Log unknown profiles
          return 'mp4a.40.2'; // Default back to LC for now
      }
    case 'opus':
      return 'opus'; // Correct codec string for Opus
    case 'mp3':
      return 'mp4a.40.34'; // Correct codec string for MP3
    case 'ac3':
      return 'ac-3'; // Correct codec string for AC-3
    case 'eac3':
      return 'ec-3'; // Correct codec string for E-AC-3
    case 'vorbis':
      return 'vorbis'; // Correct codec string for Vorbis
    case 'flac':
      return 'flac'; // Correct codec string for FLAC
    default:
      console.warn(`Unknown codec: ${audioStream.codec_name}`); // Log unknown codecs
      return 'unknown';
  }
}

/**
 * Maps an ffmpeg language code to its corresponding HLS-compatible two-letter language code.
 * This function covers a wide range of ISO 639-2 three-letter codes. If the input language code
 * is already a two-letter code or if no explicit mapping is found, the function falls back to:
 * - Returning the original value if it's a valid two-letter code.
 * - Using the first two characters of the input as a best-effort approximation.
 *
 * @param {string} lang - The language code to be mapped (e.g., 'eng', 'rum', 'fr').
 * @returns {string} The HLS-compatible two-letter language code.
 */
function mapLanguage(lang) {
  if (!lang || typeof lang !== 'string') return lang;
  lang = lang.trim().toLowerCase();

  // Comprehensive mapping for common ISO 639-2 codes to ISO 639-1 codes
  const mappings = {
    'eng': 'en',
    'ron': 'ro',  // also supports 'rum'
    'rum': 'ro',
    'fra': 'fr',  // also supports 'fre'
    'fre': 'fr',
    'deu': 'de',  // also supports 'ger'
    'ger': 'de',
    'spa': 'es',  // also supports 'esp'
    'esp': 'es',
    'ita': 'it',
    'por': 'pt',
    'nld': 'nl',  // also supports 'dut'
    'dut': 'nl',
    'rus': 'ru',
    'jpn': 'ja',
    'zho': 'zh',  // also supports 'chi'
    'chi': 'zh',
    'kor': 'ko',
    'hin': 'hi',
    'ara': 'ar',
    'swe': 'sv',
    'nor': 'no',
    'dan': 'da',
    'fin': 'fi',
    'ell': 'el',  // Greek
    'tur': 'tr',
    'pol': 'pl',
    'hun': 'hu',
    'ces': 'cs',  // also supports 'cze'
    'cze': 'cs',
    'slk': 'sk',
    'cat': 'ca',
    'lav': 'lv',
    'lit': 'lt',
    'est': 'et',
    'bul': 'bg',
    'ukr': 'uk',
    'heb': 'he',
    'mya': 'my',  // Burmese
    'vie': 'vi'
    // Add more mappings as needed for your project requirements
  };

  if (mappings[lang]) return mappings[lang];

  // Fallback: if lang looks like a two-letter code, assume it's already valid.
  if (lang.length === 2) return lang;

  // As a last resort, return the first two characters, which is a best-effort guess.
  return lang.substring(0, 2);
}

module.exports = { getAudioChannelCount, getAudioCodec, mapCodec, mapLanguage };
