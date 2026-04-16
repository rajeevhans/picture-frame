# Raspberry Pi Digital Picture Frame

A complete, production-ready digital picture frame application designed for Raspberry Pi, capable of handling 200,000+ photos with intelligent indexing, real-time file monitoring, and web-based remote control.

## Features

### Core Functionality
- **Intelligent Slideshow Engine** with three selection modes:
  - **Sequential**: Linear progression by date or filename
  - **Random**: True random selection
  - **Smart**: Weighted selection favoring favorites (3x), recent photos (2x), and "this day in history" (10x) — weights multiply, so a favorite from this day = 30x
- **Server-Authoritative Slideshow**: Timer runs server-side with all connected clients kept in sync via Server-Sent Events (SSE)
- **Real-time File Monitoring**: Automatically detects and indexes new, modified, or deleted photos
- **Web-based Control Interface**: Control slideshow from any device on your network
- **Remote Control UI**: Dedicated mobile-friendly remote at `/remote`
- **Auto-start System**: Boots directly into fullscreen slideshow mode

### Photo Management
- **4K Resize Pipeline**: Images are resized to 4K (3840x2160) on ingest, with originals deleted after successful resize. Resized files stored in `{photoDir}/resized/{year}/`
- **Favorites System**: Mark and filter favorite photos with visual indicators
- **Delete with Undo**: 5-second undo window before deletion. Files are moved to `data/deleted/` for recovery, then removed from the database
- **Download Images**: Download current image to your device
- **Physical Image Rotation**: Permanently rotate images 90° left or right via Sharp, with automatic backup/restore on failure
- **Metadata Display**: View EXIF data, GPS coordinates, camera info, and more
- **Geolocation**: Automatic background reverse geocoding displays city and country for GPS-tagged photos

### Advanced Features
- **"This Day in History"**: Show photos from today's date across all years
- **Dynamic Matting Background**: Background color/gradient extracted from the image's dominant colors using canvas-based k-means clustering
- **Clock Display**: Always-visible clock on the main display
- **Live Statistics**: Real-time database stats and photo counts
- **Keyboard Shortcuts**: Full keyboard control for navigation and management
- **Image Preloading**: Configurable number of images preloaded (default 15)
- **Performance Optimized**: Handles 200k+ images with indexed SQLite database
- **Config Override**: Per-user config at `~/picframe-config.json` deep-merged over project `config.json`

## Technology Stack

- **Backend**: Node.js with Express.js
- **Database**: SQLite3 with better-sqlite3 (WAL mode, 64MB cache)
- **Image Processing**: Sharp v0.34.5 for resize and rotation
- **Metadata Extraction**: exifreader v4.16.0 for EXIF data
- **File Monitoring**: chokidar v3.5.3 for real-time file watching
- **Frontend**: Vanilla JavaScript with responsive CSS
- **Display**: Electron app (preferred) or Chromium browser in kiosk mode
- **Geolocation**: OpenStreetMap Nominatim API (free, no API key required)

## Requirements

### Hardware
- Raspberry Pi 3B+ or newer (Pi 4 recommended for 4K displays)
- 4K TV or monitor with HDMI input
- Network connection (for initial setup and remote control)
- Storage for photos (SSD or fast USB drive recommended for large collections)

### Software
- Raspberry Pi OS (Debian-based) or macOS
- Node.js 16 or newer
- Chromium browser (for kiosk mode) or Electron (for app mode)
- Optional: `libheif` for HEIC/HEIF support (`brew install libheif` on macOS, `sudo apt-get install libheif-dev` on Linux)

## Quick Installation

### Automated Installation (Recommended)

1. **Copy project to Raspberry Pi:**
   ```bash
   # From your computer, copy to Pi
   scp -r picture-frame pi@raspberrypi.local:/home/pi/

   # Or clone directly on Pi
   git clone <repository-url> /home/pi/picture-frame
   cd /home/pi/picture-frame
   ```

2. **Run the installation script:**
   ```bash
   chmod +x install.sh
   ./install.sh
   ```

   The script will:
   - Install Node.js and Chromium if needed
   - Install npm dependencies
   - Configure your photo directory
   - Set up systemd services for auto-start
   - Optionally disable screen blanking

