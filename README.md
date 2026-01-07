# Raspberry Pi Digital Picture Frame

A complete, production-ready digital picture frame application designed for Raspberry Pi, capable of handling 200,000+ photos with intelligent indexing, real-time file monitoring, and web-based remote control.

## 🖼️ Features

### Core Functionality
- **Intelligent Slideshow Engine** with three selection modes:
  - **Sequential**: Linear progression by date or filename
  - **Random**: True random selection
  - **Smart**: Weighted selection favoring favorites, recent photos, and "this day in history"
- **Real-time File Monitoring**: Automatically detects and indexes new, modified, or deleted photos
- **Web-based Control Interface**: Control slideshow from any device on your network
- **Auto-start System**: Boots directly into fullscreen slideshow mode

### Photo Management
- **Favorites System**: Mark and filter favorite photos with visual indicators
- **Soft Delete**: Move unwanted photos to recoverable deleted folder
- **Download Images**: Download current image to your device with one click
- **Physical Image Rotation**: Permanently rotate images 90°, 180°, or 270°
- **Metadata Display**: View EXIF data, GPS coordinates, camera info, and more
- **Geolocation**: Automatic reverse geocoding displays city and country for GPS-tagged photos

### Advanced Features
- **"This Day in History"**: Show photos from today's date across all years
- **Live Statistics**: Real-time database stats and photo counts
- **Keyboard Shortcuts**: Full keyboard control for navigation and management
- **Image Preloading**: Smooth transitions with next 3 images preloaded
- **Performance Optimized**: Handles 200k+ images with indexed SQLite database

## 🛠️ Technology Stack

- **Backend**: Node.js with Express.js
- **Database**: SQLite3 with better-sqlite3 (optimized for performance)
- **Image Processing**: Sharp v0.33.0 for high-quality rotation
- **Metadata Extraction**: exifreader v4.16.0 for EXIF data
- **File Monitoring**: chokidar v3.5.3 for real-time file watching
- **Frontend**: Vanilla JavaScript with responsive CSS
- **Display**: Chromium browser in kiosk mode or Electron app
- **Geolocation**: OpenStreetMap Nominatim API (free, no API key required)

## 📋 Requirements

### Hardware
- Raspberry Pi 3B+ or newer (Pi 4 recommended for 4K displays)
- 4K TV or monitor with HDMI input
- Network connection (for initial setup and remote control)
- Storage for photos (SSD or fast USB drive recommended for large collections)

### Software
- Raspberry Pi OS (Debian-based)
- Node.js 16 or newer
- Chromium browser (for kiosk mode display)

## 🚀 Quick Installation

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

## 🎮 Usage

### Web Interface Controls

Access the web interface at `http://raspberrypi.local:3000` or `http://[PI_IP]:3000`

#### Mouse Controls
- **Move mouse**: Show/hide control overlay (auto-hides after 5 seconds)
- **Click buttons**: Navigate, play/pause, settings, etc.

#### Keyboard Shortcuts
- **Arrow Keys**: Navigate previous/next image
- **Space**: Play/pause slideshow
- **F**: Toggle favorite status
- **D**: Delete image (moves to data/deleted folder)
- **[ / ]**: Rotate image left/right 90°
- **Ctrl+S / Cmd+S**: Download current image
- **I**: Toggle info overlay (shows metadata)
- **S**: Open settings panel
- **Escape**: Close panels/overlays

### Settings Panel
- **Mode**: Sequential, Random, or Smart selection
- **Order**: Date taken, filename, or "This Day in History"
- **Interval**: 5 seconds to 5 minutes between images
- **Filters**: Show favorites only, etc.

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

## 📁 Configuration

### config.json Options

```json
{
  "photoDirectory": "/path/to/your/photos",
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
  },
  "watcher": {
    "debounceMs": 1000,
    "maxQueueSize": 100
  }
}
```

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
   - Recent photos (last month): 2x more likely
   - "This day in history": 10x more likely
   - Balances variety with preference

### File Organization

```
picture-frame/
├── src/                    # Source code
│   ├── server.js          # Main server
│   ├── database/          # Database management
│   ├── indexer/           # File scanning and monitoring
│   ├── slideshow/         # Slideshow engine
│   ├── services/          # Geolocation, rotation services
│   ├── routes/            # API endpoints
│   └── public/            # Web interface files
├── data/                  # Database and deleted files
│   ├── pictureframe.db    # SQLite database
│   └── deleted/           # Soft-deleted photos
├── systemd/               # Auto-start service files
├── electron/              # Electron app (alternative to Chromium)
├── config.json            # Configuration
└── install.sh             # Installation script
```

## 🔧 Development

