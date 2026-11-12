/**
 * SSE message factories.
 *
 * Centralizes the shape of every message the server broadcasts so
 * clients and server don't drift. Each factory returns a plain object
 * that gets JSON.stringified by the broadcaster.
 *
 * Message types (consumed by src/public/js/app.js and
 * src/public/remote/remote.js):
 *   image          - current image changed (also includes preload + settings,
 *                    and `group` when photos are shown side by side)
 *   favorite       - favorite toggle for a specific image
 *   settings       - slideshow settings changed (no image change)
 *   slideshowState - play/pause state changed
 *   rotate         - an image was physically rotated; clients should
 *                    reload it with the given cacheBuster
 *   importReady    - new photos of an event import finished arriving; it is now shown
 */

/**
 * @param {object} p
 * @param {object[]|null} [p.group] - side by side: every photo on screen,
 *   `image` first. Absent for a single photo; `image` is always the first
 *   photo, so clients that don't know about groups keep working.
 */
function imageMessage({ image, group, preload, settings, isPlaying }) {
    const msg = { type: 'image', image, preload, settings };
    if (group && group.length > 1) msg.group = group;
    if (typeof isPlaying === 'boolean') msg.isPlaying = isPlaying;
    return msg;
}

function favoriteMessage(imageId, isFavorite) {
    return { type: 'favorite', imageId, isFavorite };
}

function settingsMessage(settings) {
    return { type: 'settings', settings };
}

function slideshowStateMessage(isPlaying) {
    return { type: 'slideshowState', isPlaying };
}

function rotateMessage(imageId, cacheBuster) {
    return { type: 'rotate', imageId, cacheBuster };
}

function importReadyMessage({ id, name, count, added, updated }) {
    return {
        type: 'importReady', importId: id, name: name || null, count,
        added: typeof added === 'number' ? added : null,   // new photos this time (null = unknown)
        updated: !!updated                                   // had been shown before
    };
}

function duplicateScanMessage(state) {
    return { type: 'duplicateScan', ...state };
}

module.exports = {
    imageMessage,
    favoriteMessage,
    settingsMessage,
    slideshowStateMessage,
    rotateMessage,
    importReadyMessage,
    duplicateScanMessage
};
