# Testing Notes - Quick Reference

## Current Test Environment

- **Platform:** macOS
- **Node.js:** v24.10.0
- **Server:** Running on http://localhost:3000
- **Photos:** 75 images in `./test_photos`
- **Database:** `./data/pictureframe.db`

## Quick Commands

### Start the Server
```bash
npm start
```

### Force Re-index Photos
```bash
npm run index
```

### Test API Endpoints

#### Health Check
```bash
curl http://localhost:3000/api/health
```

#### Get Statistics
```bash
curl http://localhost:3000/api/stats
```

#### Get Current Image
```bash
curl http://localhost:3000/api/image/current
```

#### Navigate Images
```bash
curl http://localhost:3000/api/image/next
curl http://localhost:3000/api/image/previous
```

#### Toggle Favorite (replace :id with image ID)
```bash
curl -X POST http://localhost:3000/api/image/3/favorite
```

#### Soft Delete Image
```bash
curl -X DELETE http://localhost:3000/api/image/5
```

#### Update Settings
```bash
# Switch to random mode
curl -X POST http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"mode":"random","interval":10}'

# Switch to sequential mode by date
curl -X POST http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"mode":"sequential","order":"date"}'

# Enable favorites only
curl -X POST http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"favoritesOnly":true}'
```

## Browser Access

Open in your browser:
```
http://localhost:3000
```

### Keyboard Shortcuts
- **Space:** Play/Pause slideshow
- **Left/Right Arrows:** Navigate images
- **F:** Toggle favorite
- **D:** Delete image (with confirmation)
- **I:** Toggle info overlay
- **S:** Open settings panel
- **Escape:** Close panels

## Test Results

✅ **All tests passed successfully!**

### What's Working
- ✅ Database initialization and indexing
- ✅ EXIF metadata extraction (date, GPS, camera)
- ✅ File system watcher (auto-detects new/removed photos)
- ✅ All API endpoints
- ✅ Slideshow modes (sequential, random, smart)
- ✅ Favorites and delete functionality
- ✅ Web interface and controls
- ✅ Image serving with HTTP caching

### Known Issues
- None found during testing

### Not Tested Yet (Raspberry Pi Specific)
- Chromium kiosk mode
- systemd services
- Auto-start on boot
- Screen blanking controls

## File Watcher Test

The file watcher successfully detected changes:
1. Removed 10 test images automatically
2. Added 75 real photos automatically
3. Detected test file addition (test_file_watcher.jpg)

All changes were indexed in real-time without manual intervention.

## Performance Notes

- Initial indexing of 75 photos: < 1 second
- API response times: < 50ms
- File watcher detection: < 1 second
- No memory leaks or performance issues detected

## Next Steps for Raspberry Pi

1. Copy project to Raspberry Pi
2. Run `./install.sh` script
3. Test systemd services
4. Test kiosk mode display
5. Verify auto-start on boot

## Additional Notes

- The project works perfectly on macOS with spaces in the file path
- better-sqlite3 v11.7.0 is required for Node.js v24
- All 75 test photos have EXIF data from February 11, 2024
- Photos appear to be from a Pixel phone (PXL_ prefix)

