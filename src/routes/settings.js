const express = require('express');
const router = express.Router();

function createSettingsRoutes(db, slideshowEngine, broadcastUpdate, updateServerSlideshowInterval) {
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
        try {
            const updates = {};

            if (req.body.mode !== undefined) {
                if (!['sequential', 'random', 'smart'].includes(req.body.mode)) {
                    return res.status(400).json({ error: 'Invalid mode. Must be sequential, random, or smart' });
                }
                updates.mode = req.body.mode;
            }

            if (req.body.order !== undefined) {
                if (!['date', 'filename', 'thisday'].includes(req.body.order)) {
                    return res.status(400).json({ error: 'Invalid order. Must be date, filename, or thisday' });
                }
                updates.order = req.body.order;
            }

            if (req.body.interval !== undefined) {
                const interval = parseInt(req.body.interval);
                if (isNaN(interval) || interval < 1) {
                    return res.status(400).json({ error: 'Invalid interval. Must be a positive number' });
                }
                updates.interval = interval;
            }

            if (req.body.favoritesOnly !== undefined) {
                updates.favoritesOnly = req.body.favoritesOnly === true || req.body.favoritesOnly === 'true';
            }

            const newSettings = slideshowEngine.updateSettings(updates);

            // Update server-side slideshow interval if it changed
            if (updates.interval !== undefined && updateServerSlideshowInterval) {
                updateServerSlideshowInterval();
            }

            // Broadcast settings update to all clients
            if (broadcastUpdate) {
                // If settings changed that affect the current image (like favorites filter),
                // also send the current image
                if (updates.favoritesOnly !== undefined || updates.mode !== undefined || updates.order !== undefined) {
                    const image = slideshowEngine.getCurrentImage();
                    if (image) {
                        const preload = slideshowEngine.getPreloadImages();
                        // Note: do not force isPlaying here; clients keep their current play state
                        broadcastUpdate('image', {
                            image,
                            preload,
                            settings: newSettings
                        });
                    }
                } else {
                    // Just broadcast settings change
                    broadcastUpdate('settings', {
                        settings: newSettings
                    });
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

    // Get statistics
    router.get('/stats', (req, res) => {
        try {
            const stats = db.getStats();
            res.json(stats);
        } catch (error) {
            console.error('Error getting stats:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}

module.exports = createSettingsRoutes;


