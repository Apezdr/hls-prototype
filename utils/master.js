// utils/master.js
const path = require("path");
const {
  WEB_SUPPORTED_CODECS,
  HLS_OUTPUT_DIR,
  VIDEO_SOURCE_DIR,
  HLS_IFRAME_ENABLED,
  scoringConfig,
} = require("../config/config");
const {
  handleAudioTranscodingSession,
  handleVideoTranscodingSession,
} = require("../services/ffmpegService");
const { mapLanguage, mapCodec } = require("./audio");
const { safeFilename } = require("./files");
const findVideoFile = require("./findVideoFile");
const { ensureVideoVariantInfo } = require("./manifest");

/**
 * Extracts a numeric channel count from a string like "8", "6", or "16/JOC".
 * If it doesn't contain a slash, parse as integer. If it does, parse up to the slash.
 */
function parseNumericChannels(channelsStr) {
  if (!channelsStr) return '2';
  // e.g. "16/JOC" => "16"
  const slashIndex = channelsStr.indexOf('/');
  if (slashIndex >= 0) {
    return channelsStr.substring(0, slashIndex);
  }
  const parsed = parseInt(channelsStr, 10);
  return isNaN(parsed) ? '2' : parsed.toString();
}

function sanitizeCodec(codec) {
  return codec.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function buildAudioGroupKey(rfcAudioCodec, channels, isAtmos = false, language, audioCodec) {
  // Build a composite key: sanitized codec string + numeric channel count.
  const numericChannels = parseNumericChannels(String(channels));
  return `${language}`;
  //return `${sanitizeCodec(rfcAudioCodec)}${numericChannels}`;
}

/**
 * Builds a canonical name for an audio track.
 * - For stereo tracks, return "ENG Stereo" (or "FRE Stereo", etc.)
 * - For 5.1 tracks:
 *     - If the track is native E-AC3 (and not a fallback), append " (Dolby Digital Plus)".
 *     - If the track is a fallback (AC-3), append " (Dolby Digital)".
 * - Otherwise, return a basic string.
 */
function buildCanonicalTrackName(track) {
  const lang = (track.language || 'und').toUpperCase();
  if (parseInt(track.channels, 10) === 2) {
    return `${lang} Stereo`;
  } else if (parseInt(track.channels, 10) > 2) {
    // For multichannel tracks (e.g. 5.1), check if this is a fallback track.
    if (track.isFallback) {
      return `${lang} 5.1 (Dolby Digital)`;
    }
    // Assume native E-AC3 if the codec is "eac3"
    if (track.audioCodec.toLowerCase() === "eac3") {
      return `${lang} 5.1 (Dolby Digital Plus)`;
    }
    // Otherwise, simply return the base.
    return `${lang} 5.1`;
  }
  return `${lang} Audio`;
}


/**
 * Dynamically collects audio groups based on the available "full" tracks.
 *
 * For each language found in the audioInfoList, we build two groups:
 *   - A "full" group (preserving the native track codec, including Atmos-specific changes).
 *   - An "AAC-only" group where we force each member to use AAC.
 *
 * Both groups will have the same number of members in the same order.
 *
 * Returns an object mapping group IDs to a group object:
 *   { groupId, tracks: [ trackObj, ... ], codecs: Set([...]) }
 *
 * Each trackObj contains:
 *   - name, uri, channels, default, autoselect, language, and codec.
 */
function collectAudioGroups(audioInfoList, videoId, isDone) {
  const groups = {};
  // Group tracks by language (default to 'und')
  const tracksByLang = {};
  for (const track of audioInfoList) {
    const lang = track.language || 'und';
    if (!tracksByLang[lang]) {
      tracksByLang[lang] = [];
    }
    // Attach videoId for URI generation.
    tracksByLang[lang].push({ ...track, videoId });
    isDone.push(track.isDone);
  }

  // For each language, build two groups.
  for (const [lang, tracks] of Object.entries(tracksByLang)) {
    // Sort tracks by index to ensure consistent order.
    tracks.sort((a, b) => {
      if (a.index === "stereo") return -1;
      if (b.index === "stereo") return 1;
      // For fallback entries, assume index strings like "1" and "1_ac3" so that
      // they sort together.
      const idxA = parseInt(a.index, 10);
      const idxB = parseInt(b.index, 10);
      return idxA - idxB;
    });

    // Define group IDs.
    const fullGroupId = `audio-${lang}-full`;
    const aacGroupId = `audio-${lang}-aac`;

    // Initialize groups.
    groups[fullGroupId] = {
      groupId: fullGroupId,
      tracks: [],
      codecs: new Set()
    };
    groups[aacGroupId] = {
      groupId: aacGroupId,
      tracks: [],
      codecs: new Set(['mp4a.40.2']) // AAC-only group forces AAC.
    };

    // For each track in the "full" set, add a member to both groups.
    for (const track of tracks) {
      // Build the canonical name. For Atmos tracks, this will append "(Dolby Atmos)".
      const canonicalName = buildCanonicalTrackName(track);

      // Determine the codec for the full group:
      // If the track is Atmos, update its codec using your mapping function.
      const fullCodec = track.rfcAudioCodec;

      const channels = track.isAtmos
        ? `${track.complexity}/${track.additionalFeatures}`
        : track.channels.toString();
      
      // Build member for the full group.
      const fullMember = {
        name: canonicalName,
        uri: `/api/stream/${safeFilename(videoId)}/audio/track_${track.index}_${track.codec}/playlist.m3u8`,
        channels: channels,
        default: track.default || "NO",
        autoselect: track.autoselect || "NO",
        language: track.language || 'und',
        codec: fullCodec
      };
      groups[fullGroupId].tracks.push(fullMember);
      groups[fullGroupId].codecs.add(fullCodec);

      // Build member for the AAC-only group (force codec to AAC).
      const aacMember = {
        name: canonicalName, // Same canonical name so that the groups mirror each other.
        uri: `/api/stream/${safeFilename(videoId)}/audio/track_${track.index}_aac/playlist.m3u8`,
        channels: track.channels.toString(),
        default: track.default || "NO",
        autoselect: track.autoselect || "NO",
        language: track.language || 'und',
        codec: "mp4a.40.2"
      };
      groups[aacGroupId].tracks.push(aacMember);
    }
  }
  return groups;
}

/**
 * Computes a score for a given variant based on resolution, bitrate, audio codec, and language.
 * Higher scores are preferred.
 *
 * @param {Object} variant - The video variant (e.g. { resolution: "1920x1080", bitrate: "2500k", label: "1080p" }).
 * @param {Object} audioGroup - The audio group object (e.g. { groupId: "audio-eng-full", tracks: [...], codecs: Set([...]) }).
 * @param {Object} config - Configuration weights (e.g. languageWeights, codecWeights, resolutionFactor, fullGroupBonus, bitrateFactor).
 * @returns {string} A stringified floating point score (e.g. "0.85").
 */
function computeVariantScore(variant, audioGroup, config) {
  let score = 0;

  // Factor 1: Resolution (area)
  const [width, height] = variant.resolution.split('x').map(Number);
  score += width * height * (config.resolutionFactor || 1e-6);

  // Factor 2: Bitrate (optional, lower weight usually)
  const bitrate = parseInt(variant.bitrate.replace("k", "")) * 1000;
  score += bitrate * (config.bitrateFactor || 1e-8);

  // Factor 3: Audio Codec Preference
  // Assume audioGroup.codecs is a Set; choose the primary codec (or you could average if you like)
  const primaryAudioCodec = Array.from(audioGroup.codecs)[0];
  if (config.codecWeights && config.codecWeights[primaryAudioCodec]) {
    score *= config.codecWeights[primaryAudioCodec];
  }

  // Factor 4: Language Preference
  // Use the language from the first track in the group.
  const lang = (audioGroup.tracks[0].language || 'und').toLowerCase();
  if (config.languageWeights && config.languageWeights[lang]) {
    score *= config.languageWeights[lang];
  }

  // Factor 5: Group type bonus
  // If using the full group (native codecs), you might want to favor it.
  if (audioGroup.groupId.endsWith("-full")) {
    score += (config.fullGroupBonus || 0.1);
  }

  return score.toFixed(2); // return as a string with 2 decimals
}

/**
 * Generates EXT-X-MEDIA tags for each audio group.
 *
 * @param {Object} audioGroups - Object of groups built from collectAudioGroups().
 * @returns {string} - The generated EXT-X-MEDIA lines.
 */
async function generateAudioMediaTags(audioGroups) {
  let tags = "";
  // For each group, output a comment header and then each member line.
  for (const groupId in audioGroups) {
    const group = audioGroups[groupId];
    tags += `\n# Audio Group: ${groupId}\n`;
    for (const member of group.tracks) {
      tags += `#EXT-X-MEDIA:TYPE=AUDIO,`;
      tags += `GROUP-ID="${group.groupId}",`;
      tags += `NAME="${member.name}",`;
      tags += `LANGUAGE="${mapLanguage(member.language)}",`;
      tags += `DEFAULT=${member.default},`;
      tags += `AUTOSELECT=${member.autoselect},`;
      tags += `CODECS="${member.codec}",`;
      tags += `CHANNELS="${member.channels}",`;
      tags += `URI="${member.uri}"\n`;
    }
  }
  return tags;
}

/**
 * Generates EXT-X-STREAM-INF tags for each video variant.
 *
 * For each variant and for each audio group (e.g. per language and group type),
 * a variant line is produced. The CODECS attribute is built as the combination of the
 * video codec (from transcoding info) and the union of audio codecs present in the group.
 *
 * @param {Array} variantSet - List of video variant configurations.
 * @param {string} videoId - The video identifier.
 * @param {number} maxAudioBitrate - Highest measured bitrate from audio tracks.
 * @param {string} defaultVideoCodec - Default video codec.
 * @param {string|number} frameRate - Frame rate of the video.
 * @param {Object} audioGroups - The audio groups built from collectAudioGroups().
 * @returns {Promise<string>} - The generated variant lines.
 */
async function generateVideoVariantTags(
  variantSet,
  videoId,
  maxAudioBitrate,
  defaultVideoCodec,
  frameRate,
  audioGroups,
  isDone
) {
  let tags = "";
  const videoPath = findVideoFile(videoId, VIDEO_SOURCE_DIR);

  // For each video variant (e.g. 1080p, 4k, etc.)
  for (const variant of variantSet) {
    let bitrate = parseInt(variant.bitrate.replace("k", "")) * 1000;
    let totalBitrate = Math.round(bitrate + maxAudioBitrate);
    let resolution = variant.resolution;
    const variantDir = path.join(HLS_OUTPUT_DIR, safeFilename(videoId), variant.label);

    // Initiate transcoding session asynchronously.
    handleVideoTranscodingSession(videoId, variant, videoPath);

    try {
      const info = await ensureVideoVariantInfo(videoId, variant, variantDir);
      bitrate = Math.round(info.measuredBitrate);
      totalBitrate = Math.round(bitrate + maxAudioBitrate);
      resolution = `${info.width}x${info.height}`;
      const transcodedVideoCodec = info.rfcCodec || defaultVideoCodec;
      const videoRange = info.videoRange || "SDR";
      isDone.push(info.isDone);

      // For each audio group, output a variant line.
      for (const groupKey in audioGroups) {
        const group = audioGroups[groupKey];

        // Determine the union of audio codecs based on group type.
        // For the "full" group, include native codecs (e.g. ec-3, ac-3).
        // For the "aac" group, force only AAC.
        let unionAudioCodecs;
        if (group.groupId.endsWith("-full")) {
          unionAudioCodecs = Array.from(group.codecs).join(",");
        } else if (group.groupId.endsWith("-aac")) {
          unionAudioCodecs = "mp4a.40.2";
        } else {
          unionAudioCodecs = Array.from(group.codecs).join(",");
        }

        const combinedCodecs = `${transcodedVideoCodec},${unionAudioCodecs}`;
        const audioGroupId = group.groupId;
        // Build a variant URI that includes the audio group ID as a suffix.
        const variantUri = `/api/stream/${safeFilename(videoId)}/${variant.label}/playlist_${group.groupId}.m3u8`;

        // Compute a score for this variant based on the group and configuration.
        const score = computeVariantScore(variant, group, scoringConfig);

        tags += `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(totalBitrate * 1.2)},`;
        tags += `AVERAGE-BANDWIDTH=${totalBitrate},`;
        tags += `RESOLUTION=${resolution},`;
        tags += `FRAME-RATE=${frameRate},`;
        tags += `CODECS="${combinedCodecs}",`;
        tags += `AUDIO="${audioGroupId}",`;
        tags += `VIDEO-RANGE=${videoRange},`;
        tags += `SCORE=${score},`;
        tags += `CLOSED-CAPTIONS=NONE\n`;
        tags += `${variantUri}\n`;

        if (HLS_IFRAME_ENABLED && !isDone.includes(false)) {
          tags += `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=${Math.round(totalBitrate * 0.5)},`;
          tags += `CODECS="${transcodedVideoCodec}",`;
          tags += `RESOLUTION=${resolution},`;
          tags += `URI="/api/stream/${safeFilename(videoId)}/${variant.label}/iframe_playlist.m3u8"\n`;
        }
      }
    } catch (err) {
      console.error(`Error ensuring variant info for ${variant.label}:`, err);
      // Fallback: output one variant per audio group using default settings.
      for (const groupKey in audioGroups) {
        const group = audioGroups[groupKey];
        const audioGroupId = group.groupId;
        const variantUri = `/api/stream/${safeFilename(videoId)}/${variant.label}/playlist_${group.groupId}.m3u8`;
        let unionAudioCodecs;
        if (group.groupId.endsWith("-full")) {
          unionAudioCodecs = Array.from(group.codecs).join(",");
        } else if (group.groupId.endsWith("-aac")) {
          unionAudioCodecs = "mp4a.40.2";
        } else {
          unionAudioCodecs = Array.from(group.codecs).join(",");
        }
        const combined = `${defaultVideoCodec},${unionAudioCodecs}`;
        tags += `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(totalBitrate * 1.2)},`;
        tags += `AVERAGE-BANDWIDTH=${totalBitrate},`;
        tags += `RESOLUTION=${resolution},`;
        tags += `FRAME-RATE=${frameRate},`;
        tags += `CODECS="${combined}",`;
        tags += `AUDIO="${audioGroupId}",`;
        tags += `VIDEO-RANGE="SDR",`;
        tags += `CLOSED-CAPTIONS=NONE\n`;
        tags += `${variantUri}\n`;
      }
    }
  }
  return tags;
}

module.exports = { buildAudioGroupKey, generateAudioMediaTags, generateVideoVariantTags, collectAudioGroups };
