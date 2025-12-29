#!/bin/bash

# Raspberry Pi Picture Frame Installation Script
# This script installs and configures the picture frame to auto-start on boot

set -e

echo "========================================="
echo "  Picture Frame Installation Script"
echo "========================================="
echo ""

# Check if running on Raspberry Pi
if [ ! -f /proc/device-tree/model ] || ! grep -q "Raspberry Pi" /proc/device-tree/model 2>/dev/null; then
    echo "Warning: This script is designed for Raspberry Pi"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if running as regular user (not root)
if [ "$EUID" -eq 0 ]; then
    echo "Please run this script as a regular user (not root)"
    echo "The script will use sudo when needed"
    exit 1
fi

# Get current directory
INSTALL_DIR=$(pwd)
echo "Installation directory: $INSTALL_DIR"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Node.js is not installed!"
    echo "Installing Node.js 18.x..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    NODE_VERSION=$(node --version)
    echo "Node.js version: $NODE_VERSION"
fi

# Check if npm packages are installed
if [ ! -d "node_modules" ]; then
    echo ""
    echo "Installing npm packages..."
    npm install
else
    echo "npm packages already installed"
fi

# Check if Chromium is installed
if ! command -v chromium-browser &> /dev/null; then
    echo ""
    echo "Chromium is not installed!"
    read -p "Install Chromium browser? (Y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
        sudo apt-get update
        sudo apt-get install -y chromium-browser unclutter x11-xserver-utils
    fi
else
    echo "Chromium is installed"
fi

# Configure photo directory
echo ""
echo "Configuring photo directory..."
read -p "Enter the path to your photos directory [/home/$USER/Pictures]: " PHOTO_DIR
PHOTO_DIR=${PHOTO_DIR:-/home/$USER/Pictures}

# Update config.json
if [ -f "config.json" ]; then
    # Create backup
    cp config.json config.json.backup
    
    # Update photo directory in config
    node -e "
        const fs = require('fs');
        const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
        config.photoDirectory = '$PHOTO_DIR';
        fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    "
    echo "Updated config.json with photo directory: $PHOTO_DIR"
fi

# Create photo directory if it doesn't exist
if [ ! -d "$PHOTO_DIR" ]; then
    echo "Photo directory does not exist. Creating it..."
    mkdir -p "$PHOTO_DIR"
    echo "Please add your photos to: $PHOTO_DIR"
fi

# Install systemd services
echo ""
echo "Installing systemd services..."

# Update service files with correct paths and user
USER_NAME=$(whoami)
sed "s|WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|g" systemd/pictureframe.service | \
sed "s|User=pi|User=$USER_NAME|g" | \
sudo tee /etc/systemd/system/pictureframe.service > /dev/null

sed "s|User=pi|User=$USER_NAME|g" systemd/pictureframe-display.service | \
sed "s|XAUTHORITY=.*|XAUTHORITY=/home/$USER_NAME/.Xauthority|g" | \
sudo tee /etc/systemd/system/pictureframe-display.service > /dev/null

# Reload systemd
sudo systemctl daemon-reload

# Enable services
echo "Enabling services to start on boot..."
sudo systemctl enable pictureframe.service
sudo systemctl enable pictureframe-display.service

# Ask if user wants to start services now
echo ""
read -p "Start services now? (Y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    echo "Starting pictureframe service..."
    sudo systemctl start pictureframe.service
    
    echo "Waiting for server to start..."
    sleep 3
    
    # Check if service is running
    if systemctl is-active --quiet pictureframe.service; then
        echo "✓ Picture Frame server is running"
        
        # Only start display service if in graphical environment
        if [ -n "$DISPLAY" ]; then
            echo "Starting display service..."
            sudo systemctl start pictureframe-display.service
            echo "✓ Display service started"
        else
            echo "No display detected. Display service will start on next boot."
        fi
    else
        echo "✗ Failed to start Picture Frame server"
        echo "Check logs with: sudo journalctl -u pictureframe.service -n 50"
    fi
fi

# Disable screen blanking and screensaver (optional)
echo ""
read -p "Disable screen blanking and screensaver? (Y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    # Disable screen blanking in X11
    if [ ! -f ~/.xinitrc ]; then
        touch ~/.xinitrc
    fi
    
    if ! grep -q "xset s off" ~/.xinitrc; then
        cat >> ~/.xinitrc << 'EOF'

# Disable screen blanking
xset s off
xset -dpms
xset s noblank
EOF
        echo "✓ Screen blanking disabled in ~/.xinitrc"
    fi
    
    # Also add to autostart if using desktop environment
    AUTOSTART_DIR="$HOME/.config/autostart"
    if [ -d "$AUTOSTART_DIR" ] || mkdir -p "$AUTOSTART_DIR" 2>/dev/null; then
        cat > "$AUTOSTART_DIR/disable-screensaver.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Disable Screensaver
Exec=sh -c 'xset s off; xset -dpms; xset s noblank'
X-GNOME-Autostart-enabled=true
EOF
        echo "✓ Created autostart entry to disable screensaver"
    fi
fi

echo ""
echo "========================================="
echo "  Installation Complete!"
echo "========================================="
echo ""
echo "Service status:"
sudo systemctl status pictureframe.service --no-pager -l || true
echo ""
echo "Useful commands:"
echo "  Start/Stop/Restart server:"
echo "    sudo systemctl start pictureframe"
echo "    sudo systemctl stop pictureframe"
echo "    sudo systemctl restart pictureframe"
echo ""
echo "  View logs:"
echo "    sudo journalctl -u pictureframe.service -f"
echo "    sudo journalctl -u pictureframe-display.service -f"
echo ""
echo "  Check status:"
echo "    sudo systemctl status pictureframe"
echo "    sudo systemctl status pictureframe-display"
echo ""
echo "  Web interface (from browser):"
echo "    http://localhost:3000"
echo "    http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "========================================="


