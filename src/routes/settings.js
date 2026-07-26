const express = require('express');
const { imageMessage, settingsMessage } = require('../lib/messages');
const { SettingsValidationError } = require('../slideshow/engine');
const router = express.Router();

/**
 * True when the process is managed by something that will restart it on
 * exit: systemd (INVOCATION_ID / JOURNAL_STREAM set) or the Electron
 * wrapper (ELECTRON_APP=1, whose child-death handler relaunches the server).
 */
function isSupervised() {
    return process.env.ELECTRON_APP === '1'
        || !!process.env.INVOCATION_ID
        || !!process.env.JOURNAL_STREAM;
}

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

    // Restart the photo frame process by exiting cleanly and letting the
    // supervisor (systemd / Electron) respawn it.
    router.post('/restart', (req, res) => {
        try {
            const supervised = isSupervised();
            res.json({
                success: true,
                message: supervised
                    ? 'Restarting...'
                    : 'Exiting. No supervisor detected — the server will not restart on its own.'
            });

            // Delay exit to allow the response to flush.
            setTimeout(() => {
                if (supervised) {
                    console.log('Restart requested; exiting for supervisor to respawn...');
                } else {
                    console.warn('Restart requested but no supervisor detected '
                        + '(not systemd/Electron). Exiting — start again with `npm start`.');
                }
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


