// config/config.js
const path = require('path');
const fs = require('fs');
const envFilenames = [
  '.env.local',
  `.env.${process.env.NODE_ENV}.local`,
  `.env.${process.env.NODE_ENV}`,
  '.env'
];

envFilenames.forEach(filename => {
  const envPath = path.join(__dirname, '../', filename);
  if (fs.existsSync(envPath)) {
    require('@dotenvx/dotenvx').config({ path: envPath });
  }
});

module.exports = {
  ENABLE_HLS_CLEANUP: process.env.ENABLE_HLS_CLEANUP || 'false',
  // Folder where temporary HLS segments and playlists will be stored
  HLS_OUTPUT_DIR: process.env.HLS_OUTPUT_DIR ? path.resolve(process.env.HLS_OUTPUT_DIR) : path.join(__dirname, '../tmp/hls'),
  // Video source folder (adjust as needed)
  VIDEO_SOURCE_DIR: path.join(__dirname, '../media'),
  // FFmpeg executable (if not in PATH, provide full path)
  FFMPEG_PATH: process.env.FFMPEG_PATH ?? 'ffmpeg',
  // ffprobe executable
  FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'ffprobe',
  // MediaInfo executable
  MEDIAINFO_PATH: process.env.MEDIAINFO_PATH ?? 'mediainfo',
  // Redis configuration (adjust host/port if needed)
  //REDIS: {
  //  host: '127.0.0.1',
  //  port: 6379
  //},
  // Pre-transcoding settings: first few segments pre-generated for each quality
  //PRETRANSCODE_SEGMENTS: 6,
  SEGMENTS_TO_ANALYZE: (process.env.SEGMENTS_TO_ANALYZE ? parseInt(process.env.SEGMENTS_TO_ANALYZE) : false ) || 12,
  // HLS segment duration in seconds
  HLS_SEGMENT_TIME: 5,
  // Control if the HLS Playlist uses iframe
  // Will Manipulate Master Playlist to include necessary tags
  // However doesn't affect already generated variant playlists;
  // ex. iframes are disabled, but variant playlists are already generated with iframe tags
  HLS_IFRAME_ENABLED: process.env.HLS_IFRAME_ENABLED === "true" ? true : false,
  // List of variant qualities to support
  VARIANTS: [
    { resolution: '-1x1080', bitrate: '8000k', label: '1080p', isSDR: false },
    { resolution: '-1x720', bitrate: '4000k', label: '720p', isSDR: true },
    //{ resolution: '1920x1080', bitrate: '8000k', label: '1080p', isSDR: false },
    //{ resolution: '1280x720', bitrate: '4000k', label: '720p', isSDR: true },
    //{ resolution: '960x540', bitrate: '2000k', label: '540p', isSDR: true },
    //
    // { resolution: '1920x1080', bitrate: '8000k', label: '1080p High' },
    // { resolution: '1920x1080', bitrate: '5000k', label: '1080p Medium' },
    // { resolution: '1280x720', bitrate: '4000k', label: '720p High' },
    // { resolution: '1280x720', bitrate: '2500k', label: '720p Medium' },
    // { resolution: '960x540', bitrate: '2000k', label: '540p High' },
    // { resolution: '960x540', bitrate: '1200k', label: '540p Medium' },
    // { resolution: '640x360', bitrate: '1000k', label: '360p High' },
    // { resolution: '640x360', bitrate: '600k', label: '360p Medium' },
    // { resolution: '480x270', bitrate: '500k', label: '270p High' },
    // { resolution: '480x270', bitrate: '300k', label: '270p Medium' },
    // { resolution: '320x180', bitrate: '250k', label: '180p High' },
    // { resolution: '320x180', bitrate: '150k', label: '180p Medium' }
  ],
  // Scoring configuration for variant selection
  scoringConfig: {
    // Multiply the pixel area (width * height) by this factor to contribute to the score.
    resolutionFactor: parseFloat(process.env.RESOLUTION_FACTOR) || 1e-6,
    // Bitrate can be given a small weight if desired.
    bitrateFactor: parseFloat(process.env.BITRATE_FACTOR) || 1e-8,
    // Weight per audio codec (you can adjust these so that, for example,
    // ac-3 gets a higher score than ec-3 on platforms that only support ac-3).
    codecWeights: process.env.CODEC_WEIGHTS
      ? JSON.parse(process.env.CODEC_WEIGHTS)
      : { "ac-3": 1.0, "mp4a.40.2": 0.9, "ec-3": 0.8 },
    // Weight per language; you might want to favor certain languages.
    languageWeights: process.env.LANGUAGE_WEIGHTS
      ? JSON.parse(process.env.LANGUAGE_WEIGHTS)
      : { "en": 1.0 },
      //: { "en": 1.0, "fr": 0.95, "und": 0.9 },
    // Bonus to add if using the "full" audio group (native advanced codecs)
    fullGroupBonus: parseFloat(process.env.FULL_GROUP_BONUS) || 0.1,
  },
  // Audio settings
  WEB_SUPPORTED_CODECS: process.env.WEB_SUPPORTED_CODECS?.split(',') || ['aac', 'mp3', 'flac'],
  // Hardware acceleration settings
  HARDWARE_ENCODING_ENABLED: process.env.HARDWARE_ENCODING_ENABLED || 'false',
  HWACCEL_DECODING_ENABLED: process.env.HWACCEL_DECODING_ENABLED || 'false',
  HWACCEL_TYPE: process.env.HWACCEL_TYPE || 'cuda', // or 'qsv', 'vaapi', etc.
  MAX_HW_PROCESSES: parseInt(process.env.MAX_HW_PROCESSES) || 2,
};
