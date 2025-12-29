const fs = require('fs');
const path = require('path');
const MetadataExtractor = require('./metadata');

class DirectoryScanner {
    constructor(db, config) {
        this.db = db;
        this.config = config;
        this.metadataExtractor = new MetadataExtractor();
        this.stats = {
            total: 0,
            processed: 0,
            skipped: 0,
            errors: 0
        };
    }

    async scanDirectory(directoryPath, options = {}) {
        const { forceReindex = false, cleanupOrphaned = true } = options;
        
        console.log(`Starting scan of: ${directoryPath}`);
        console.log(`Force reindex: ${forceReindex}`);

        if (!fs.existsSync(directoryPath)) {
            throw new Error(`Directory does not exist: ${directoryPath}`);
        }
        
        // Clean up orphaned entries (files in DB but not on filesystem)
        if (cleanupOrphaned) {
            console.log('Checking for orphaned database entries...');
            const removed = this.db.cleanupOrphanedEntries((filepath) => {
                const fullPath = path.resolve(filepath);
                return fs.existsSync(fullPath);
            });
            if (removed > 0) {
                console.log(`Cleaned up ${removed} orphaned database entries`);
            }
        }

        this.stats = { total: 0, processed: 0, skipped: 0, errors: 0 };
        const startTime = Date.now();

        // First, collect all image files
        const imageFiles = this.collectImageFiles(directoryPath);
        this.stats.total = imageFiles.length;

        console.log(`Found ${this.stats.total} image files`);

        // Process in batches
        const batchSize = this.config.indexing?.batchSize || 100;
        const batches = this.createBatches(imageFiles, batchSize);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            await this.processBatch(batch, forceReindex);

            // Log progress
            if ((i + 1) % 5 === 0 || i === batches.length - 1) {
                const progress = ((i + 1) / batches.length * 100).toFixed(1);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`Progress: ${progress}% (${this.stats.processed + this.stats.skipped}/${this.stats.total}) - ${elapsed}s elapsed`);
            }
        }

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log('\n=== Scan Complete ===');
        console.log(`Total files: ${this.stats.total}`);
        console.log(`Processed: ${this.stats.processed}`);
        console.log(`Skipped: ${this.stats.skipped}`);
        console.log(`Errors: ${this.stats.errors}`);
        console.log(`Time: ${totalTime}s`);
        console.log(`Rate: ${(this.stats.total / parseFloat(totalTime)).toFixed(1)} files/sec`);

        return this.stats;
    }

    collectImageFiles(dir, fileList = []) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
                continue;
            }

            if (entry.isDirectory()) {
                this.collectImageFiles(fullPath, fileList);
            } else if (entry.isFile()) {
                if (this.metadataExtractor.isImageFile(fullPath, this.config.fileExtensions)) {
                    fileList.push(fullPath);
                }
            }
        }

        return fileList;
    }

    createBatches(array, size) {
        const batches = [];
        for (let i = 0; i < array.length; i += size) {
            batches.push(array.slice(i, i + size));
        }
        return batches;
    }

    async processBatch(files, forceReindex) {
        const batch = [];

        for (const filePath of files) {
            try {
                // Check if file already indexed and hasn't changed
                if (!forceReindex) {
                    const existing = this.db.getImageByPath(filePath);
                    if (existing) {
                        const currentMtime = fs.statSync(filePath).mtimeMs;
                        if (existing.file_modified === currentMtime) {
                            this.stats.skipped++;
                            continue;
                        }
                    }
                }

                // Extract metadata
                const metadata = await this.metadataExtractor.extractMetadata(filePath);
                batch.push(metadata);
                this.stats.processed++;

            } catch (error) {
                console.error(`Error processing ${filePath}:`, error.message);
                this.stats.errors++;
            }
        }

        // Insert batch into database
        if (batch.length > 0) {
            try {
                this.db.insertImagesBatch(batch);
            } catch (error) {
                console.error('Error inserting batch:', error.message);
                // Try inserting one by one as fallback
                for (const item of batch) {
                    try {
                        this.db.insertImage(item);
                    } catch (err) {
                        console.error(`Error inserting ${item.filepath}:`, err.message);
                        this.stats.errors++;
                    }
                }
            }
        }
    }

    async indexSingleFile(filePath) {
        try {
            if (!this.metadataExtractor.isImageFile(filePath, this.config.fileExtensions)) {
                return false;
            }

            const metadata = await this.metadataExtractor.extractMetadata(filePath);
            this.db.insertImage(metadata);
            console.log(`Indexed: ${filePath}`);
            return true;
        } catch (error) {
            console.error(`Error indexing ${filePath}:`, error.message);
            return false;
        }
    }

    removeFromIndex(filePath) {
        try {
            const deleted = this.db.deleteImageByPath(filePath);
            if (deleted) {
                console.log(`Removed from index: ${filePath}`);
            } else {
                console.log(`File not in index: ${filePath}`);
            }
            return deleted;
        } catch (error) {
            console.error(`Error removing ${filePath}:`, error.message);
            return false;
        }
    }
}

module.exports = DirectoryScanner;


