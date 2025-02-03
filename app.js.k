// server.js
const express = require("express");
const app = express();
const videoRoutes = require('./routes/video');
const audioRoutes = require('./routes/audio');
const masterRoutes = require('./routes/master');
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const { HLS_OUTPUT_DIR } = require("./config/config");

// Use the stream routes
app.use(videoRoutes);
app.use(audioRoutes);
app.use(masterRoutes);

// Serve static files (if needed)
// app.use(express.static(path.join(__dirname, 'public')));

// Start Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

/**
 * Optional: Cleanup process
 * A cron job that runs every 10 minutes to remove HLS folders
 * that haven’t been accessed in the last 30 minutes.
 */
cron.schedule("*/10 * * * *", () => {
  console.log("Running cleanup process...");
  try {
    const videos = fs.readdirSync(HLS_OUTPUT_DIR);
    videos.forEach((videoId) => {
      const videoPath = path.join(HLS_OUTPUT_DIR, videoId);
      // Iterate over each variant directory for this video
      const variants = fs.readdirSync(videoPath);
      variants.forEach((variantLabel) => {
        const variantPath = path.join(videoPath, variantLabel);
        const lockFile = path.join(variantPath, "session.lock");
        if (fs.existsSync(lockFile)) {
          const stats = fs.statSync(lockFile);
          const lastAccess = new Date(stats.mtime).getTime();
          const now = Date.now();
          // Remove the session if it hasn't been updated for 30 minutes
          if (now - lastAccess > 30 * 60 * 1000) {
            fs.rmSync(variantPath, { recursive: true, force: true });
            console.log(`Cleaned up ${variantPath}`);
          }
        }
      });
    });
  } catch (error) {
    console.error("Error during cleanup:", error);
  }
});

module.exports = app;