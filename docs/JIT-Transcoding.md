# Just-In-Time Transcoding for HLS Streaming

This document explains the Just-In-Time (JIT) transcoding feature implemented in the HLS prototype. This feature allows streaming to start at any position within a video without needing to transcode the entire file from the beginning.

## Overview

Traditional HLS transcoding typically processes a video file from the beginning, which can cause delays when users want to start playback from the middle of a file. Just-In-Time transcoding solves this by:

1. Only generating segments that are explicitly requested
2. Transcoding from the closest keyframe to the requested position
3. Dynamically updating playlists as segments become available

## Features

- **Start Anywhere**: Begin playback from any position in the media file
- **Efficient Resource Usage**: Only transcode parts of the video that are actually watched
- **Seamless Experience**: Standard HLS clients work without modification
- **Dynamic Playlists**: HLS playlists are automatically updated as segments are generated
- **Concurrent Processing**: Multiple segments can be transcoded in parallel for different positions

## Architecture

The JIT transcoding implementation follows a modular design pattern:

```
├── utils/
│   └── timestampUtils.js     # Time and segment calculations
├── services/
│   └── segmentManager.js     # Core JIT transcoding logic
└── routes/
    └── video.jit.js          # JIT-specific route handlers
```

### Key Components

1. **Timestamp Utilities** (`utils/timestampUtils.js`)
   - Maps timestamps to segment numbers and vice versa
   - Finds nearest keyframes for clean seeking
   - Provides consistent segment filename formatting

2. **Segment Manager** (`services/segmentManager.js`)
   - Tracks segment status (existing, in-progress, pending)
   - Manages FFmpeg processes for timestamp-based transcoding
   - Updates playlists dynamically as segments are created
   - Handles discontinuities between non-contiguous segments

3. **JIT Routes** (`routes/video.jit.js`)
   - Creates empty playlists immediately
   - Handles segment requests with on-demand transcoding
   - Maintains compatibility with standard HLS clients

## How It Works

1. **Client Requests Master Playlist**
   - Server generates master playlist without starting transcoding

2. **Client Requests Variant Playlist**
   - Server creates an empty or minimal playlist
   - No transcoding is started yet

3. **Client Requests Segment at Position X**
   - Server calculates the segment number from the filename
   - Checks if the segment already exists
   - If not, starts an FFmpeg process from the appropriate timestamp
   - Returns 202 status to indicate the segment is being generated
   - Client automatically retries the request

4. **Segment Generation**
   - FFmpeg starts processing from the nearest keyframe
   - Generates a range of segments around the requested one
   - Updates the playlist as segments are created
   - Adds discontinuity markers when needed

5. **Segment Delivery**
   - Once segments are ready, they are served directly
   - Playlist is continually updated to reflect available segments

## Configuration

JIT transcoding can be enabled and configured through environment variables or in `config/config.js`:

```javascript
// In .env.local
JIT_TRANSCODING_ENABLED=true
JIT_SEGMENT_BUFFER=5
```

| Option | Description | Default |
|--------|-------------|---------|
| `JIT_TRANSCODING_ENABLED` | Enable/disable JIT transcoding | `false` |
| `JIT_SEGMENT_BUFFER` | Number of segments to generate before/after the requested segment | `5` |

## Usage

JIT transcoding is used automatically when enabled. When a client seeks to a specific position:

1. The HLS player calculates which segment contains that position
2. It requests that specific segment (e.g., `025.ts` for ~2 minutes into a video with 5-second segments)
3. The server starts transcoding from that position and returns a 202 status
4. The player retries the request until the segment is ready
5. Once ready, playback begins from that position

No special URL parameters or client modifications are needed - the system transparently handles everything.

## Progressive Segment Generation

The JIT transcoding system employs a smart strategy for generating segments:

1. **Complete Playlist Creation**: When a variant playlist is first requested, a complete playlist containing all segment references is created immediately with proper duration values, even though the segments don't physically exist yet
2. **On-Demand Generation**: When a segment is requested that doesn't exist on disk:
   - Transcoding begins from that point
   - It generates not just the requested segment, but up to 50 segments ahead
   - Transcoding then stops to conserve server resources
3. **Look-Ahead Resumption**: As the viewer approaches the end of available segments (within 20 segments), transcoding automatically resumes to stay ahead of playback
4. **Intelligent Termination**: The system stops transcoding when:
   - A viewer skips ahead (transcoding begins at the new position instead)
   - A viewer changes resolution (resources shift to the new resolution)
   - A viewer becomes inactive for 3 minutes (all their transcoding processes are terminated)

This approach ensures efficient resource usage while maintaining smooth playback for viewers.

This approach significantly reduces server load by not wasting resources on segments that will never be watched, particularly important for high-resolution content like 4K videos.

## Limitations

- **Initial Segment Delay**: The first segment request at a new position may take longer to fulfill
- **Seeking Accuracy**: Seeking is limited by keyframe positions in the source video
- **Disk Space**: Segments generated in different positions may increase disk usage
- **Audio Tracks**: The current implementation focuses on video segments; audio segments follow a similar pattern

## Implementation Notes

- FFmpeg's `-ss` parameter is placed before the input file for faster seeking
- GOP alignment is handled to ensure clean segment boundaries
- The original video route handlers remain available for comparison or fallback
- HDR and 10-bit content is properly handled through the established transcoding routines
- Hardware encoding is dynamically disabled for 10-bit content that's incompatible with hardware encoders

## Advanced Features

### HDR Content Handling

The JIT transcoding system inherits the sophisticated HDR handling from the main transcoding engine:

- Detects 10-bit content and HDR formats
- Automatically falls back to software encoding for 10-bit content
- Applies proper tone mapping for HDR to SDR conversion when needed
- Sets appropriate pixel formats for compatibility

### Format-Aware Encoding

The system makes intelligent decisions about encoding options:
- Selects appropriate codec profiles based on content type
- Handles HDR metadata correctly
- Follows the same patterns as the standard transcoding for consistency
