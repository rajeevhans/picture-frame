# Raspberry Pi Digital Picture Frame

A digital picture frame application for Raspberry Pi (and macOS via Electron), capable of handling 200,000+ photos with intelligent indexing, real-time file monitoring, and web-based remote control.

## Features

### Slideshow Engine
- **Sequential**: Linear progression by date taken, filename, or "this day in history"
- **Random**: True random selection
- **Smart**: Weighted random favoring favorites (3x), recent photos (2x), and "this day in history" (10x)
- **Server-authoritative timer**: All connected clients stay in sync via Server-Sent Events
- **Back/forward navigation history**: Reliable previous/next even in random modes
- **Configurable preloading**: Next 15 images preloaded by default for smooth transitions

### Photo Management
- **Favorites**: Mark and filter favorite photos
- **Soft delete**: Moves to `data/deleted/` with 5-second undo window
- **Physical image rotation**: Lossless 90° rotation with backup/restore on failure
- **Download**: Download current image (HEIF auto-converted to JPEG)
- **Custom SQL filtering**: Filter images with user-provided queries (validated against injection)

### Image Processing
- **4K resize pipeline**: Background downscaling to 3840x2160 max via Sharp, preserving EXIF metadata
- **HEIF/HEIC support**: On-the-fly conversion to JPEG with `heif-convert` fallback when Sharp can't handle certain compression formats
- **Auto-orientation**: EXIF orientation applied during resize
- **Resized output**: Stored in `{photoDir}/resized/{year}/` with hash-based naming

### Metadata & Geolocation
- **EXIF extraction**: Date taken, dimensions, orientation, camera make/model, GPS coordinates
- **Auto-tagging**: year, month, geotagged, camera model, file type
- **Reverse geocoding**: Background batch lookup via OpenStreetMap Nominatim (rate-limited, cached in DB)
- **Location overlay**: City and country displayed on the slideshow

### Frontend
- **Single-page web UI** at `/` with fullscreen slideshow display
- **Remote control interface** at `/remote/`
- **Dynamic matting background**: Extracts dominant colors from current image with paper texture overlay
- **Info overlay**: Filename, date, location, camera, resolution, tags
- **Keyboard shortcuts**: Space (play/pause), arrows (nav), F (favorite), D (delete), U/Ctrl+Z (undo), [ ] (rotate), I (info), S (settings), Ctrl+S (download), Escape (close panels)
- **Touch-aware**: Controls shown on touch for kiosk mode
- **Auto-hiding controls**: Mouse-triggered, hide after 5 seconds

### Electron Desktop App
- Fullscreen kiosk mode (configurable via `ELECTRON_KIOSK` env var)
- Embedded server or connect to external server (`ELECTRON_USE_EXTERNAL_SERVER=1`)
- Triggers 4K resize on startup
- Health-check waits up to 20 seconds for server readiness
- Graceful shutdown with SIGTERM -> SIGKILL fallback

### Debug Logging
- Structured logger writing to `data/debug.log` when `debug.enabled` is true in config
- Logs server events, watcher activity, indexing, settings changes, and errors

## Technology Stack

- **Backend**: Node.js + Express.js
- **Database**: SQLite3 via better-sqlite3 (WAL mode, 64MB cache)
- **Image Processing**: Sharp v0.34.5
- **Metadata**: exifreader v4.16.0
- **File Watching**: chokidar v3.5.3
- **Frontend**: Vanilla JavaScript, CSS
- **Desktop**: Electron v40.6.1
- **Geolocation**: OpenStreetMap Nominatim API (free, no key required)

## Requirements

### Hardware
- Raspberry Pi 3B+ or newer (Pi 4 recommended for 4K)
- Display with HDMI input
- Network connection
- Storage for photos (SSD or fast USB recommended for large collections)

### Software
- Raspberry Pi OS (or macOS for development/desktop use)
- Node.js 16+
- Chromium (for kiosk mode) or Electron

## Quick Start

