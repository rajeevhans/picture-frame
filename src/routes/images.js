const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ImageRotationService = require('../services/imageRotation');
const router = express.Router();

function createImageRoutes(db, slideshowEngine, ctx) {
    const rotationService = new ImageRotationService();
    const broadcastUpdate = ctx && ctx.broadcastUpdate;
    const broadcastCurrentImage = ctx && ctx.broadcastCurrentImage;
    const advanceSlideshow = ctx && ctx.advanceSlideshow;

    /**
     * Convert HEIF to JPEG using heif-convert as fallback when Sharp fails
     * Optimized: Try Sharp first, fallback to heif-convert only on error
     * @param {string} heifPath - Path to HEIF file
     * @param {NodeJS.WritableStream} outputStream - Stream to write JPEG to
     * @param {number} quality - JPEG quality (1-100)
     * @returns {Promise<void>}
     */
    async function convertHeifToJpeg(heifPath, outputStream, quality = 90) {
        // Use heif-convert since Sharp can't handle compression format 11.6003
        // heif-convert requires an output file, so we use a temp file
        const tempFile = path.join(os.tmpdir(), `heif_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
        
        return new Promise((resolve, reject) => {
            const heifConvert = spawn('heif-convert', ['-q', quality.toString(), heifPath, tempFile], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let stderr = '';
            heifConvert.stderr.on('data', (data) => {
                // Progress messages go to stderr, we can ignore them
                stderr += data.toString();
            });
            
            heifConvert.on('close', async (code) => {
                if (code === 0) {
                    try {
                        // Stream the converted file to response
                        const fileStream = fs.createReadStream(tempFile);
                        fileStream.pipe(outputStream);
                        
                        fileStream.on('end', async () => {
                            // Clean up temp file
                            try {
                                await fs.promises.unlink(tempFile);
                            } catch (unlinkErr) {
                                // Ignore cleanup errors
                            }
                            resolve();
                        });
                        
                        fileStream.on('error', async (err) => {
                            // Clean up temp file
                            try {
                                await fs.promises.unlink(tempFile);
                            } catch (unlinkErr) {
                                // Ignore cleanup errors
                            }
                            reject(err);
                        });
                    } catch (err) {
                        reject(err);
                    }
                } else {
                    reject(new Error(`heif-convert failed with code ${code}: ${stderr}`));
                }
            });
            
            heifConvert.on('error', (spawnErr) => {
                reject(new Error(`Failed to spawn heif-convert: ${spawnErr.message}. Make sure libheif is installed.`));
            });
        });
    }

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
            
            // Check if file exists (async to avoid blocking)
            try {
                await fs.promises.access(absolutePath, fs.constants.F_OK);
            } catch (accessError) {
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
                    await convertHeifToJpeg(absolutePath, res, 90);
                } catch (conversionError) {
                    if (!res.headersSent) {
                        const isMacOS = process.platform === 'darwin';
                        const installCmd = isMacOS 
                            ? 'brew install libheif'
                            : 'sudo apt-get install libheif-dev libde265-dev libx265-dev';
                        
                        console.error(`HEIF conversion error for ${image.filepath}:`, conversionError.message);
                        console.error(`HEIF support may not be installed. Install with: ${installCmd}`);
                        res.status(415).json({ 
                            error: 'HEIF format not supported',
                            message: `HEIF conversion failed. Make sure libheif is installed (${installCmd}).`
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
                        
                        // Move the file asynchronously
                        if (fs.existsSync(sourcePath)) {
                            await fs.promises.rename(sourcePath, finalDestPath);
                            console.log(`Moved ${image.filepath} to ${finalDestPath}`);
                        } else {
                            console.log(`File not found: ${sourcePath}, removing from database only`);
                        }
                        
                        // Remove from database
                        db.hardDelete(imageId);
                        
                        // Refresh slideshow list after deletion
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
            
            // Check if file exists (async to avoid blocking)
            try {
                await fs.promises.access(absolutePath, fs.constants.F_OK);
            } catch (accessError) {
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
                    await convertHeifToJpeg(absolutePath, res, 95);
                } catch (conversionError) {
                    if (!res.headersSent) {
                        const isMacOS = process.platform === 'darwin';
                        const installCmd = isMacOS 
                            ? 'brew install libheif'
                            : 'sudo apt-get install libheif-dev libde265-dev libx265-dev';
                        
                        console.error(`HEIF conversion error for download ${image.filepath}:`, conversionError.message);
                        console.error(`HEIF support may not be installed. Install with: ${installCmd}`);
                        res.status(415).json({ 
                            error: 'HEIF format not supported for download',
                            message: `HEIF conversion failed. Make sure libheif is installed (${installCmd}).`
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


