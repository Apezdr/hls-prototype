/**
 * Extracts the peak brightness from mediainfo JSON.
 * Expects a string like "min: 0.0050 cd/m2, max: 1000 cd/m2"
 * and returns the numeric maximum value.
 */
function getPeakBrightness(mediaInfo) {
    try {
      const videoTrack = mediaInfo.media.track.find(
        (track) => track["@type"] === "Video" && track.MasteringDisplay_Luminance
      );
      if (videoTrack && videoTrack.MasteringDisplay_Luminance) {
        // Split the string into parts.
        const parts = videoTrack.MasteringDisplay_Luminance.split(",");
        for (const part of parts) {
          if (part.includes("max:")) {
            // Extract the number, removing any "cd/m2"
            const valueStr = part.split(":")[1].trim().split(" ")[0];
            return parseFloat(valueStr);
          }
        }
      }
    } catch (err) {
      console.error("Error extracting peak brightness:", err);
    }
    return 1000; // Fallback if parsing fails.
}

module.exports = { getPeakBrightness };