const express = require('express');
const { imageMessage, settingsMessage } = require('../lib/messages');

/**
 * Event imports (photos copied into {photoDir}/imports/<Event name>/).
 *   GET   /api/imports       -> { imports: [{ id, name, folder, createdAt, count, coverId }], active }
 *   PATCH /api/imports/:id   -> body { name } to rename (empty clears the name)
 *   DELETE /api/imports/:id  -> delete the import; its photos stay in the library
 * Showing an import is a slideshow setting: POST /api/settings { importFilter: id | '' }.
 * @param {object} db - DatabaseManager
 * @param {object} slideshowEngine
 * @param {(msg: object) => void} broadcastMessage
 * @param {object} importService - ImportService
 */
function createImportRoutes(db, slideshowEngine, broadcastMessage, importService) {
    const router = express.Router();

    router.get('/', (req, res) => {
        try {
            res.json({ imports: db.listImports(), active: slideshowEngine.settings.importFilter || '' });
        } catch (error) {
            console.error('Error listing imports:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.patch('/:id', (req, res) => {
        const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) : null;
        if (req.body.name !== undefined && req.body.name !== null && typeof req.body.name !== 'string') {
            return res.status(400).json({ error: 'name must be a string' });
        }
        try {
            if (!db.renameImport(req.params.id, name)) {
                return res.status(404).json({ error: 'Import not found' });
            }
            // Screens showing this import display its name
            if (slideshowEngine.settings.importFilter === req.params.id && broadcastMessage) {
                broadcastMessage(settingsMessage(slideshowEngine.getSettings()));
            }
            res.json({ success: true, import: db.getImport(req.params.id) });
        } catch (error) {
            console.error('Error renaming import:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.delete('/:id', (req, res) => {
        const id = req.params.id;
        try {
            const wasShown = slideshowEngine.settings.importFilter === id;
            const photos = importService.deleteImport(id);
            if (photos === null) return res.status(404).json({ error: 'Import not found' });
            // Screens showing it go back to all photos
            if (wasShown) {
                const settings = slideshowEngine.updateSettings({ importFilter: '' });
                const image = slideshowEngine.getCurrentImage();
                if (broadcastMessage) {
                    broadcastMessage(image
                        ? imageMessage({ image, group: slideshowEngine.getCurrentGroup(), preload: slideshowEngine.getPreloadImages(), settings })
                        : settingsMessage(settings));
                }
            }
            res.json({ success: true, id, photos });
        } catch (error) {
            console.error('Error deleting import:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}

module.exports = createImportRoutes;
