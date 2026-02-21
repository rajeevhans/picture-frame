#!/usr/bin/env node
/**
 * Resize all images in DB that are not yet in resized/ to 4K.
 * Updates DB filepath, deletes originals.
 * Run: npm run resize
 *
 * Exports runResize(db, config) for use by server (e.g. on Electron startup).
 */
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
process.chdir(projectRoot);

const { loadConfig } = require('../src/config');
const DatabaseManager = require('../src/database/db');
const { resizeImage } = require('../src/indexer/resizePipeline');

/**
 * Run resize for all images not yet in resized/. Uses existing db (does not close it).
 * @param {object} db - DatabaseManager instance
 * @param {object} config - App config
 * @returns {Promise<{processed: number, errors: number}>}
 */
async function runResize(db, config) {
    const photoDir = path.resolve(config.photoDirectory);
    const toResize = db.getImagesNotResized(photoDir);

    if (toResize.length === 0) {
        return { processed: 0, errors: 0 };
    }

    let processed = 0;
    let errors = 0;

    for (const img of toResize) {
        const originalPath = path.resolve(img.filepath);
        if (!fs.existsSync(originalPath)) {
            continue;
        }

        try {
            const metadata = {
                dateTaken: img.date_taken,
                date_taken: img.date_taken
            };
            const resized = await resizeImage(originalPath, metadata, config);

            db.updateFilePath(img.id, resized.outputPath, resized.filename, resized.fileModified);

            fs.unlinkSync(originalPath);
            processed++;
            if (processed % 50 === 0 || processed === toResize.length) {
                console.log(`Resize progress: ${processed}/${toResize.length}`);
            }
        } catch (err) {
            console.error(`Error resizing ${originalPath}:`, err.message);
            errors++;
        }
    }

    return { processed, errors };
}

async function main() {
    const config = loadConfig();
    const dbPath = path.resolve(__dirname, '..', config.databasePath);
    const photoDir = path.resolve(config.photoDirectory);

    console.log('4K Resize: processing images not yet in resized/');
    console.log('Photo directory:', photoDir);

    const db = new DatabaseManager(dbPath);
    const toResize = db.getImagesNotResized(photoDir);

    if (toResize.length === 0) {
        console.log('No images need resizing. All are already in resized/');
        db.close();
        return;
    }

    console.log(`Found ${toResize.length} images to resize`);

    const { processed, errors } = await runResize(db, config);

    console.log(`\nDone. Resized: ${processed}, Errors: ${errors}`);
    db.close();
}

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { runResize };
