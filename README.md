# Raspberry Pi Digital Picture Frame

A full-featured digital picture frame application designed for Raspberry Pi, capable of handling 200,000+ photos with metadata indexing, automatic file monitoring, and web-based controls.

## Features

- **Lightweight SQLite Database**: Indexes photo metadata including EXIF data, GPS location, date taken, and custom tags
- **Automatic File Monitoring**: Watches photo directory and re-indexes when files are added, changed, or removed
- **Web-Based Control Interface**: Control slideshow from any device on your network
- **Multiple Slideshow Modes**:
  - Sequential (by date or filename)
  - Random selection
  - Smart selection (weighted towards favorites and recent photos)
- **Photo Management**: Mark favorites, soft-delete photos, view metadata
- **Auto-Start**: Configured to start automatically on Raspberry Pi boot in fullscreen kiosk mode
- **Performance Optimized**: Handles 200k+ images efficiently with indexed database queries

## Requirements

- Raspberry Pi (3B+ or newer recommended)
- Node.js 16+ 
- Chromium browser (for kiosk mode)
- Raspberry Pi OS (Debian-based)

## Installation

### Quick Install on Raspberry Pi

1. Install Node.js if not already installed:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

2. Install Chromium:
```bash
sudo apt-get install -y chromium-browser unclutter
```

3. Copy the project to Raspberry Pi:
```bash
sudo mkdir -p /opt/pictureframe
sudo chown $USER:$USER /opt/pictureframe
cd /opt/pictureframe
# Copy all files here
```

4. Install dependencies:
```bash
npm install
```

5. Configure photo directory:
Edit `config.json` and set `photoDirectory` to your photos location.

6. Run initial indexing:
```bash
npm run index
```

7. Install systemd services:
```bash
sudo ./install.sh
```

8. Access the web interface at `http://raspberrypi.local:3000` or `http://<pi-ip>:3000`

## Manual Setup (Development)

```bash
cd picture-frame
npm install
npm start
```

Open browser to `http://localhost:3000`

## Electron App (Alternative to Kiosk Browser)

You can run the same UI inside an Electron fullscreen window instead of launching Chromium in kiosk mode.

### How it works
- Electron starts your existing server (`src/server.js`) as a child process (unless you opt out)
- Waits for `GET /api/health`
- Opens a fullscreen/kiosk Electron window pointed at `http://localhost:3000`

### Run

```bash
npm run electron
```

### Use an external server (advanced)
If you already have the server running separately (`npm start`), run:

```bash
npm run electron:external
```

### Environment variables
- `PICTUREFRAME_URL`: defaults to `http://localhost:3000`
- `ELECTRON_USE_EXTERNAL_SERVER=1`: do not spawn `src/server.js`
- `ELECTRON_KIOSK=0`: disable kiosk mode (still fullscreen)
- `ELECTRON_NODE_BINARY`: defaults to `node` (only used when spawning the server)

## Configuration

Edit `config.json`:

- `photoDirectory`: Path to your photos folder
- `serverPort`: Web server port (default: 3000)
- `slideshow.defaultInterval`: Default seconds between photos
- `slideshow.defaultMode`: "sequential", "random", or "smart"
- `slideshow.defaultOrder`: "date" or "filename" (for sequential mode)
- `fileExtensions`: Image file types to index

## Usage

### Web Interface Controls

- **Arrow Keys / Buttons**: Navigate between photos
- **Spacebar**: Play/Pause slideshow
- **F Key**: Toggle favorite
- **D Key**: Delete photo (soft delete)
- **I Key**: Toggle info overlay
- **S Key**: Open settings panel

### API Endpoints

- `GET /api/image/current` - Current slideshow image
- `GET /api/image/next` - Next image
- `GET /api/image/previous` - Previous image
- `POST /api/image/:id/favorite` - Toggle favorite
- `DELETE /api/image/:id` - Soft delete image
- `GET /api/settings` - Get slideshow settings
- `POST /api/settings` - Update settings
- `GET /api/stats` - Database statistics

## Systemd Services

Two services are installed:

1. **pictureframe.service**: Node.js backend server
2. **pictureframe-display.service**: Chromium in kiosk mode

Control with:
```bash
sudo systemctl start pictureframe
sudo systemctl stop pictureframe
sudo systemctl restart pictureframe
sudo systemctl status pictureframe
```

## Troubleshooting

**Indexing is slow**: Initial indexing of 200k images may take time. Monitor progress in the console.

**Images not updating**: Check file watcher is running. Restart the service if needed.

**Cannot connect to web interface**: Verify the service is running with `systemctl status pictureframe`

**Display issues**: Check Chromium kiosk service with `systemctl status pictureframe-display`

## License

MIT


