const express = require('express');
const path = require('path');
const fs = require('fs');
const DatabaseManager = require('./database/db');
const DirectoryScanner = require('./indexer/scanner');
const FileWatcher = require('./indexer/watcher');
const SlideshowEngine = require('./slideshow/engine');
const GeolocationService = require('./services/geolocation');
const createImageRoutes = require('./routes/images');
const createSettingsRoutes = require('./routes/settings');

// Load configuration
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Initialize Express app
const app = express();
app.use(express.json());

// Resolve paths
const dbPath = path.resolve(__dirname, '..', config.databasePath);
const photoDir = config.photoDirectory;

// Initialize database
console.log('Initializing database...');
const db = new DatabaseManager(dbPath);

// Initialize scanner
const scanner = new DirectoryScanner(db, config);

// Initialize slideshow engine
const slideshowEngine = new SlideshowEngine(db);

// Initialize geolocation service
const geoService = new GeolocationService();

// SSE clients for broadcasting updates
const sseClients = new Set();
let slideshowTimer = null;
let isSlideshowPlaying = false;

// Check command line arguments
const args = process.argv.slice(2);
const forceIndex = args.includes('--index') || args.includes('-i');
const devMode = args.includes('--dev');

// Initialize slideshow engine
slideshowEngine.initialize();

// Broadcast function to send updates to all connected clients
function broadcastUpdate(type, data) {
    const message = JSON.stringify({ type, ...data });
    const sseMessage = `data: ${message}\n\n`;
    
    // Send to all connected clients
    sseClients.forEach(client => {
        try {
            client.write(sseMessage);
        } catch (error) {
            // Client disconnected, remove from set
            sseClients.delete(client);
        }
    });
}

// Server-side slideshow timer
function startServerSlideshow() {
    if (slideshowTimer || isSlideshowPlaying) return;
    
    isSlideshowPlaying = true;
    const interval = slideshowEngine.settings.interval || 10;
    
    slideshowTimer = setInterval(() => {
        try {
            const image = slideshowEngine.getNextImage();
            if (image) {
                const preload = slideshowEngine.getPreloadImages(3);
                broadcastUpdate('image', {
                    image,
                    preload,
                    settings: slideshowEngine.getSettings(),
                    isPlaying: true
                });
            }
        } catch (error) {
            console.error('Error in server slideshow timer:', error);
        }
    }, interval * 1000);
    
    console.log(`Server-side slideshow started (${interval}s interval)`);
}

function stopServerSlideshow() {
    if (slideshowTimer) {
        clearInterval(slideshowTimer);
        slideshowTimer = null;
    }
    isSlideshowPlaying = false;
    broadcastUpdate('slideshowState', { isPlaying: false });
    console.log('Server-side slideshow stopped');
}

function updateServerSlideshowInterval() {
    if (isSlideshowPlaying) {
        stopServerSlideshow();
        startServerSlideshow();
    }
}

// API Routes - pass broadcast function and slideshow control functions
app.use('/api/image', createImageRoutes(db, slideshowEngine, broadcastUpdate));
app.use('/api/settings', createSettingsRoutes(db, slideshowEngine, broadcastUpdate, updateServerSlideshowInterval));