### Automated (Raspberry Pi)

```bash
git clone https://github.com/rajeevhans/picture-frame.git
cd picture-frame
chmod +x install.sh
./install.sh
```

The script installs Node.js/Chromium, npm dependencies, configures your photo directory, and sets up systemd services.

### Manual

```bash
npm install
```

Edit `config.json` (or create `~/picframe-config.json` for user overrides):
```json
{
  "photoDirectory": "/path/to/your/photos"
}
```

```bash
npm run index    # Initial indexing (then exits)
npm start        # Start server
```

## Configuration

Default config lives in `config.json`. Create `~/picframe-config.json` to override any subset of values (deep-merged over defaults).

```json
{
  "photoDirectory": "/path/to/photos",
  "databasePath": "./data/pictureframe.db",
  "debug": { "enabled": false },
  "serverPort": 3000,
  "slideshow": {
    "defaultInterval": 10,
    "defaultMode": "sequential",
    "defaultOrder": "date",
    "numberOfImagesToPreload": 15
  },
  "fileExtensions": [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"],
  "indexing": {
    "batchSize": 100,
    "logInterval": 500
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

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the server |
| `npm run dev` | Start in dev mode (allows missing photo directory) |
| `npm run index` | Force re-index all photos, then exit |
| `npm run resize` | Batch resize images to 4K max |
| `npm run benchmark` | Run performance benchmarks |
| `npm run electron` | Run as Electron desktop app |
| `npm run electron:external` | Electron connecting to external server |

## API

```
# Navigation
GET  /api/image/current         Current image + preload list
GET  /api/image/next            Advance slideshow
GET  /api/image/previous        Go back

# Image operations
GET  /api/image/:id/serve       Serve image file (with HEIF conversion, caching)
GET  /api/image/:id/download    Download image
POST /api/image/:id/favorite    Toggle favorite
POST /api/image/:id/rotate-left   Rotate 90° CCW
POST /api/image/:id/rotate-right  Rotate 90° CW
DELETE /api/image/:id           Soft delete

# Listing
GET  /api/image?page=&limit=&favorites=&orderBy=   Paginated image list

# Slideshow control
GET  /api/slideshow/state       Play state and interval
POST /api/slideshow/start       Start slideshow timer
POST /api/slideshow/pause       Pause slideshow timer

# Settings
GET  /api/settings              Current settings
POST /api/settings              Update settings (mode, order, interval, favoritesOnly, filterSql)
GET  /api/settings/stats        Database statistics
POST /api/settings/restart      Restart server process

# System
GET  /api/events                SSE stream (real-time updates)
GET  /api/stats                 Database stats
GET  /api/health                Health check
POST /api/database/reset        Drop and re-index everything
```

## Service Management (Raspberry Pi)

```bash
sudo systemctl start|stop|restart|status pictureframe
sudo systemctl start|stop pictureframe-display
sudo journalctl -u pictureframe.service -f
```

## Additional Documentation

- [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) — Technical implementation details
- [QUICKSTART.md](QUICKSTART.md) — Quick start guide
- [4K_RESIZE_PLAN.md](4K_RESIZE_PLAN.md) — 4K resize pipeline design
- [ROTATION_FEATURE.md](ROTATION_FEATURE.md) — Physical image rotation
- [GEOLOCATION_FEATURE.md](GEOLOCATION_FEATURE.md) — GPS and location features
- [THIS_DAY_FEATURE.md](THIS_DAY_FEATURE.md) — "This day in history" implementation
- [DATABASE_RESET_FEATURE.md](DATABASE_RESET_FEATURE.md) — Database management
- [FILE_DELETION_HANDLING.md](FILE_DELETION_HANDLING.md) — Soft delete implementation
- [DOWNLOAD_FEATURE.md](DOWNLOAD_FEATURE.md) — Image download feature
- [PERFORMANCE_AUDIT.md](PERFORMANCE_AUDIT.md) — Performance audit results

## License

MIT