3. **Add your photos:**
   ```bash
   # Copy photos to the configured directory
   cp -r /path/to/your/photos/* /home/pi/Pictures/
   ```

4. **Reboot to start slideshow:**
   ```bash
   sudo reboot
   ```

### Manual Installation

1. **Install dependencies:**
   ```bash
   # Install Node.js
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # Install Chromium
   sudo apt-get install -y chromium-browser unclutter x11-xserver-utils
   ```

2. **Install project:**
   ```bash
   cd /home/pi/picture-frame
   npm install
   ```

3. **Configure photo directory:**
   Edit `config.json` and set `photoDirectory` to your photos location:
   ```json
   {
     "photoDirectory": "/home/pi/Pictures",
     "databasePath": "./data/pictureframe.db",
     "serverPort": 3000
   }
   ```

4. **Run initial indexing:**
   ```bash
   npm run index
   ```

5. **Set up auto-start services:**
   ```bash
   # Copy and enable systemd services
   sudo cp systemd/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable pictureframe.service
   sudo systemctl enable pictureframe-display.service
   ```

## Usage

### Web Interface

- **Main display** at `http://[HOST]:3000` — fullscreen slideshow for the frame itself
- **Remote control** at `http://[HOST]:3000/remote` — mobile-friendly control panel

Both UIs receive real-time updates via SSE. The slideshow timer is server-authoritative — all clients stay in sync.

#### Keyboard Shortcuts (Main Display)

- **Arrow Keys**: Navigate previous/next image
- **Space**: Play/pause slideshow
- **F**: Toggle favorite status
- **D**: Delete image (moves to data/deleted/ folder)
- **U**: Undo delete (within 5-second window)
- **Ctrl+Z / Cmd+Z**: Undo delete (within 5-second window)
- **[ / ]**: Rotate image left/right 90°
- **Ctrl+S / Cmd+S**: Download current image
- **I**: Toggle info overlay (shows metadata)
- **S**: Open/close settings panel
- **Escape**: Close panels/overlays

### Settings Panel
- **Mode**: Sequential, Random, or Smart selection
- **Order**: Date taken, filename, or "This Day in History"
- **Interval**: 5 seconds to 5 minutes between images
- **Filters**: Show favorites only
- **System**: Restart server, reset database

### Service Management

```bash
# Control the slideshow service
sudo systemctl start pictureframe      # Start
sudo systemctl stop pictureframe       # Stop
sudo systemctl restart pictureframe    # Restart
sudo systemctl status pictureframe     # Check status

# Control the display service
sudo systemctl start pictureframe-display
sudo systemctl stop pictureframe-display

# View logs
sudo journalctl -u pictureframe.service -f
sudo journalctl -u pictureframe-display.service -f
```

## Configuration

### config.json Options

```json
{
  "photoDirectory": "/path/to/your/photos",
  "databasePath": "./data/pictureframe.db",
  "serverPort": 3000,
  "slideshow": {
    "defaultInterval": 10,
    "defaultMode": "sequential",
    "defaultOrder": "date",
    "numberOfImagesToPreload": 15
  },
  "fileExtensions": [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"],
  "indexing": {
    "batchSize": 100
  },
  "watcher": {
    "usePolling": false
  },
  "resize": {
    "maxWidth": 3840,
    "maxHeight": 2160,
    "runOnStartup": true
  }
}
```

### Config Override

Create `~/picframe-config.json` with any subset of options to override the project defaults. Partial overrides work via deep merge — you only need to include the fields you want to change.

### Slideshow Modes

1. **Sequential**:
   - Linear progression through photos
   - Ordered by date taken or filename
   - Consistent, predictable viewing

2. **Random**:
   - True random selection
   - Each image has equal probability
   - Unpredictable variety

3. **Smart**:
   - Weighted random selection
   - Favorites: 3x more likely
   - Recent photos (within last month): 2x more likely
   - Photos from "this day in history": 10x more likely
   - Weights are multiplicative (a favorite from this day = 30x)
   - Weight cache refreshes every 5 seconds

### File Organization

