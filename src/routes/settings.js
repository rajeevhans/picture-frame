const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const { PROJECT_ROOT } = require('../lib/paths');
const { imageMessage, settingsMessage } = require('../lib/messages');
const { SettingsValidationError } = require('../slideshow/engine');
const router = express.Router();

function createSettingsRoutes(db, slideshowEngine, broadcastMessage, updateServerSlideshowInterval) {
    // Get current settings
    router.get('/', (req, res) => {
        try {
            const settings = slideshowEngine.getSettings();
            res.json(settings);
        } catch (error) {
            console.error('Error getting settings:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Update settings
    router.post('/', (req, res) => {
        let newSettings;
        try {
            // Engine performs validation and throws SettingsValidationError
            // on bad input — caught below and mapped to a 400.
            newSettings = slideshowEngine.updateSettings(req.body);
        } catch (error) {
            if (error instanceof SettingsValidationError) {
                return res.status(400).json({ error: error.message });
            }
            console.error('Error updating settings:', error);
            return res.status(500).json({ error: 'Internal server error' });
        }

        try {
            // Update server-side slideshow interval if it changed
            if (req.body.interval !== undefined && updateServerSlideshowInterval) {
                updateServerSlideshowInterval();
            }

            // Only used below to decide what to broadcast; mirrors the
            // fields actually changed by updateSettings.
            const updates = req.body || {};

            // Broadcast settings update to all clients
            if (broadcastMessage) {
                // If settings changed that affect the current image (like favorites filter),
                // also send the current image
                if (updates.favoritesOnly !== undefined || updates.mode !== undefined || updates.order !== undefined) {
                    const image = slideshowEngine.getCurrentImage();
                    if (image) {
                        // Note: do not force isPlaying here; clients keep their current play state
                        broadcastMessage(imageMessage({
                            image,
                            preload: slideshowEngine.getPreloadImages(),
                            settings: newSettings
                        }));
                    }
                } else {
                    // Just broadcast settings change
                    broadcastMessage(settingsMessage(newSettings));
                }
            }

            res.json({
                success: true,
                settings: newSettings
            });
        } catch (error) {
            console.error('Error updating settings:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Restart the photo frame process
    router.post('/restart', (req, res) => {
        try {
            res.json({ success: true, message: 'Restarting...' });

            // Delay restart to allow response to be sent
            setTimeout(() => {
                console.log('Restart requested, spawning replacement process...');
                const serverPath = path.join(PROJECT_ROOT, 'src', 'server.js');
                const child = spawn(process.argv[0], [serverPath, ...process.argv.slice(2)], {
                    stdio: 'inherit',
                    detached: true,
                    cwd: PROJECT_ROOT
                });
                child.unref();
                process.exit(0);
            }, 500);
        } catch (error) {
            console.error('Error restarting:', error);
            res.status(500).json({ error: 'Failed to restart' });
        }
    });

    return router;
}

module.exports = createSettingsRoutes;


