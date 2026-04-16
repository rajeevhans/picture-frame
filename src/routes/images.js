const express = require('express');
const path = require('path');
const fs = require('fs');
const ImageRotationService = require('../services/imageRotation');
const { isHeif, streamHeifAsJpeg, libheifInstallHint } = require('../lib/heif');
const { DELETED_DIR } = require('../lib/paths');
const { favoriteMessage, rotateMessage } = require('../lib/messages');
const router = express.Router();

/**
 * Move a file into the deleted folder, handling name collisions with a
 * timestamp suffix and falling back to copy+unlink across filesystems
 * (e.g. external drive -> project data dir triggers EXDEV on rename).
 *
 * Returns the final destination path, or null if the source didn't exist.
 */
async function moveFileToDeleted(sourcePath) {
    if (!fs.existsSync(DELETED_DIR)) {
        fs.mkdirSync(DELETED_DIR, { recursive: true });
    }

    if (!fs.existsSync(sourcePath)) {
        return null;
    }

    const filename = path.basename(sourcePath);
    let destPath = path.join(DELETED_DIR, filename);

    // Collision? Suffix with timestamp.
    if (fs.existsSync(destPath)) {
        const ext = path.extname(filename);
        const baseName = path.basename(filename, ext);
        destPath = path.join(DELETED_DIR, `${baseName}_${Date.now()}${ext}`);
    }

    try {
        await fs.promises.rename(sourcePath, destPath);
    } catch (renameErr) {
        if (renameErr.code !== 'EXDEV') throw renameErr;
        // Cross-filesystem: copy then delete
        await fs.promises.copyFile(sourcePath, destPath);
        await fs.promises.unlink(sourcePath);
    }

    return destPath;
}

/**
 * Common sender for /serve and /download: if the file is HEIF, convert to
 * JPEG and stream; otherwise send bytes directly. `mode` selects between
 * inline serving (cache headers, HEIF quality 90) and attachment download
 * (Content-Disposition, HEIF quality 95).
 *
 * Assumes the caller has already verified the file exists.
 */