```
picture-frame/
├── src/                    # Source code
│   ├── server.js          # Main server entry point
│   ├── config.js          # Config loading with user override merge
│   ├── database/          # Database management and schema
│   ├── indexer/           # File scanning, metadata extraction, resize pipeline
│   ├── slideshow/         # Slideshow engine (modes, navigation, preload)
│   ├── services/          # Geolocation, image rotation services
│   ├── routes/            # API endpoints (images, settings)
│   └── public/            # Web interface files
│       ├── index.html     # Main fullscreen display
│       ├── js/app.js      # Display app (crossfade, matting, keyboard)
│       ├── css/style.css  # Display styles
│       └── remote/        # Mobile remote control UI
├── scripts/               # Utility scripts
│   ├── resizeTo4k.js     # Batch resize images to 4K
│   └── benchmark.js      # Performance benchmarking
├── data/                  # Database and deleted files
│   ├── pictureframe.db   # SQLite database
│   └── deleted/          # Deleted photos (recoverable)
├── electron/              # Electron app wrapper
│   ├── main.js           # Electron main process
│   └── preload.js        # Preload script
├── systemd/               # Auto-start service files
├── config.json            # Default configuration
└── install.sh             # Installation script
```

## Development

### Running in Development Mode

```bash
npm start                  # Start server (auto-indexes if DB is empty)
npm run dev                # Start with development logging (allows missing photo dir)
npm run index              # Force re-index all photos, then exit
npm run resize             # Resize all non-resized images to 4K
npm run benchmark          # Run performance benchmarks
npm run electron           # Launch Electron app (spawns its own server)
npm run electron:external  # Launch Electron connecting to already-running server
```

### Electron App

The Electron wrapper spawns the Node server as a child process, waits for the `/api/health` endpoint to respond, then opens a fullscreen BrowserWindow. Environment variables:

- `ELECTRON_USE_EXTERNAL_SERVER=1` — Connect to existing server instead of spawning one
- `ELECTRON_KIOSK=0` — Disable kiosk mode (for debugging)
- `PICTUREFRAME_URL` — Override server URL (default: `http://localhost:3000`)
- `ELECTRON_NODE_BINARY` — Override Node binary path

### API Endpoints

The application provides a REST API for remote control:

```bash
# Navigation
GET  /api/image/current        # Get current image with preload list
GET  /api/image/next           # Advance to next image
GET  /api/image/previous       # Go to previous image

# Image management
POST   /api/image/:id/favorite     # Toggle favorite status
POST   /api/image/:id/rotate-left  # Physically rotate image 90° counter-clockwise
POST   /api/image/:id/rotate-right # Physically rotate image 90° clockwise
GET    /api/image/:id/download     # Download image file
DELETE /api/image/:id              # Delete image (move to data/deleted/, remove from DB)

# Slideshow control
GET  /api/slideshow/state      # Get play/pause state and interval
POST /api/slideshow/start      # Start slideshow
POST /api/slideshow/pause      # Pause slideshow

# Settings
GET  /api/settings             # Get slideshow settings
POST /api/settings             # Update settings

# System
GET  /api/stats                # Database statistics
POST /api/database/reset       # Reset database and re-index all photos
GET  /api/health               # Health check
POST /api/settings/restart     # Restart server process

# Real-time updates
GET  /api/events               # Server-Sent Events stream
```

### Database Schema

The SQLite database stores comprehensive metadata:

```sql
-- Images table with full metadata
CREATE TABLE images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    file_modified INTEGER NOT NULL,
    date_taken TEXT,
    date_added INTEGER NOT NULL,
    latitude REAL,
    longitude REAL,
    location_city TEXT,
    location_country TEXT,
    width INTEGER,
    height INTEGER,
    orientation INTEGER DEFAULT 1,
    rotation INTEGER DEFAULT 0,
    camera_model TEXT,
    camera_make TEXT,
    is_favorite INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    tags TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Settings table (key-value store)
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
```

## 4K Resize Pipeline

When images are indexed (initial scan or file watcher pickup), they go through the resize pipeline:

1. **Metadata extraction**: EXIF data read from original file
2. **Resize**: Sharp resizes to fit within 3840x2160 (`fit: inside`, no enlargement), auto-rotating based on EXIF orientation
3. **Output**: Resized file written to `{photoDir}/resized/{year}/{basename}_{hash}{ext}` — the hash prevents filename collisions
4. **Database**: Resized file path stored in DB (not original path)
5. **Cleanup**: Original file deleted after successful DB insert

