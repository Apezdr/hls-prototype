# Just-In-Time (JIT) Transcoding for HLS Streaming

## Quick Start

1. **Enable JIT Transcoding** in your `.env.local` file:
   ```
   JIT_TRANSCODING_ENABLED="true"
   JIT_SEGMENT_BUFFER="5"  # Number of segments to buffer before/after request
   ```

2. **Start the server**:
   ```
   npm start
   ```

3. **Use a standard HLS player** - The JIT features work transparently with any HLS-compatible player.

4. **Observe the behavior** - When seeking to a position, the server will:
   - Immediately generate a placeholder playlist
   - Start transcoding from the requested position when segments are requested
   - Update the playlist as segments become available

## Directory Structure

The JIT transcoding implementation is organized in a modular way:

- `config/config.js` - Configuration settings for JIT transcoding
- `utils/timestampUtils.js` - Utilities for segment/timestamp calculations
- `services/segmentManager.js` - Core segment management and FFmpeg process control
- `routes/video.jit.js` - JIT-specific route handlers
- `docs/JIT-Transcoding.md` - Detailed documentation
- `test/jit-demo.js` - Demo script to test JIT functionality

## How It Works

When a user seeks to a position in a video:

1. The player calculates which segment contains that position
2. It requests that segment (e.g., `025.ts` for position ~2:05 with 5-second segments)
3. The server:
   - Checks if the segment exists
   - If not, starts FFmpeg from the nearest keyframe to that timestamp
   - Returns a 202 status code indicating the segment is being generated
4. The player automatically retries after receiving a 202
5. Once the segment is ready, the server returns it with a 200 status
6. The player begins playback from the requested position

## Testing the Feature

You can use the included test script to demonstrate JIT transcoding:

```bash
# Update VIDEO_ID in the script to match a video in your media directory
node test/jit-demo.js
```

This script:
- Requests the master and variant playlists
- Requests segments from the beginning, middle, and end of the video
- Saves the downloaded segments and playlist
- Shows how the playlist is dynamically updated

## Limitations and Considerations

- Initial segment requests at new positions may take longer to fulfill
- Seeking accuracy is limited by keyframe positions in the source video
- More disk space may be used when segments are generated at different positions
- The current implementation focuses on video segments (audio JIT support coming soon)

## Future Improvements

- JIT transcoding for audio segments
- More sophisticated segment caching and cleanup
- Predictive transcoding based on playback patterns
- Better support for concurrent seeked positions

For more detailed information, see [JIT-Transcoding.md](JIT-Transcoding.md).
