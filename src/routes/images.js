const express = require('express');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ImageRotationService = require('../services/imageRotation');
const router = express.Router();

function createImageRoutes(db, slideshowEngine, ctx) {
    const rotationService = new ImageRotationService();
    const broadcastUpdate = ctx && ctx.broadcastUpdate;
    const broadcastCurrentImage = ctx && ctx.broadcastCurrentImage;
    const advanceSlideshow = ctx && ctx.advanceSlideshow;

    // Get current image
    router.get('/current', (req, res) => {
        try {
            const image = slideshowEngine.getCurrentImage();
            if (!image) {
                return res.status(404).json({ error: 'No images available' });
            }

            const preload = slideshowEngine.getPreloadImages(3);

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
                    const preload = slideshowEngine.getPreloadImages(3);
                    const settings = slideshowEngine.getSettings();
                    return res.json({ image: resolved, preload, settings });
                }).catch((error) => {
                    console.error('Error getting next image:', error);
                    return res.status(500).json({ error: 'Internal server error' });
                });
            }

            res.json({
                image,
                preload: slideshowEngine.getPreloadImages(3),
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
                    const preload = slideshowEngine.getPreloadImages(3);
                    const settings = slideshowEngine.getSettings();
                    return res.json({ image: resolved, preload, settings });
                }).catch((error) => {
                    console.error('Error getting previous image:', error);
                    return res.status(500).json({ error: 'Internal server error' });
                });
            }

            res.json({
                image,
                preload: slideshowEngine.getPreloadImages(3),
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

            // Check if nocache parameter is present (used after rotation)
            const nocache = req.query.nocache === '1';
            
            // Resolve to absolute path
            const absolutePath = path.resolve(image.filepath);
            
            // Check if file exists
            if (!fs.existsSync(absolutePath)) {
                return res.status(404).json({ error: 'Image file not found' });
            }
            
            // Check if file is HEIF/HEIC format
            const ext = path.extname(absolutePath).toLowerCase();
            const isHeif = ['.heic', '.heif'].includes(ext);
            
            // Set content type
            if (isHeif) {
                res.set('Content-Type', 'image/jpeg');
            }
            
            // Set caching headers
            if (nocache) {
                // No cache for freshly rotated images
                res.set({
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                });
            } else {
                // Normal caching - use file modification time for better cache busting
                const etag = `${image.id}-${image.file_modified}-${image.updated_at}`;
                res.set({
                    'Cache-Control': 'public, max-age=86400', // 24 hours
                    'ETag': etag
                });
            }
            
            // Convert HEIF to JPEG on-the-fly, or serve directly
            if (isHeif) {
                try {
                    // Check if Sharp supports HEIF by attempting to read metadata
                    const metadata = await sharp(absolutePath).metadata();
                    
                    // Convert HEIF to JPEG and stream to response
                    sharp(absolutePath)
                        .jpeg({ quality: 90 })
                        .on('error', (err) => {
                            if (!res.headersSent) {
                                console.error(`HEIF conversion error for ${image.filepath}:`, err.message);
                                console.error('HEIF support may not be installed. Install with: sudo apt-get install libheif-dev libde265-dev libx265-dev');
                                res.status(415).json({ 
                                    error: 'HEIF format not supported',
                                    message: 'HEIF decoding libraries not installed. Install libheif-dev, libde265-dev, and libx265-dev, then rebuild Sharp.'
                                });
                            }
                        })
                        .pipe(res);
                } catch (conversionError) {
                    if (!res.headersSent) {
                        console.error(`HEIF conversion error for ${image.filepath}:`, conversionError.message);
                        console.error('HEIF support may not be installed. Install with: sudo apt-get install libheif-dev libde265-dev libx265-dev');
                        res.status(415).json({ 
                            error: 'HEIF format not supported',
                            message: 'HEIF decoding libraries not installed. Install libheif-dev, libde265-dev, and libx265-dev, then rebuild Sharp.'
                        });
                    }
                }
            } else {
                // Send the file directly for non-HEIF formats
                res.sendFile(absolutePath, (err) => {
                    if (err) {
                        // Only log the error, don't try to send response
                        // (headers may already be sent or client disconnected)
                        console.error(`Error serving image ${image.filepath}:`, err.message);
                        
                        // Only send error response if headers haven't been sent yet
                        if (!res.headersSent) {
                            res.status(404).json({ error: 'Image file not found' });
                        }
                    }
                });
            }
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
            if (broadcastUpdate) {
                broadcastUpdate('favorite', {
                    imageId,
                    isFavorite: image.is_favorite === 1
                });
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
            
            // Create deleted folder if it doesn't exist
            const deletedDir = path.resolve('./data/deleted');
            if (!fs.existsSync(deletedDir)) {
                fs.mkdirSync(deletedDir, { recursive: true });
            }
            
            // Get source and destination paths
            const sourcePath = path.resolve(image.filepath);
            const filename = path.basename(image.filepath);
            const destPath = path.join(deletedDir, filename);
            
            // Handle filename conflicts by adding timestamp
            let finalDestPath = destPath;
            if (fs.existsSync(finalDestPath)) {
                const timestamp = Date.now();
                const ext = path.extname(filename);
                const baseName = path.basename(filename, ext);
                finalDestPath = path.join(deletedDir, `${baseName}_${timestamp}${ext}`);
            }
            
            // Move the file
            if (fs.existsSync(sourcePath)) {
                fs.renameSync(sourcePath, finalDestPath);
                console.log(`Moved ${image.filepath} to ${finalDestPath}`);
            } else {
                console.log(`File not found: ${sourcePath}, removing from database only`);
            }
            
            // Remove from database
            db.hardDelete(imageId);

            // Refresh slideshow
            slideshowEngine.refreshImageList();

            // Move to next image
            const nextImage = advanceSlideshow ? await advanceSlideshow('next') : slideshowEngine.getNextImage();
            if (!nextImage) {
                return res.json({
                    success: true,
                    nextImage: null,
                    movedTo: finalDestPath
                });
            }

            // If we didn't go through server controller, still broadcast to keep clients in sync
            if (!advanceSlideshow && broadcastCurrentImage) {
                broadcastCurrentImage(nextImage);
            }

            res.json({
                success: true,
                nextImage,
                movedTo: finalDestPath
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
            if (broadcastUpdate) {
                broadcastUpdate('rotate', {
                    imageId,
                    cacheBuster: Date.now() + Math.random()
                });
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
            if (broadcastUpdate) {
                broadcastUpdate('rotate', {
                    imageId,
                    cacheBuster: Date.now() + Math.random()
                });
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

            // Resolve to absolute path
            const absolutePath = path.resolve(image.filepath);
            
            // Check if file exists
            if (!fs.existsSync(absolutePath)) {
                return res.status(404).json({ error: 'Image file not found' });
            }

            // Get the original filename
            const originalFilename = path.basename(image.filepath);
            
            // Check if file is HEIF/HEIC format
            const ext = path.extname(absolutePath).toLowerCase();
            const isHeif = ['.heic', '.heif'].includes(ext);
            
            // Set download headers
            if (isHeif) {
                // Convert HEIF to JPEG for download
                const jpegFilename = originalFilename.replace(/\.(heic|heif)$/i, '.jpg');
                res.set({
                    'Content-Disposition': `attachment; filename="${jpegFilename}"`,
                    'Content-Type': 'image/jpeg'
                });
                
                try {
                    // Convert HEIF to JPEG and stream to response
                    sharp(absolutePath)
                        .jpeg({ quality: 95 })
                        .on('error', (err) => {
                            if (!res.headersSent) {
                                console.error(`HEIF conversion error for download ${image.filepath}:`, err.message);
                                res.status(415).json({ 
                                    error: 'HEIF format not supported for download',
                                    message: 'HEIF decoding libraries not installed.'
                                });
                            }
                        })
                        .pipe(res);
                } catch (conversionError) {
                    if (!res.headersSent) {
                        console.error(`HEIF conversion error for download ${image.filepath}:`, conversionError.message);
                        res.status(415).json({ 
                            error: 'HEIF format not supported for download',
                            message: 'HEIF decoding libraries not installed.'
                        });
                    }
                }
            } else {
                // Set download headers for regular images
                res.set({
                    'Content-Disposition': `attachment; filename="${originalFilename}"`,
                    'Content-Type': 'application/octet-stream'
                });
                
                // Send the file directly
                res.sendFile(absolutePath, (err) => {
                    if (err) {
                        console.error(`Error downloading image ${image.filepath}:`, err.message);
                        if (!res.headersSent) {
                            res.status(404).json({ error: 'Image file not found' });
                        }
                    }
                });
            }
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


