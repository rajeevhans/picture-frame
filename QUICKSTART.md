# Quick Start Guide

## For Development/Testing (Mac/Linux/Windows)

1. **Install dependencies:**
   ```bash
   cd picture-frame
   npm install
   ```

2. **Configure photo directory:**
   Edit `config.json` and set `photoDirectory` to a folder with some test images:
   ```json
   {
     "photoDirectory": "/Users/yourname/Pictures",
     ...
   }
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Open in browser:**
   Navigate to `http://localhost:3000`

5. **Test the interface:**
   - Move mouse to see controls
   - Use arrow keys to navigate
   - Press Space to play/pause
   - Press 'S' to open settings
   - Press 'I' to see image info

## For Raspberry Pi Deployment

### Prerequisites
- Raspberry Pi 3B+ or newer
- Raspberry Pi OS with desktop environment
- 4K TV connected via HDMI
- Network connection (for initial setup)

### Installation Steps

1. **Copy project to Raspberry Pi:**
   ```bash
   # From your computer
   scp -r picture-frame pi@raspberrypi.local:/home/pi/
   
   # Or use USB drive, then on Pi:
   # cp -r /media/usb/picture-frame /home/pi/
   ```

2. **SSH into Raspberry Pi:**
   ```bash
   ssh pi@raspberrypi.local
   ```

3. **Navigate to project:**
   ```bash
   cd /home/pi/picture-frame
   ```

4. **Run installation script:**
   ```bash
   ./install.sh
   ```
   
   The script will:
   - Check and install Node.js if needed
   - Install Chromium browser if needed
   - Ask for your photo directory location
   - Install npm packages
   - Set up systemd services for auto-start
   - Optionally disable screen blanking

5. **Add your photos:**
   Copy your photos to the directory you specified (e.g., `/home/pi/Pictures`)

6. **Run initial indexing:**
   ```bash
   npm run index
   ```
   
   This will scan all photos and build the database. For 200k photos, this may take 30-40 minutes.

7. **Reboot:**
   ```bash
   sudo reboot
   ```

8. **Done!**
   After reboot, the picture frame will automatically start in fullscreen mode.

### Accessing from Another Device

Once running, you can access the web interface from any device on the same network:

```
http://raspberrypi.local:3000
or
http://192.168.1.xxx:3000
```

Replace `192.168.1.xxx` with your Pi's IP address (find it with `hostname -I`)

## Configuration Options

### Slideshow Settings (via Web UI)
- **Mode:** Sequential, Random, or Smart
- **Order:** By Date or Filename (for sequential mode)
- **Interval:** 5s, 10s, 15s, 30s, 1min, 5min
- **Filter:** Show all or favorites only

### Advanced Configuration (config.json)

```json
{
  "photoDirectory": "/home/pi/Pictures",      // Your photos location
  "databasePath": "./data/pictureframe.db",   // Database location
  "serverPort": 3000,                         // Web server port
  "slideshow": {
    "defaultInterval": 10,                    // Default seconds between images
    "defaultMode": "sequential",              // sequential, random, or smart
    "defaultOrder": "date"                    // date or filename
  },
  "fileExtensions": [                         // Supported image formats
    ".jpg", ".jpeg", ".png", ".gif", 
    ".webp", ".heic", ".heif"
  ],
  "indexing": {
    "batchSize": 100,                         // Images per batch during indexing
    "logInterval": 500                        // Progress log frequency
  }
}
```

After changing `config.json`, restart the service:
```bash
sudo systemctl restart pictureframe
```

## Keyboard Controls

| Key | Action |
|-----|--------|
| ← | Previous image |
| → | Next image |
| Space | Play/Pause slideshow |
| F | Toggle favorite |
| D | Delete image |
| I | Toggle info overlay |
| S | Open/Close settings |
| Esc | Close overlays |

## Troubleshooting

### Service not starting
```bash
# Check service status
sudo systemctl status pictureframe

# View logs
sudo journalctl -u pictureframe -n 50
```

### Display not showing
```bash
# Check display service
sudo systemctl status pictureframe-display

# Restart display
sudo systemctl restart pictureframe-display
```

### No images showing
1. Check that photos exist in configured directory
2. Run indexing: `npm run index`
3. Check logs for errors
4. Verify file permissions

### Screen keeps blanking
```bash
# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Make permanent by adding to ~/.xinitrc or re-run install.sh
```

### Database issues
```bash
# Rebuild database
rm data/pictureframe.db
npm run index
```

## Updating

To update the application:

1. Stop services:
   ```bash
   sudo systemctl stop pictureframe pictureframe-display
   ```

2. Update files (copy new version)

3. Update dependencies:
   ```bash
   npm install
   ```

4. Start services:
   ```bash
   sudo systemctl start pictureframe pictureframe-display
   ```

## Uninstalling

```bash
# Stop and disable services
sudo systemctl stop pictureframe pictureframe-display
sudo systemctl disable pictureframe pictureframe-display

# Remove service files
sudo rm /etc/systemd/system/pictureframe.service
sudo rm /etc/systemd/system/pictureframe-display.service
sudo systemctl daemon-reload

# Remove application
rm -rf /home/pi/picture-frame
```

## Performance Tips

1. **For 200k+ images:**
   - Use an SSD or fast USB drive for photo storage
   - Consider using microSD card class 10 or better
   - Initial indexing will take time - be patient!

2. **For 4K display:**
   - Ensure Raspberry Pi 4 for best performance
   - Use quality HDMI cable
   - Configure GPU memory: `sudo raspi-config` → Performance → GPU Memory → 256MB

3. **Network access:**
   - Use wired Ethernet for better reliability
   - WiFi is fine for control interface access

## Getting Help

Check these files for more information:
- `README.md` - Full documentation
- `PROJECT_SUMMARY.md` - Technical details
- Logs: `sudo journalctl -u pictureframe -f`

---

**Enjoy your digital picture frame!** 📸


