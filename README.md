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

## Just-In-Time (JIT) Transcoding

This prototype now includes Just-In-Time (JIT) transcoding capabilities, allowing users to start playback from any position in a video without waiting for the entire file to be transcoded.

### How JIT Transcoding Works

Traditional HLS transcoding processes a video file from the beginning, which can cause delays when users want to watch from the middle of a video. With JIT transcoding:

1. When a user seeks to a specific position in the video, the HLS player requests the segment containing that position
2. If the segment doesn't exist, the server automatically starts transcoding from that position
3. The server returns a "202 Accepted" status while generating the segment
4. The player automatically retries, and when the segment is ready, playback begins from that position

### Enabling JIT Transcoding

JIT transcoding can be enabled through environment variables:

```
# In .env.local
JIT_TRANSCODING_ENABLED="true"
JIT_SEGMENT_BUFFER="5"  # Number of segments to generate before/after the requested segment
```

### Benefits of JIT Transcoding

- **Efficient Resource Usage**: Only transcode parts of videos that are actually watched
- **Fast Seeking**: Start playback from any position without waiting for the entire file to be processed
- **Standard Player Compatibility**: Works with any HLS-compatible player without modifications
- **Dynamic Playlist Updates**: Playlists automatically update as segments become available

For detailed documentation, see [docs/JIT-Transcoding.md](docs/JIT-Transcoding.md) and [docs/README-JIT.md](docs/README-JIT.md).
