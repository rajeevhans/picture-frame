# Raspberry Pi Digital Picture Frame - Project Summary

## Overview
A complete, production-ready digital picture frame application built with Node.js, designed to run on Raspberry Pi with a 4K TV. The system can handle 200,000+ photos with full metadata indexing, automatic file monitoring, and a web-based control interface.

## ✅ Completed Implementation

All planned features have been successfully implemented:

### 1. **Project Setup** ✓
- Node.js project with Express framework
- Clean folder structure
- Configuration management via `config.json`
- Package management with npm

### 2. **Database Layer** ✓
- SQLite3 with better-sqlite3 (optimized for performance)
- Complete schema with images and settings tables
- Indexed fields for fast queries on 200k+ images
- Support for EXIF metadata (date, GPS, camera info)
- Cached geolocation data (city, country)
- Image rotation state tracking
- Tags system for categorization
- Physical file deletion (moves to data/deleted folder)
- Favorites system
- Orphaned entry cleanup

### 3. **Image Indexer** ✓
- Recursive directory scanning
- EXIF metadata extraction using exifreader
- Batch processing with progress logging
- Smart file modification detection (skip unchanged files)
- Support for multiple image formats (.jpg, .jpeg, .png, .gif, .webp, .heic, .heif)
- Handles 200k+ images efficiently

### 4. **File System Monitoring** ✓
- Real-time monitoring with chokidar
- Automatic re-indexing on file add/change/delete
- Debounced events to prevent excessive processing
- Queued task processing to avoid system overload

### 5. **Slideshow Engine** ✓
- **Three selection modes:**
  - Sequential (by date or filename)
  - Random
  - Smart (weighted by favorites and recent photos)
- Configurable interval (5s to 5min)
- History tracking for previous button
- Image preloading for smooth transitions
- Filter options (favorites only, etc.)

### 6. **API Endpoints** ✓
Complete REST API:
- `GET /api/image/current` - Get current image
- `GET /api/image/next` - Next image
- `GET /api/image/previous` - Previous image
- `GET /api/image/:id/serve` - Serve image file with caching
- `POST /api/image/:id/favorite` - Toggle favorite
- `POST /api/image/:id/rotate-left` - Physically rotate image counter-clockwise
- `POST /api/image/:id/rotate-right` - Physically rotate image clockwise
- `DELETE /api/image/:id` - Delete image (moves to data/deleted folder)
- `GET /api/settings` - Get slideshow settings
- `POST /api/settings` - Update settings (supports thisday order)
- `POST /api/database/reset` - Reset database and re-index
- `GET /api/stats` - Database statistics
- `GET /api/health` - Health check

### 7. **Web Interface** ✓
Modern, fullscreen web interface:
- **Display:**
  - Fullscreen image viewer with smooth fade transitions
  - Proper image scaling (contain fit)
  - Support for various image orientations
  
- **Controls:**
  - Auto-hiding control overlay (shows on mouse move, hides after 5s)
  - Play/Pause slideshow
  - Next/Previous navigation
  - Favorite toggle (visual indicator)
  - Rotate left/right buttons (physically rotates image file)
  - Delete button with confirmation (moves to data/deleted folder)
  - Info overlay with metadata
  - Settings panel
  - Live clock display (top right corner)
  
- **Keyboard Shortcuts:**
  - Arrow keys: Navigate
  - Space: Play/Pause
  - F: Toggle favorite
  - D: Delete (moves file to data/deleted)
  - [ : Rotate left 90°
  - ] : Rotate right 90°
  - I: Toggle info overlay
  - S: Open settings
  - Escape: Close panels

- **Settings Panel:**
  - Mode selection (Sequential/Random/Smart)
  - Order selection (Date/Filename/This Day in History)
  - Interval configuration
  - Favorites filter
  - Live statistics display
  - Database reset button (danger zone)

- **Info Overlay:**
  - Date taken
  - GPS coordinates (if available)
  - Camera make/model
  - Image resolution

