/**
 * SSE message factories.
 *
 * Centralizes the shape of every message the server broadcasts so
 * clients and server don't drift. Each factory returns a plain object
 * that gets JSON.stringified by the broadcaster.
 *
 * Message types (consumed by src/public/js/app.js and
 * src/public/remote/remote.js):
 *   image          - current image changed (also includes preload + settings)
 *   favorite       - favorite toggle for a specific image
 *   settings       - slideshow settings changed (no image change)
 *   slideshowState - play/pause state changed
 *   rotate         - an image was physically rotated; clients should
 *                    reload it with the given cacheBuster
 */

function imageMessage({ image, preload, settings, isPlaying }) {
    const msg = { type: 'image', image, preload, settings };
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

module.exports = {
    imageMessage,
    favoriteMessage,
    settingsMessage,
    slideshowStateMessage,
    rotateMessage
};