HEIF/HEIC files are converted to JPEG during resize. If Sharp can't handle the HEIF format, `heif-convert` CLI is used as fallback.

The `npm run resize` command can retroactively resize images already in the database that aren't yet in `resized/`. The resize also runs on server startup when `resize.runOnStartup` is `true` in config.

## Geolocation

The system automatically processes GPS coordinates from photo EXIF data:

- **Reverse Geocoding**: Converts GPS coordinates to city and country names via OpenStreetMap Nominatim
- **Rate Limited**: 1 request per second to respect API limits
- **Background Processing**: Runs in batches of 100 after server startup, with 10-second pauses between batches
- **Cached Results**: In-memory cache (keyed by coordinates rounded to 4 decimal places) and stored in database
- **Visual Display**: Shows date and location on bottom-left overlay of main display

## "This Day in History" Mode

Special slideshow order that shows photos from today's date across all years:

- **Dynamic Filtering**: Uses `substr(date_taken, 6, 5)` to match month and day
- **Cross-Year**: Shows photos from the same date in previous years
- **Smart Integration**: In Smart mode, "this day" photos get 10x weight boost
- **Selectable**: Choose "This Day in History" in the Order dropdown of settings

## Performance

### Indexing Performance
- **Speed**: ~10 seconds per 1,000 images (includes resize)
- **Large Collections**: 200,000 images indexed in ~30-40 minutes
- **Memory Efficient**: Batch processing (configurable batch size, default 100)
- **Smart Updates**: Only processes changed files on re-indexing (compares file modification time)

### Runtime Performance
- **Database**: 6 indexes for fast queries (date_taken, date_added, is_favorite, is_deleted, filename, filepath)
- **Caching**: HTTP caching headers with ETag for served images (24-hour max-age)
- **Preloading**: Configurable number of images preloaded (default 15)
- **Optimized**: WAL mode SQLite with 64MB cache for better concurrency
- **Smart Weights**: Cached for 5 seconds to avoid recalculation every advance

## Security & Privacy

- **Local Network Only**: No external authentication required
- **Recoverable Delete**: Files moved to `data/deleted/` folder, not permanently deleted
- **Read-Only Serving**: Image files served with proper caching headers
- **Rate Limited**: Geolocation API calls limited to 1/second
- **Sandboxed**: Electron runs with context isolation, no node integration in renderer

## Troubleshooting

### Common Issues

1. **Service won't start:**
   ```bash
   # Check service status
   sudo systemctl status pictureframe.service

   # View detailed logs
   sudo journalctl -u pictureframe.service -n 50
   ```

2. **Display not showing:**
   ```bash
   # Check display service
   sudo systemctl status pictureframe-display.service

   # Ensure X11 is running
   echo $DISPLAY
   ```

3. **Photos not appearing:**
   ```bash
   # Force re-indexing
   npm run index

   # Check photo directory in config.json
   cat config.json | grep photoDirectory
   ```

4. **HEIF/HEIC images not working:**
   ```bash
   # macOS
   brew install libheif

   # Linux
   sudo apt-get install libheif-dev libde265-dev libx265-dev
   ```

5. **Slow performance:**
   ```bash
   # Run benchmarks
   npm run benchmark

   # Check database size
   ls -lh data/pictureframe.db
   ```

### Log Locations

- **Service logs**: `sudo journalctl -u pictureframe.service`
- **Display logs**: `sudo journalctl -u pictureframe-display.service`
- **Application logs**: Console output in service logs

## Additional Documentation

- **PROJECT_SUMMARY.md**: Technical implementation details
- **QUICKSTART.md**: Quick start guide for development
- **PERFORMANCE_AUDIT.md**: Performance benchmarks and optimization notes
- **4K_RESIZE_PLAN.md**: Design document for the resize pipeline

## License

MIT License - Feel free to use, modify, and distribute.

## Acknowledgments

- **OpenStreetMap Nominatim**: Free reverse geocoding API
- **Sharp**: High-performance image processing
- **better-sqlite3**: Fast SQLite3 bindings for Node.js
- **exifreader**: Comprehensive EXIF metadata extraction
- **chokidar**: Cross-platform file watching