- **Location Display:**
  - Bottom left overlay showing date and location
  - Reverse geocoding (city, country) via OpenStreetMap
  - Automatic background lookup for images with GPS data
  - Displays date even when location is unavailable

### 8. **Auto-Start System** ✓
- Two systemd services:
  - `pictureframe.service` - Node.js backend server
  - `pictureframe-display.service` - Chromium in kiosk mode
- Auto-restart on failure
- Proper dependency management
- Logging to systemd journal

### 9. **Installation Script** ✓
Automated installation script (`install.sh`):
- Checks for Node.js and Chromium
- Installs dependencies if needed
- Configures photo directory
- Updates systemd services
- Enables auto-start on boot
- Optionally disables screen blanking
- Provides usage instructions

## Project Structure

```
picture-frame/
├── package.json              # Node.js dependencies
├── config.json               # User configuration
├── README.md                 # Documentation
├── install.sh               # Installation script (executable)
├── launch-kiosk-macos.sh    # macOS kiosk launcher
├── .gitignore
├── systemd/
│   ├── pictureframe.service          # Backend service
│   └── pictureframe-display.service  # Display service
├── src/
│   ├── server.js                     # Express app entry point
│   ├── database/
│   │   ├── db.js                     # Database manager
│   │   └── schema.sql                # Database schema
│   ├── indexer/
│   │   ├── metadata.js               # EXIF extraction
│   │   ├── scanner.js                # Directory scanner
│   │   └── watcher.js                # File monitoring
│   ├── slideshow/
│   │   └── engine.js                 # Slideshow logic
│   ├── services/
│   │   ├── geolocation.js            # Reverse geocoding service
│   │   └── imageRotation.js          # Image rotation service
│   ├── routes/
│   │   ├── images.js                 # Image API routes
│   │   └── settings.js               # Settings API routes
│   └── public/
│       ├── index.html                # Web UI
│       ├── css/
│       │   └── style.css             # Styling
│       └── js/
│           └── app.js                # Frontend logic
└── data/
    ├── pictureframe.db               # SQLite database (created at runtime)
    └── deleted/                      # Deleted images backup folder
```

## Technology Stack

- **Backend:** Node.js with Express
- **Database:** SQLite3 with better-sqlite3
- **Metadata:** exifreader (EXIF extraction)
- **Image Processing:** Sharp (for physical rotation)
- **Geolocation:** OpenStreetMap Nominatim API
- **File Monitoring:** chokidar
- **Frontend:** Vanilla JavaScript (no framework dependencies)
- **Display:** Chromium in kiosk mode
- **Auto-start:** systemd

## Key Features

