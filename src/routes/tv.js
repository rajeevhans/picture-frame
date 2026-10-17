const express = require('express');
const { TvControlError } = require('../services/tvControl');
const logger = require('../logger');

/**
 * TV power control over the LAN.
 *   GET  /api/tv/status  -> { reachable, powerState, paired, name, model }
 *   POST /api/tv/on      -> { changed, powerState, method }
 *   POST /api/tv/off
 *   POST /api/tv/toggle
 *   POST /api/tv/key     -> body { key: 'KEY_VOLUP' } (allowlisted keys only)
 *   POST /api/tv/pair    -> one-time: accept the "Allow" prompt on the TV
 * @param {object} tvControl - TvControlService
 */
function createTvRoutes(tvControl) {
    const router = express.Router();

    const handle = (action, fn) => async (req, res) => {
        try {
            const result = await fn(req);
            // Key presses are frequent (held D-pad/volume), so log them at debug level.
            if (action === 'key') logger.debug('TV key', result);
            else if (action !== 'status') logger.info(`TV ${action}`, result);
            res.json({ success: true, ...result });
        } catch (error) {
            const status = error instanceof TvControlError ? error.status : 500;
            logger.warn(`TV ${action} failed`, { status, error: error.message });
            if (status === 500) console.error(`TV ${action} failed:`, error);
            res.status(status).json({ success: false, error: error.message });
        }
    };

    router.get('/status', handle('status', () => tvControl.getStatus()));
    router.post('/on', handle('on', () => tvControl.turnOn()));
    router.post('/off', handle('off', () => tvControl.turnOff()));
    router.post('/toggle', handle('toggle', () => tvControl.toggle()));
    router.post('/pair', handle('pair', () => tvControl.pair()));
    router.post('/key', handle('key', (req) => tvControl.sendKey(req.body && req.body.key)));

    return router;
}

module.exports = createTvRoutes;
