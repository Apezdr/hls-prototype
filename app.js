// app.js
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var fs = require('fs');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cron = require('node-cron');
const compression = require('compression');
var { HLS_OUTPUT_DIR, ENABLE_HLS_CLEANUP } = require('./config/config');

// Import your split route files
var videoRoutes = require('./routes/video');
var iframe = require('./routes/iframe');
var audioRoutes = require('./routes/audio');
var masterRoutes = require('./routes/master');
const config = require('./config/config');

var app = express();

// View engine setup (if you're using Jade)
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Enable gzip compression
app.use(compression());

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
app.use(iframe);

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
if (ENABLE_HLS_CLEANUP === 'true') {
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
} else {
  console.log('HLS cleanup cron job is disabled via environment configuration.');
}
// Advanced console welcome message with ASCII art and color
const colors = {
  Reset: "\x1b[0m",
  Bright: "\x1b[1m",
  FgCyan: "\x1b[36m",
  FgGreen: "\x1b[32m"
};


const sanitizedConfigs = Object.entries(config).reduce((acc, [key, value]) => {
  if (typeof value === 'string') {
    acc[key] = value.replace(/[\n\r]/g, '');
  } else {
    acc[key] = JSON.stringify(value);
  }
  return acc;
}, {});

console.log(`${colors.FgCyan}${colors.Bright}
 _   _  _      _____   _____                                 _           
| | | || |    /  ___| |_   _|                               | |          
| |_| || |    \\ \`--.    | |_ __ __ _ _ __  ___  ___ ___   __| | ___ _ __ 
|  _  || |     \`--. \\   | | '__/ _\` | '_ \\/ __|/ __/ _ \\ / _\` |/ _ \\ '__|
| | | || |____/\\__/ /   | | | | (_| | | | \\__ \\ (_| (_) | (_| |  __/ |   
\\_| |_/\\_____/\\____/    \\_/_|  \\__,_|_| |_|___/\\___\\___/ \\__,_|\\___|_|   
                                      
${colors.Reset}`);

//
// List configs in a table
console.log(`${colors.FgGreen}${colors.Bright}Current Configurations:`);

const entries = Object.entries(sanitizedConfigs);
const keyHeader = 'Key';
const valueHeader = 'Value';

// Calculate the maximum width for columns
const keyWidth = Math.max(...entries.map(([key]) => key.length), keyHeader.length);
const valueWidth = Math.max(...entries.map(([, value]) => String(value).length), valueHeader.length);

// Helper function to generate a row divider
const divider = '+' + '-'.repeat(keyWidth + 2) + '+' + '-'.repeat(valueWidth + 2) + '+';

console.log(divider);
console.log(`| ${keyHeader.padEnd(keyWidth)} | ${valueHeader.padEnd(valueWidth)} |`);
console.log(divider);
entries.forEach(([key, value]) => {
  console.log(`| ${key.padEnd(keyWidth)} | ${String(value).padEnd(valueWidth)} |`);
});
console.log(divider);
console.log(colors.Reset);

console.log(`${colors.FgGreen}Server started successfully on port ${process.env.PORT || 3232}${colors.Reset}`);

module.exports = app;
