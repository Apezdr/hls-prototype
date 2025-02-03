// config/config.js
const path = require('path');

module.exports = {
  // Folder where temporary HLS segments and playlists will be stored
  HLS_OUTPUT_DIR: path.join(__dirname, '../tmp/hls'),
  // Video source folder (adjust as needed)
  VIDEO_SOURCE_DIR: path.join(__dirname, '../media'),
  // FFmpeg executable (if not in PATH, provide full path)
  FFMPEG_PATH: 'ffmpeg',
  // ffprobe executable
  FFPROBE_PATH: 'ffprobe',
  // Redis configuration (adjust host/port if needed)
  //REDIS: {
  //  host: '127.0.0.1',
  //  port: 6379
  //},
  // Pre-transcoding settings: first few segments pre-generated for each quality
  PRETRANSCODE_SEGMENTS: 3,
  // HLS segment duration in seconds
  HLS_SEGMENT_TIME: 4,
  // List of variant qualities to support
  VARIANTS: [
    { resolution: '1920x1080', bitrate: '5000k', label: '1080p' },
    { resolution: '1280x720', bitrate: '3000k', label: '720p' },
    { resolution: '854x480', bitrate: '1500k', label: '480p' }
  ]
};