async function sendImageOrHeif(req, res, { image, absolutePath, mode, context, nocache = false }) {
    const ext = path.extname(absolutePath).toLowerCase();
    const heifFile = isHeif(ext);
    const isDownload = mode === 'download';
    const quality = isDownload ? 95 : 90;
    const originalFilename = path.basename(image.filepath);

    // Content-Type / Content-Disposition headers
    if (isDownload) {
        if (heifFile) {
            const jpegFilename = originalFilename.replace(/\.(heic|heif)$/i, '.jpg');
            res.set({
                'Content-Disposition': `attachment; filename="${jpegFilename}"`,
                'Content-Type': 'image/jpeg'
            });
        } else {
            res.set({
                'Content-Disposition': `attachment; filename="${originalFilename}"`,
                'Content-Type': 'application/octet-stream'
            });
        }
    } else {
        if (heifFile) {
            res.set('Content-Type', 'image/jpeg');
        }
        // Cache headers only apply to inline serving
        if (nocache) {
            res.set({
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
        } else {
            const etag = `${image.id}-${image.file_modified}-${image.updated_at}`;
            res.set({
                'Cache-Control': 'public, max-age=86400',
                'ETag': etag
            });
        }
    }

    if (heifFile) {
        try {
            await streamHeifAsJpeg(absolutePath, res, quality);
        } catch (conversionError) {
            if (!res.headersSent) {
                const installCmd = libheifInstallHint();
                console.error(`HEIF conversion error for ${context} ${image.filepath}:`, conversionError.message);
                console.error(`HEIF support may not be installed. Install with: ${installCmd}`);
                res.status(415).json({
                    error: isDownload ? 'HEIF format not supported for download' : 'HEIF format not supported',
                    message: `HEIF conversion failed. Make sure libheif is installed (${installCmd}).`
                });
            }
        }
        return;
    }

    // Non-HEIF: stream directly
    res.sendFile(absolutePath, (err) => {
        if (!err) return;
        const label = isDownload ? 'downloading' : 'serving';
        console.error(`Error ${label} image ${image.filepath}:`, err.message);
        if (!res.headersSent) {
            res.status(404).json({ error: 'Image file not found' });
        }
    });
}

function createImageRoutes(db, slideshowEngine, ctx) {
    const rotationService = new ImageRotationService();
    const broadcastMessage = ctx && ctx.broadcastMessage;
    const broadcastCurrentImage = ctx && ctx.broadcastCurrentImage;
    const advanceSlideshow = ctx && ctx.advanceSlideshow;

    // Get current image
    router.get('/current', (req, res) => {
        try {
            const image = slideshowEngine.getCurrentImage();
            if (!image) {
                return res.status(404).json({ error: 'No images available' });
            }

            const preload = slideshowEngine.getPreloadImages();

            res.json({
                image,
                preload,
                settings: slideshowEngine.getSettings()
            });
        } catch (error) {
            console.error('Error getting current image:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Get next image
    router.get('/next', (req, res) => {
        try {
            const image = advanceSlideshow ? advanceSlideshow('next') : slideshowEngine.getNextImage();
            if (!image) {
                return res.status(404).json({ error: 'No images available' });
            }

            // If advanceSlideshow is async, it may have returned a Promise
            if (typeof image.then === 'function') {
                return image.then((resolved) => {
                    if (!resolved) return res.status(404).json({ error: 'No images available' });
                    const preload = slideshowEngine.getPreloadImages();
                    const settings = slideshowEngine.getSettings();
                    return res.json({ image: resolved, preload, settings });
                }).catch((error) => {
                    console.error('Error getting next image:', error);
                    return res.status(500).json({ error: 'Internal server error' });
                });
            }

            res.json({
                image,
                preload: slideshowEngine.getPreloadImages(),
                settings: slideshowEngine.getSettings()
            });
        } catch (error) {
            console.error('Error getting next image:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Get previous image
    router.get('/previous', (req, res) => {
        try {
            const image = advanceSlideshow ? advanceSlideshow('previous') : slideshowEngine.getPreviousImage();
            if (!image) {
                return res.status(404).json({ error: 'No images available' });
            }

            if (typeof image.then === 'function') {
                return image.then((resolved) => {
                    if (!resolved) return res.status(404).json({ error: 'No images available' });
                    const preload = slideshowEngine.getPreloadImages();
                    const settings = slideshowEngine.getSettings();
                    return res.json({ image: resolved, preload, settings });
                }).catch((error) => {
                    console.error('Error getting previous image:', error);
                    return res.status(500).json({ error: 'Internal server error' });
                });
            }

            res.json({
                image,
                preload: slideshowEngine.getPreloadImages(),
                settings: slideshowEngine.getSettings()
            });
        } catch (error) {
            console.error('Error getting previous image:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Serve image file
    router.get('/:id/serve', async (req, res) => {
        try {
            const imageId = parseInt(req.params.id);
            const image = db.getImageById(imageId);
            if (!image) {
                return res.status(404).json({ error: 'Image not found' });
            }

            const absolutePath = path.resolve(image.filepath);
            try {
                await fs.promises.access(absolutePath, fs.constants.F_OK);
            } catch (accessError) {
                return res.status(404).json({ error: 'Image file not found' });
            }

            await sendImageOrHeif(req, res, {
                image,
                absolutePath,
                mode: 'serve',
                context: 'serve',
                nocache: req.query.nocache === '1'
            });
        } catch (error) {
            console.error('Error serving image:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    // Toggle favorite
    router.post('/:id/favorite', (req, res) => {
        try {
            const imageId = parseInt(req.params.id);
            db.toggleFavorite(imageId);
            
            const image = db.getImageById(imageId);
            
            // Refresh slideshow if favorites filter is on
            if (slideshowEngine.settings.favoritesOnly) {
                slideshowEngine.refreshImageList();
            }

            // Broadcast favorite update to all clients
            if (broadcastMessage) {
                broadcastMessage(favoriteMessage(imageId, image.is_favorite === 1));
            }

            res.json({
                success: true,
                isFavorite: image.is_favorite === 1
            });
        } catch (error) {
            console.error('Error toggling favorite:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Delete image (move to deleted folder)
    router.delete('/:id', async (req, res) => {
        try {
            const imageId = parseInt(req.params.id);
            const image = db.getImageById(imageId);
            
            if (!image) {
                return res.status(404).json({ error: 'Image not found' });
            }
            
            // Immediately get next image and return response (don't wait for deletion)
            slideshowEngine.refreshImageList();
            const nextImage = advanceSlideshow ? await advanceSlideshow('next') : slideshowEngine.getNextImage();
            
            // Send response immediately with next image
            const response = {
                success: true,
                nextImage: nextImage || null
            };
            
            // Broadcast next image to all clients
            if (nextImage && broadcastCurrentImage) {
                broadcastCurrentImage(nextImage);
            }
            
            res.json(response);
            
            // Handle deletion in background (don't await)
            setImmediate(() => {
                (async () => {
                    try {
                        const sourcePath = path.resolve(image.filepath);
                        const destPath = await moveFileToDeleted(sourcePath);
                        if (destPath) {
                            console.log(`Moved ${image.filepath} to ${destPath}`);
                        } else {
                            console.log(`File not found: ${sourcePath}, removing from database only`);
                        }

                        // Remove from database
                        db.hardDelete(imageId);
                        slideshowEngine.refreshImageList();
                    } catch (error) {
                        console.error('Error in background deletion:', error);
                        // Still try to remove from database even if file move failed
                        try {
                            db.hardDelete(imageId);
                            slideshowEngine.refreshImageList();
                        } catch (dbError) {
                            console.error('Error removing from database:', dbError);
                        }
                    }
                })();
            });
        } catch (error) {
            console.error('Error deleting image:', error);
            res.status(500).json({ 
                error: 'Failed to delete image',
                message: error.message 
            });
        }
    });
    
    // Rotate image left (counter-clockwise)
    router.post('/:id/rotate-left', async (req, res) => {
        try {
            const imageId = parseInt(req.params.id);
            const image = db.getImageById(imageId);
            
            if (!image) {
                return res.status(404).json({ error: 'Image not found' });
            }
            
            // Physically rotate the file
            const result = await rotationService.rotateLeft(image.filepath);
            
            // Reset rotation to 0 since we've physically rotated the file
            db.setRotation(imageId, 0);
            
            // Update file modification time for cache busting
            const stats = fs.statSync(path.resolve(image.filepath));
            db.updateFileModified(imageId, stats.mtimeMs);
            
            console.log(`Rotated image ${imageId} left (counter-clockwise)`);

            // Tell all clients to reload this image with cache-busting
            if (broadcastMessage) {
                broadcastMessage(rotateMessage(imageId, Date.now() + Math.random()));
            }
            
            res.json({
                success: true,
                rotation: 0,
                message: 'Image physically rotated',
                ...result
            });
        } catch (error) {
            console.error('Error rotating image:', error);
            res.status(500).json({ 
                error: 'Failed to rotate image',
                message: error.message 
            });
        }
    });
    
    // Rotate image right (clockwise)
    router.post('/:id/rotate-right', async (req, res) => {
        try {
            const imageId = parseInt(req.params.id);
            const image = db.getImageById(imageId);
            
            if (!image) {
                return res.status(404).json({ error: 'Image not found' });
            }
            
            // Physically rotate the file
            const result = await rotationService.rotateRight(image.filepath);
            
            // Reset rotation to 0 since we've physically rotated the file
            db.setRotation(imageId, 0);
            
            // Update file modification time for cache busting
            const stats = fs.statSync(path.resolve(image.filepath));
            db.updateFileModified(imageId, stats.mtimeMs);
            
            console.log(`Rotated image ${imageId} right (clockwise)`);

            // Tell all clients to reload this image with cache-busting
            if (broadcastMessage) {
                broadcastMessage(rotateMessage(imageId, Date.now() + Math.random()));
            }
            
            res.json({
                success: true,
                rotation: 0,
                message: 'Image physically rotated',
                ...result
            });
        } catch (error) {
            console.error('Error rotating image:', error);
            res.status(500).json({ 
                error: 'Failed to rotate image',
                message: error.message 
            });
        }
    });

    // Download image
    router.get('/:id/download', async (req, res) => {
        try {
            const imageId = parseInt(req.params.id);
            const image = db.getImageById(imageId);
            if (!image) {
                return res.status(404).json({ error: 'Image not found' });
            }

            const absolutePath = path.resolve(image.filepath);
            try {
                await fs.promises.access(absolutePath, fs.constants.F_OK);
            } catch (accessError) {
                return res.status(404).json({ error: 'Image file not found' });
            }

            await sendImageOrHeif(req, res, {
                image,
                absolutePath,
                mode: 'download',
                context: 'download'
            });
        } catch (error) {
            console.error('Error downloading image:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    // Get image metadata by ID
    router.get('/:id', (req, res) => {
        try {
            const imageId = parseInt(req.params.id);
            const image = db.getImageById(imageId);

            if (!image) {
                return res.status(404).json({ error: 'Image not found' });
            }

            res.json(slideshowEngine.formatImage(image));
        } catch (error) {
            console.error('Error getting image:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // List images with pagination
    router.get('/', (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 50;
            const offset = (page - 1) * limit;
            const favoritesOnly = req.query.favorites === 'true';
            const orderBy = req.query.orderBy || 'date';

            const images = db.getAllImages({
                favoritesOnly,
                orderBy,
                limit,
                offset
            });

            const total = db.getImagesCount(favoritesOnly);

            res.json({
                images: images.map(img => slideshowEngine.formatImage(img)),
                pagination: {
                    page,
                    limit,
                    total,
                    pages: Math.ceil(total / limit)
                }
            });
        } catch (error) {
            console.error('Error listing images:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}

module.exports = createImageRoutes;