✓ Handles 200,000+ images efficiently
✓ Automatic metadata indexing (date, GPS, camera, dimensions)
✓ Reverse geocoding with location display (city, country)
✓ Real-time file system monitoring
✓ Three slideshow modes (sequential, random, smart)
✓ "This Day in History" mode (photos from today's date across years)
✓ Physical image rotation (permanently rotates files)
✓ Web-based remote control
✓ Keyboard shortcuts
✓ Favorite functionality
✓ Delete functionality (moves files to data/deleted folder)
✓ Image preloading for smooth transitions
✓ Auto-start on Raspberry Pi boot
✓ Fullscreen kiosk mode with live clock
✓ Configurable slideshow intervals
✓ Statistics dashboard
✓ Database reset and rebuild
✓ Responsive design
✓ Aggressive cache clearing for rotated images

## Installation Instructions

1. **Copy to Raspberry Pi:**
   ```bash
   scp -r picture-frame pi@raspberrypi.local:/home/pi/
   ```

2. **Run installation script:**
   ```bash
   cd /home/pi/picture-frame
   ./install.sh
   ```

3. **Configure photo directory:**
   The script will prompt for your photo directory location.

4. **Run initial indexing:**
   ```bash
   npm run index
   ```

5. **Services will auto-start on next boot!**

## Development/Testing

To test on a development machine:

```bash
cd picture-frame
npm install
# Edit config.json to point to a test photo directory
npm start
# Open browser to http://localhost:3000
```

## Usage Commands

```bash
# Start/stop services
sudo systemctl start pictureframe
sudo systemctl stop pictureframe
sudo systemctl restart pictureframe

# View logs
sudo journalctl -u pictureframe.service -f
sudo journalctl -u pictureframe-display.service -f

# Check status
sudo systemctl status pictureframe

# Force re-index
npm run index

# Development mode
npm run dev
```

## Performance Optimizations

1. **Database:**
   - WAL mode for better concurrency
   - Proper indexes on frequently queried fields
   - Prepared statements for repeated queries
   - Batch inserts for initial indexing

2. **File System:**
   - Debounced file change events
   - Queued task processing
   - Skip unchanged files during re-indexing

3. **Image Serving:**
   - HTTP caching headers
   - Image preloading (next 3 images)
   - ETag support

4. **UI:**
   - Smooth CSS transitions
   - Auto-hiding controls
   - Efficient DOM updates

## Configuration Options

Edit `config.json`:

```json
{
  "photoDirectory": "/path/to/photos",
  "databasePath": "./data/pictureframe.db",
  "serverPort": 3000,
  "slideshow": {
    "defaultInterval": 10,
    "defaultMode": "sequential",
    "defaultOrder": "date"
  },
  "fileExtensions": [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"],
  "indexing": {
    "batchSize": 100,
    "logInterval": 500
  }
}
```

## Security Considerations

- No authentication (designed for local network use)
- Delete moves files to data/deleted folder (recoverable)
- Physical rotation modifies original files (permanent)
- Read-only file serving with caching (except rotation/delete)
- Sandboxed Chromium browser in kiosk mode
- Rate-limited geolocation API calls

## Future Enhancement Ideas

(Not implemented, but could be added):
- Thumbnail generation for faster loading
- Multiple photo directories
- Image editing capabilities
- Cloud sync integration
- Face recognition tagging
- Slideshow transitions effects
- Mobile app for remote control
- Multi-language support
- Theme customization
- Photo albums/collections

## Status: COMPLETE ✓

All planned features have been implemented and tested. The application is ready for deployment on Raspberry Pi.

---

**Date Completed:** December 29, 2025
**Total Files:** 25+ source files (including documentation)
**Lines of Code:** ~3,500+
**Estimated Index Time:** ~10 seconds per 1,000 images

## Recent Enhancements

### December 28-29, 2025 Updates:

1. **Physical Image Rotation**
   - Added Sharp library for image processing
   - Rotate left/right buttons physically modify image files
   - Aggressive cache clearing ensures rotated images display immediately
   - Backup system prevents data loss during rotation

2. **Geolocation Feature**
   - Reverse geocoding using OpenStreetMap Nominatim API
   - Background processing with rate limiting (1 request/second)
   - Cached location data (city, country) in database
   - Bottom-left overlay displays date and location
   - Automatic "City of" prefix removal

3. **"This Day in History" Mode**
   - New order option showing photos from today's date across all years
   - Dynamic filtering using SQL date functions
   - Special counter display showing filtered count

4. **Delete Functionality Update**
   - Changed from soft delete to physical file move
   - Deleted files moved to `data/deleted` folder
   - Files remain recoverable but removed from slideshow
   - Database entries completely removed (not just flagged)

5. **UI Improvements**
   - Live clock display in top right corner (12-hour format)
   - Removed image counter overlay for cleaner interface
   - Date displays even when location is unavailable
   - Control overlay hides after 5 seconds of inactivity

6. **Database Management**
   - Added database reset button in settings (danger zone)
   - Orphaned entry cleanup on indexing
   - File watcher handles physical deletions
   - Support for rotation state tracking

7. **macOS Testing Support**
   - Created `launch-kiosk-macos.sh` for testing
   - Full compatibility with macOS development
   - Updated dependencies for Node.js v24


