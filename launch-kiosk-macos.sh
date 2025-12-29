#!/bin/bash

# Picture Frame Kiosk Launcher for macOS
# Launches the picture frame in fullscreen kiosk mode

echo "========================================"
echo "  Picture Frame - Kiosk Mode Launcher"
echo "========================================"
echo ""

# Check if server is running
if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "Error: Server is not running on http://localhost:3000"
    echo "Please start the server first with: npm start"
    exit 1
fi

echo "Server is running ✓"
echo ""

# Check for Chromium
if [ -d "/Applications/Chromium.app" ]; then
    BROWSER="/Applications/Chromium.app/Contents/MacOS/Chromium"
    echo "Using Chromium"
elif [ -d "/Applications/Google Chrome.app" ]; then
    BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    echo "Using Google Chrome"
else
    echo "Error: Neither Chromium nor Chrome found"
    echo ""
    echo "Install Chromium with: brew install --cask chromium"
    echo "Or install Chrome from: https://www.google.com/chrome/"
    exit 1
fi

echo "Launching picture frame in kiosk mode..."
echo "Press Cmd+Q to exit fullscreen"
echo ""

# Launch browser in kiosk mode
"$BROWSER" \        
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --disable-features=TranslateUI \
    --disable-translate \
    --disable-sync \
    --disable-default-apps \
    --disable-extensions \
    --incognito \
    --app=http://localhost:3000 \
    > /dev/null 2>&1 &

echo "Kiosk mode launched!"
echo ""
echo "To exit:"
echo "  - Press Cmd+Q (or Cmd+W) to close"
echo "  - Move mouse to show controls"
echo "========================================"