### Running in Development Mode

```bash
# Start server only (no auto-indexing)
npm start

# Start with development logging
npm run dev

# Force re-indexing
npm run index

# Run in Electron (alternative to Chromium)
npm run electron
```

### API Endpoints

The application provides a REST API for remote control:

```bash
# Navigation
GET  /api/image/current     # Get current image
GET  /api/image/next        # Advance to next image
GET  /api/image/previous    # Go to previous image

# Image management
POST /api/image/:id/favorite    # Toggle favorite status
POST /api/image/:id/rotate-left # Rotate image 90° counter-clockwise
POST /api/image/:id/rotate-right # Rotate image 90° clockwise
GET  /api/image/:id/download    # Download image file
DELETE /api/image/:id           # Delete image (soft delete)

# Settings
GET  /api/settings          # Get slideshow settings
POST /api/settings          # Update settings

# System
GET  /api/stats             # Database statistics
POST /api/database/reset    # Reset database and re-index
GET  /api/health            # Health check

# Real-time updates
GET  /api/events            # Server-Sent Events stream
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
```

## 🌍 Geolocation Features

The system automatically processes GPS coordinates from photo EXIF data:

- **Reverse Geocoding**: Converts GPS coordinates to city and country names
- **Rate Limited**: 1 request per second to respect OpenStreetMap API limits
- **Background Processing**: Runs automatically after server startup
- **Cached Results**: Stores location data in database to avoid repeated lookups
- **Visual Display**: Shows location with pin emoji on bottom-left overlay

## 🔄 "This Day in History" Mode

Special slideshow mode that shows photos from today's date across all years:

- **Dynamic Filtering**: Uses SQL date functions to match month and day
- **Cross-Year**: Shows photos from the same date in previous years
- **Smart Integration**: Works with all slideshow modes (sequential, random, smart)
- **Visual Indicator**: Special counter shows filtered photo count
- **Memory Lane**: Perfect for reliving memories from past years

## 📊 Performance

### Indexing Performance
- **Speed**: ~10 seconds per 1,000 images
- **Large Collections**: 200,000 images indexed in ~30-40 minutes
- **Memory Efficient**: Batch processing prevents memory issues
- **Smart Updates**: Only processes changed files on re-indexing

### Runtime Performance
- **Database**: Indexed queries for fast image selection
- **Caching**: HTTP caching headers for served images
- **Preloading**: Next 3 images preloaded for smooth transitions
- **Optimized**: WAL mode SQLite for better concurrency

## 🛡️ Security & Privacy

- **Local Network Only**: No external authentication required
- **Soft Delete**: Files moved to recoverable folder, not permanently deleted
- **Read-Only Serving**: Image files served with proper caching headers
- **Rate Limited**: Geolocation API calls limited to prevent abuse
- **Sandboxed**: Chromium runs in kiosk mode with limited permissions

## 🐛 Troubleshooting

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

4. **Slow performance:**
   ```bash
   # Check database size
   ls -lh data/pictureframe.db
   
   # Monitor system resources
   htop
   ```

### Log Locations

- **Service logs**: `sudo journalctl -u pictureframe.service`
- **Display logs**: `sudo journalctl -u pictureframe-display.service`
- **Application logs**: Console output in service logs

## 📚 Additional Documentation

- **PROJECT_SUMMARY.md**: Technical implementation details
- **QUICKSTART.md**: Quick start guide for development
- **ROTATION_FEATURE.md**: Physical image rotation details
- **GEOLOCATION_FEATURE.md**: GPS and location features
- **THIS_DAY_FEATURE.md**: "This day in history" implementation
- **DATABASE_RESET_FEATURE.md**: Database management
- **FILE_DELETION_HANDLING.md**: Soft delete implementation

## 🤝 Contributing

This is a complete, production-ready application. All planned features have been implemented:

- ✅ Database indexing for 200k+ images
- ✅ Real-time file monitoring
- ✅ Web-based control interface
- ✅ Multiple slideshow modes
- ✅ Photo management features
- ✅ Physical image rotation
- ✅ Geolocation display
- ✅ "This day in history" mode
- ✅ Auto-start system
- ✅ Comprehensive documentation

## 📄 License

MIT License - Feel free to use, modify, and distribute.

## 🙏 Acknowledgments

- **OpenStreetMap Nominatim**: Free reverse geocoding API
- **Sharp**: High-performance image processing
- **better-sqlite3**: Fast SQLite3 bindings for Node.js
- **exifreader**: Comprehensive EXIF metadata extraction
- **chokidar**: Cross-platform file watching

---

**Transform your Raspberry Pi into an intelligent digital picture frame that brings your memories to life!**