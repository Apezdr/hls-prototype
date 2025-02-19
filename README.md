# HLS Prototype Transcoder

This HLS prototype is designed to take a video source file and transcode it into multiple adaptive bitrate (ABR) streams. The transcoder uses FFmpeg and FFprobe to analyze the video file, generate HLS segments, and create playlists for streaming.

The output of this nodejs script has passed Apple's HLS Media Stream Validator (mediastreamvalidator) tool.
[Using Apple's HTTP Live Streaming (HLS) Tools](https://developer.apple.com/documentation/http-live-streaming/using-apple-s-http-live-streaming-hls-tools)

> Disclaimer: This version does not explicitly support HDR (High Dynamic Range) or Dolby Vision content as of 2/3/2025.

## Endpoints Overview

### Video Endpoints
- **Video Playlist Request:**  
    Endpoint: `/api/stream/:id/:variant/playlist.m3u8`  
    Explanation:  
    - The transcoder checks the requested variant (e.g., `1080p`, `720p`, or a custom `"4k"` if the video is 4K or higher).
    - It looks up the video file under the configured `VIDEO_SOURCE_DIR` using the file name (without extension). For example, if the video file is located at `VIDEO_SOURCE_DIR/my-video.mp4`, the request should use `my-video` as the ID.
    - If required, a new transcoding session is created or an active session is updated, and the generated HLS playlist is served once it’s ready.

### Master Playlist Endpoint
- **Master Playlist Request:**  
    Endpoint: `/api/stream/:id/master.m3u8`  
    Explanation:  
    - Aggregates the available ABR variants.
    - Checks the video stream resolution to build an appropriate variant set.
    - Serves a master playlist containing references to the variant playlists.

### Audio Endpoints
- **Audio Playlist Request:**  
    Endpoint: `/api/stream/:id/audio/track_:track/playlist.m3u8`  
    Explanation:  
    - Filters audio streams from the video file.
    - Generates an audio-specific HLS playlist for the indicated audio track.
    - The first track is used as the default if multiple audio streams are present.

### Segment Serving Endpoint
- **Segment Files:**  
    Endpoint: `/api/stream/:id/:variant/:segment.ts`  
    Explanation:  
    - Serves the segmented transport stream (.ts) files after ensuring file stability.
    - Implements retry logic (returns a 202 status when segments are not yet ready).

## Configuration

The main configuration file is located at `config/config.js` where you can define:
- **HLS_OUTPUT_DIR:** Directory for temporary HLS segments and playlists.
- **VIDEO_SOURCE_DIR:** Directory where your source video files reside.  
    *Note:* To access a video, provide its file name (without the extension) in the URL.
- **FFmpeg & FFprobe Paths:** Paths to these executables if not available in your system PATH.
- **HLS Segment Duration:** Defined by the `HLS_SEGMENT_TIME`.
- **Variant Settings:** Default variants for video quality (e.g., `1080p`, `720p`) and any custom variants based on resolution (including a `"4k"` option when applicable).

## Running the Prototype

1. **Install Dependencies:**  
     Ensure all dependencies are installed, including Express, FFmpeg, and required Node modules.
     
2. **Configure Paths and Settings:**  
     Edit `config/config.js` to point to the correct folders and setups (e.g., source video directory, HLS output directory).

3. **Start the Server:**  
     Run your server (typically via `node app.js` or a similar command). The server listens on a given port (default is 3000).

4. **Accessing the Transcoder:**  
     - To request a video variant, use endpoints such as `/api/stream/my-video/1080p/playlist.m3u8`.
     - For the master playlist, request `/api/stream/my-video/master.m3u8`.

There is a built in cleanup function that will periodically clean up the files produced by the transcode, a cron job that runs every 10 minutes to remove HLS folders that haven’t been accessed in the last 55 minutes.

5. **Cleanup Process:**  
     A scheduled job cleans up unused HLS folders periodically to ensure efficient disk usage.

This prototype allows you to dynamically generate HLS-streamable content from a given video source with multiple adaptive bitrate options and corresponding audio tracks.
