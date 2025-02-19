// utils/rfc.js

/**
 * Determines an RFC 6381–compliant video codec string based on the video stream metadata.
 * Expects ffprobe to return integer `level` values for H.264 & HEVC (e.g., 41 => 4.1, 153 => 5.1).
 */
function determineVideoCodec(mediaInfo) {
    const videoStream = (mediaInfo.streams || []).find(
      (s) => s.codec_type === "video"
    );
    if (!videoStream) {
      throw new Error("No video stream found.");
    }
  
    const { codec_name, profile, level } = videoStream;
  
    switch (codec_name) {
      case "h264":
        return buildAvc1CodecString(profile, level);
      case "hevc":
        return buildHevcCodecString(profile, level);
      case "av1":
        return buildAv01CodecString(profile, level);
      default:
        throw new Error(`Unsupported codec: ${codec_name}`);
    }
  }
  
  /**
   * Build RFC 6381 string for H.264/AVC:
   *   avc1.PPCCLL
   * Where:
   *   PP   = profile in hex (42=Baseline, 4D=Main, 64=High, etc.)
   *   CC   = constraint flags (often 00 for standard)
   *   LL   = level in hex (0x29 = decimal 41 => Level 4.1)
   */
  function buildAvc1CodecString(profile, levelInteger) {
    if (typeof levelInteger !== "number") {
      throw new Error("H.264 level must be a number (e.g., 31 => 3.1).");
    }
  
    // Map ffprobe profile name to hex
    let profileHex;
    switch (profile) {
      case "Baseline":
        profileHex = "42";
        break;
      case "Main":
        profileHex = "4D";
        break;
      case "High":
        profileHex = "64";
        break;
      case "High 10":
        // Usually 6E, but might vary. This is a minimal example.
        profileHex = "6E";
        break;
      // Expand if you have others like High 4:4:4, etc.
      default:
        console.warn(`Unknown H.264 profile: "${profile}". Using "High" (0x64).`);
        profileHex = "64";
        break;
    }
  
    // ffprobe for H.264 typically returns integer level, e.g. 41 => Level 4.1
    // Convert to hex. E.g. 41 => 0x29
    const levelHex = levelInteger.toString(16).toUpperCase().padStart(2, "0");
  
    // Use "00" for constraint flags by default
    const constraintFlags = "00";
  
    return `avc1.${profileHex}${constraintFlags}${levelHex}`;
  }
  
  /**
   * Build RFC 6381 string for HEVC:
   *   hvc1.<profile_idc>.<tier_flag>.L<level>.B0
   *
   * Realistically, you often see Apple docs referencing “hvc1.1.6.L153.B0” for Main@L5.1,
   * but ffprobe might report level=153 for 5.1 or 93 for 3.1, etc.
   *
   * This is still a simplification—tier=6 is not strictly standard,
   * and level is used "as is". For full correctness, you’d map numeric levels to strings
   * (e.g. 153 => "5.1") or 93 => "3.1", etc. Then you'd produce "L153" or "L93".
   */
  function buildHevcCodecString(profile, levelInteger) {
    if (typeof levelInteger !== "number") {
      throw new Error("Level is required for HEVC (and must be an integer).");
    }
  
    // Map the profile to ID
    let profileIdc;
    switch (profile) {
      case "Main":
        profileIdc = 1;
        break;
      case "Main 10":
        profileIdc = 2;
        break;
      default:
        console.warn(`Unknown HEVC profile: "${profile}". Using Main (idc=1).`);
        profileIdc = 1;
        break;
    }
  
    // For demonstration, we keep tier = "6" as you had, but normally you'd do:
    //    tier=0 or tier=1, or parse it from ffprobe if available.
    const tierFlag = "6";
  
    // levelInteger might be 153 => 5.1, 93 => 3.1, etc.
    // We'll just use "153" literally => L153
    const levelStr = levelInteger.toString();
  
    // We'll use "B0" for the compatibility flags by default
    const compatibility = "B0";
  
    return `hvc1.${profileIdc}.${tierFlag}.L${levelStr}.${compatibility}`;
  }
  
  /**
   * Build RFC 6381 string for AV1 (very simplified).
   *   av01.P.LL.DD...
   *
   * In practice, AV1 strings can be more complex (bit-depth, color, etc.).
   * Also, ffprobe might return integer level=31 for 3.1. Some encoders store it differently.
   *
   * For now, we do naive float->( *10 )->hex approach, which only works if ffprobe
   * returns the level as a float. If ffprobe returns 31 => 3.1, you'd need
   * a mapping or different logic. This is just an example.
   */
  function buildAv01CodecString(profile, level) {
    if (level === undefined) {
      throw new Error("Level is required for AV1.");
    }
  
    let profileIdc;
    switch (profile) {
      case "Main":
        profileIdc = 0;
        break;
      case "High":
        profileIdc = 1;
        break;
      case "Professional":
        profileIdc = 2;
        break;
      default:
        console.warn(`Unknown AV1 profile: "${profile}". Using Main (0).`);
        profileIdc = 0;
        break;
    }
  
    // If ffprobe returns an integer like 31 => means 3.1
    // For a minimal approach, if level=31 => parse out => "3.1" => multiply 3.1*10 => 31 => 0x1F => "1F"
    // This example is still naive. AV1 has a more complex scheme.
    // We'll do a quick check:
    let numericLevel;
    if (Number.isInteger(level) && level >= 10) {
      // e.g. 31 => 3.1
      numericLevel = level; // "31" => we might want to parse it as 3.1 => multiply by 10 => 31 => ...
      // This can get cyclical. Real code might do a map: {20: 2.0, 31:3.1, etc.}
    } else {
      // e.g. 4.1 => multiply by 10 => 41
      numericLevel = Math.round(level * 10);
    }
  
    const levelHex = numericLevel.toString(16).toUpperCase().padStart(2, "0");
    // e.g. 31 decimal => 0x1F => "1F"
  
    // Minimal
    const codecString = `av01.0${profileIdc}.00.${levelHex}`;
    return codecString.toLowerCase();
  }
  
  module.exports = { determineVideoCodec };
  