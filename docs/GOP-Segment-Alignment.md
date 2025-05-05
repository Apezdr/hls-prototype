# GOP-Based Segment Alignment

This document explains the implementation of GOP-based segment alignment for HLS to improve compatibility between video and audio segments.

## Problem Statement

In HLS streaming, perfect segment alignment between video and audio is critical for:

1. More compact MPEG-DASH manifests (with segment timelines)
2. Seamless switching between audio/video variants
3. Better client-side buffer management
4. Reduced player discontinuities

The challenge arises because AAC audio frames have a fixed size of 1024 samples, while video frames follow the video's frame rate. When the durations don't align perfectly, it creates small discrepancies at segment boundaries.

## Solution: GOP Alignment Calculator

We implemented a GOP size calculator that ensures segment durations align perfectly with both video frame boundaries and AAC audio frame boundaries.

### Mathematical Basis

For perfect alignment:
- Audio frame duration = 1024 / sample_rate seconds
- Video frame duration = 1 / fps seconds
- Segment duration must be a multiple of both

The problem can be formulated as finding integers M and N where:
```
M * (1024 / sample_rate) = N / fps
```

This is a rational approximation problem. Rearranging:
```
M / N = fps * 1024 / sample_rate
```

We need to find the best rational approximation (M/N) to the ratio of audio and video frame durations.

### Continued Fraction Approach

To solve this problem efficiently, we use the theory of continued fractions, which provides the best rational approximations to any real number:

1. Express the ratio (fps * 1024 / sample_rate) as a continued fraction
2. Generate the "convergents" - rational approximations of increasing accuracy
3. Select the convergent that produces a segment duration closest to the target

This approach works for all frame rates, including non-integer rates like 23.976 fps (which is actually 24000/1001), where simpler approaches would fail.

### Implementation

1. **GOP Utility Module (`utils/gopUtils.js`)**
   - Core calculation functions that find the optimal GOP size and segment duration
   - Ensures perfect alignment between video frames and AAC audio frames
   - Provides fallback mechanisms if perfect alignment cannot be achieved

2. **Integration Points**
   - FFmpeg arguments: Uses aligned segment duration in `-hls_time` and `-force_key_frames`
   - Playlist generation: Uses exact aligned durations in segment entries
   - Both video and audio transcoding use the same aligned segment durations

## Example Calculation

For a 25fps video with 48kHz audio:
- AAC frame duration = 1024/48000 = 0.02133s
- For 5-second segments, we need a multiple of 0.02133s close to 5s
- This gives us 234 AAC frames (5.00172s) or 125 video frames (5s)
- The actual duration is 5.00172s, which ensures perfect alignment

## Benefits

- **Exact Segment Alignment**: Eliminates boundary discontinuities
- **More Compact Manifests**: With consistent segment durations
- **Improved Seeking**: Clean segment boundaries improve seeking accuracy
- **Better Caching**: Consistent segment durations improve CDN caching
- **Reduced Video/Audio Drift**: Prevents accumulation of timing errors

## Implementation Notes

This implementation modifies:
1. FFmpeg arguments to use exact segment durations
2. Segment duration calculations in playlist generation
3. GOP size and keyframe placement
4. Audio transcoding parameters to maintain alignment with video

The solution is transparent to players, requiring no client-side changes while providing better playback experience.