// Serve static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Stats endpoint at root level
app.get('/api/stats', (req, res) => {
    try {
        const stats = db.getStats();
        res.json(stats);
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// Slideshow control endpoints (server-side authoritative)
app.get('/api/slideshow/state', (req, res) => {
    res.json({
        isPlaying: isSlideshowPlaying,
        interval: slideshowEngine.settings.interval || 10
    });
});

app.post('/api/slideshow/start', (req, res) => {
    try {
        startServerSlideshow();
        broadcastUpdate('slideshowState', { isPlaying: isSlideshowPlaying });
        res.json({ success: true, isPlaying: isSlideshowPlaying });
    } catch (error) {
        console.error('Error starting server slideshow:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/slideshow/pause', (req, res) => {
    try {
        stopServerSlideshow();
        res.json({ success: true, isPlaying: isSlideshowPlaying });
    } catch (error) {
        console.error('Error pausing server slideshow:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// SSE endpoint for real-time updates
app.get('/api/events', (req, res) => {
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    
    // Add client to set
    sseClients.add(res);
    
    // Send initial current image
    try {
        const image = slideshowEngine.getCurrentImage();
        if (image) {
            const preload = slideshowEngine.getPreloadImages(3);
            const data = JSON.stringify({
                type: 'image',
                image,
                preload,
                settings: slideshowEngine.getSettings(),
                isPlaying: isSlideshowPlaying
            });
            res.write(`data: ${data}\n\n`);
        }
    } catch (error) {
        console.error('Error sending initial image to SSE client:', error);
    }
    
    // Remove client on disconnect
    req.on('close', () => {
        sseClients.delete(res);
        res.end();
    });
});

// Convenience route: /remote -> /remote/
app.get('/remote', (req, res) => {
    res.redirect(302, '/remote/');
});

// Database reset endpoint
app.post('/api/database/reset', async (req, res) => {
    try {
        console.log('Database reset requested...');
        
        // Close current database connection
        db.close();
        
        // Delete database files
        const dbFiles = [
            dbPath,
            `${dbPath}-shm`,
            `${dbPath}-wal`
        ];
        
        for (const file of dbFiles) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
                console.log(`Deleted: ${file}`);
            }
        }
        
        // Reinitialize database (creates new one)
        const DatabaseManager = require('./database/db');
        const newDb = new DatabaseManager(dbPath);
        Object.assign(db, newDb); // Replace old db instance
        
        // Re-index photos
        console.log('Re-indexing photos...');
        await scanner.scanDirectory(photoDir, { forceReindex: true });
        
        // Refresh slideshow
        slideshowEngine.refreshImageList();
        
        const stats = db.getStats();
        console.log('Database reset complete!');
        
        res.json({
            success: true,
            message: 'Database reset and re-indexed successfully',
            stats
        });
    } catch (error) {
        console.error('Error resetting database:', error);
        res.status(500).json({ error: 'Failed to reset database', details: error.message });
    }
});

// Start server
const PORT = config.serverPort || 3000;

async function startServer() {
    // Check if photo directory exists
    if (!fs.existsSync(photoDir)) {
        console.warn(`Warning: Photo directory does not exist: ${photoDir}`);
        if (!devMode) {
            console.error('Please configure a valid photo directory in config.json');
            process.exit(1);
        }
    }

    // Run initial indexing if requested or if database is empty
    const imageCount = db.getImagesCount();
    
    if (forceIndex || imageCount === 0) {
        console.log('\n=== Starting Initial Indexing ===');
        if (fs.existsSync(photoDir)) {
            await scanner.scanDirectory(photoDir, { forceReindex: forceIndex });
            slideshowEngine.refreshImageList();
        } else {
            console.log('Skipping indexing - photo directory does not exist');
        }
    } else {
        console.log(`Database contains ${imageCount} images. Use --index to force re-indexing.`);
    }

    // Start file watcher
    if (fs.existsSync(photoDir) && !forceIndex) {
        const watcher = new FileWatcher(db, scanner, config);
        watcher.start(photoDir);

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\nShutting down...');
            stopServerSlideshow();
            watcher.stop();
            // Close all SSE connections
            sseClients.forEach(client => client.end());
            sseClients.clear();
            db.close();
            process.exit(0);
        });

        process.on('SIGTERM', () => {
            console.log('\nShutting down...');
            stopServerSlideshow();
            watcher.stop();
            // Close all SSE connections
            sseClients.forEach(client => client.end());
            sseClients.clear();
            db.close();
            process.exit(0);
        });
    }

    // Start HTTP server
    app.listen(PORT, () => {
        console.log(`\n=== Picture Frame Server Running ===`);
        console.log(`URL: http://localhost:${PORT}`);
        console.log(`Photo Directory: ${photoDir}`);
        console.log(`Database: ${dbPath}`);
        console.log(`Images: ${db.getImagesCount()}`);
        console.log(`Slideshow Mode: ${slideshowEngine.settings.mode}`);
        console.log(`=====================================\n`);

        if (forceIndex) {
            console.log('Indexing complete. Server will now exit.');
            console.log('Start normally with: npm start');
            process.exit(0);
        }
        
        // Start server-side slideshow
        startServerSlideshow();
        
        // Start background geolocation lookup
        if (!forceIndex) {
            startGeolocationLookup();
        }
    });
    
    // Background geolocation lookup
    async function startGeolocationLookup() {
        // Wait a bit to let server fully start
        setTimeout(async () => {
            await processGeolocationBatch();
        }, 5000); // Wait 5 seconds after startup
    }
    
    // Process geolocation in batches continuously
    async function processGeolocationBatch() {
        const batchSize = 100;
        const imagesToLookup = db.getImagesNeedingLocation(batchSize);
        
        if (imagesToLookup.length > 0) {
            const remaining = db.getImagesNeedingLocation(10000).length; // Get total count
            console.log(`Starting background location lookup: ${imagesToLookup.length} images (${remaining} total remaining)...`);
            
            await geoService.batchLookup(imagesToLookup, (id, location) => {
                return db.updateImage(id, location);
            });
            
            // Check if more images need processing
            const stillRemaining = db.getImagesNeedingLocation(1).length;
            if (stillRemaining > 0) {
                console.log(`Scheduling next batch in 10 seconds...`);
                setTimeout(() => processGeolocationBatch(), 10000); // Wait 10 seconds between batches
            } else {
                console.log(`✓ All location lookups complete!`);
            }
        }
    }
}

startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});


