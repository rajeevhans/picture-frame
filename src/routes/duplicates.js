const express = require('express');
const path = require('path');
const { moveFileToDeleted } = require('./images');

/**
 * Duplicate detection + resolution routes.
 * @param {object} db
 * @param {object} duplicateService - DuplicateDetectionService
 * @param {object} slideshowEngine
 * @param {(msg:object)=>void} broadcastMessage
 */
function createDuplicateRoutes(db, duplicateService, slideshowEngine, broadcastMessage) {
    const router = express.Router();

    router.get('/status', (req, res) => {
        res.json({ ...duplicateService.getStatus(), ...db.getDuplicateGroupSummary() });
    });

    router.get('/groups', (req, res) => {
        res.json(db.getDuplicateGroupsForReview());
    });

    router.post('/scan', (req, res) => {
        if (duplicateService.isRunning()) {
            return res.status(409).json({ error: 'A scan is already running', status: duplicateService.getStatus() });
        }
        // Fire and forget; progress streams over SSE.
        duplicateService.runScan().catch(err => console.error('Duplicate scan failed:', err));
        res.json({ success: true, status: duplicateService.getStatus() });
    });

    router.post('/cancel', (req, res) => {
        duplicateService.requestCancel();
        res.json({ success: true });
    });

    // Resolve a single group: keep keeperId, delete deleteIds (with carryover).
    router.post('/resolve', async (req, res) => {
        const keeperId = parseInt(req.body.keeperId);
        const deleteIds = Array.isArray(req.body.deleteIds) ? req.body.deleteIds.map(Number) : [];
        if (!keeperId || deleteIds.includes(keeperId) || deleteIds.length === 0) {
            return res.status(400).json({ error: 'Invalid keeperId/deleteIds' });
        }
        try {
            const deleted = await resolve(db, slideshowEngine, keeperId, deleteIds);
            broadcastMessage && broadcastMessage(require('../lib/messages').duplicateScanMessage(duplicateService.getStatus()));
            res.json({ success: true, deleted });
        } catch (error) {
            console.error('Resolve group failed:', error);
            res.status(500).json({ error: 'Failed to resolve group' });
        }
    });

    // Auto-resolve all eligible groups of a scope using the suggested keeper.
    router.post('/auto-resolve', async (req, res) => {
        const scope = req.body.scope === 'similar' ? 'similar' : 'exact';
        if (scope === 'similar' && req.body.confirm !== true) {
            return res.status(400).json({ error: 'Similar auto-resolve requires confirm:true' });
        }
        try {
            // autoEligible: exact groups are always eligible; similar groups only
            // when the component holds together under the stricter auto threshold.
            const groups = db.getDuplicateGroups().filter(g => g.groupType === scope && !g.oversized && g.autoEligible);
            let totalDeleted = 0;
            for (const g of groups) {
                const keeper = g.members.find(m => m.isSuggestedKeeper) || g.members[0];
                const deleteIds = g.members.filter(m => m.id !== keeper.id).map(m => m.id);
                if (!deleteIds.length) continue;
                const deleted = await resolve(db, slideshowEngine, keeper.id, deleteIds);
                totalDeleted += deleted.length;
            }
            res.json({ success: true, groupsResolved: groups.length, imagesDeleted: totalDeleted });
        } catch (error) {
            console.error('Auto-resolve failed:', error);
            res.status(500).json({ error: 'Auto-resolve failed' });
        }
    });

    return router;
}

/**
 * Carry metadata to the keeper, move each deleted file to data/deleted/, hard-delete
 * its row, and prune group membership. Returns the list of deleted ids.
 */
async function resolve(db, slideshowEngine, keeperId, deleteIds) {
    db.applyDuplicateCarryover(keeperId, deleteIds);
    const done = [];
    for (const id of deleteIds) {
        const img = db.getImageById(id);
        if (!img) continue;
        try {
            await moveFileToDeleted(path.resolve(img.filepath));
        } catch (err) {
            console.error(`Duplicate resolve: file move failed for ${img.filepath}:`, err.message);
        }
        db.hardDelete(id);
        done.push(id);
    }
    db.removeImagesFromGroups([keeperId, ...deleteIds]); // keeper's group is resolved too
    slideshowEngine.refreshImageList();
    return done;
}

module.exports = createDuplicateRoutes;
