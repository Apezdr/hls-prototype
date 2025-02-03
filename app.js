// app.js
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var fs = require('fs');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cron = require('node-cron');
var { HLS_OUTPUT_DIR } = require('./config/config');

// Import your split route files
var videoRoutes = require('./routes/video');
var audioRoutes = require('./routes/audio');
var masterRoutes = require('./routes/master');

var app = express();

// View engine setup (if you're using Jade)
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Serve any static files in /public
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Use your split routes here.
 * 
 * - If you want to keep the URL paths exactly as defined in your route files,
 *   you can just do `app.use(...)` with no prefix.
 * 
 * - If you want a common prefix, e.g. `/api/stream`, do:
 *   `app.use('/api/stream', masterRoutes);`
 *   `app.use('/api/stream', audioRoutes);`
 *   `app.use('/api/stream', videoRoutes);`
 * 
 * Make sure the order won't conflict with your route patterns.
 */

// Example without an added prefix:
app.use(masterRoutes);
app.use(audioRoutes);
app.use(videoRoutes);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page (Jade template)
  res.status(err.status || 500);
  res.render('error');
});

/**
 * Optional: Cleanup process
 * A cron job that runs every 10 minutes to remove HLS folders
 * that haven’t been accessed in the last 55 minutes.
 */
cron.schedule('*/10 * * * *', () => {
  console.log('Running cleanup process...');
  try {
    const videos = fs.readdirSync(HLS_OUTPUT_DIR);
    videos.forEach((videoId) => {
      const videoPath = path.join(HLS_OUTPUT_DIR, videoId);
      // Iterate over each variant directory for this video
      const variants = fs.readdirSync(videoPath);
      variants.forEach((variantLabel) => {
        const variantPath = path.join(videoPath, variantLabel);
        const lockFile = path.join(variantPath, 'session.lock');
        if (fs.existsSync(lockFile)) {
          const stats = fs.statSync(lockFile);
          const lastAccess = new Date(stats.mtime).getTime();
          const now = Date.now();
          // Remove the session if it hasn't been updated for 55 minutes
          if (now - lastAccess > 55 * 60 * 1000) {
            fs.rmSync(variantPath, { recursive: true, force: true });
            console.log(`Cleaned up ${variantPath}`);
          }
        }
      });
    });
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
});

module.exports = app;
