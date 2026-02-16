#!/usr/bin/env node
/**
 * Performance benchmark script for Picture Frame on Raspberry Pi
 *
 * Run: node scripts/benchmark.js [--photo-dir /path/to/photos]
 *
 * Benchmarks:
 * - Metadata extraction (sync I/O - known bottleneck)
 * - Database queries (getAllImages, ORDER BY RANDOM, etc.)
 * - Orphan cleanup simulation
 * - Color extraction logic (rgbToHsl, findDominantColors - CPU only)
 *
 * Use this to establish baselines and verify optimizations.
 */

const fs = require('fs');
const path = require('path');

// Load config (~/picframe-config.json or config.json)
const { loadConfig } = require('../src/config');
const config = loadConfig();

const Database = require('better-sqlite3');
const ExifReader = require('exifreader');
const MetadataExtractor = require('../src/indexer/metadata');

// --- Helpers ---
function formatMs(ms) {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    if (ms >= 1) return `${ms.toFixed(1)}ms`;
    return `${(ms * 1000).toFixed(1)}µs`;
}

function run(name, fn, iterations = 1) {
    const times = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        fn();
        times.push(performance.now() - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    console.log(`  ${name}: avg=${formatMs(avg)}, min=${formatMs(min)}, max=${formatMs(max)} (n=${iterations})`);
    return avg;
}

async function runAsync(name, fn, iterations = 1) {
    const times = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await fn();
        times.push(performance.now() - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    console.log(`  ${name}: avg=${formatMs(avg)}, min=${formatMs(min)}, max=${formatMs(max)} (n=${iterations})`);
    return avg;
}

// --- Extract color logic for CPU benchmark (from app.js) ---
function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    return [h, s, l];
}

function findDominantColors(colors, count) {
    if (colors.length === 0) return [];
    colors.sort((a, b) => (b.colorfulness || 0) - (a.colorfulness || 0));
    const dominant = [];
    const usedHues = new Set();
    const hueTolerance = 0.1;
    for (const color of colors) {
        if (dominant.length >= count) break;
        const hue = color.hsl[0];
        let isSimilar = false;
        for (const usedHue of usedHues) {
            if (Math.abs(hue - usedHue) < hueTolerance) {
                isSimilar = true;
                break;
            }
        }
        if (!isSimilar) {
            usedHues.add(hue);
            dominant.push({ r: color.r, g: color.g, b: color.b });
        }
    }
    return dominant;
}

// Simulate color extraction workload (no canvas - just the CPU-heavy parts)
function simulateColorExtraction(pixelCount, sampleRate = 5, colorCount = 3) {
    const colors = [];
    for (let i = 0; i < pixelCount; i += 4 * sampleRate) {
        const r = Math.floor(Math.random() * 256);
        const g = Math.floor(Math.random() * 256);
        const b = Math.floor(Math.random() * 256);
        const hsl = rgbToHsl(r, g, b);
        if (hsl[2] >= 0.15 && hsl[2] <= 0.9) {
            colors.push({ r, g, b, hsl, colorfulness: hsl[1] * hsl[2] });
        }
    }
    return findDominantColors(colors, colorCount);
}

// --- Benchmarks ---
async function benchmarkMetadataExtraction(photoDir) {
    console.log('\n=== Metadata Extraction (sync I/O) ===');
    if (!fs.existsSync(photoDir)) {
        console.log('  Skipped: photo directory not found');
        return;
    }

    const extractor = new MetadataExtractor();
    const extensions = config.fileExtensions || ['.jpg', '.jpeg', '.png'];
    let files = [];

    function collect(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && !e.name.startsWith('.')) collect(full);
            else if (e.isFile()) {
                const ext = path.extname(full).toLowerCase();
                if (extensions.includes(ext)) files.push(full);
            }
        }
    }
    collect(photoDir);
    files = files.slice(0, 50); // Limit for benchmark

    if (files.length === 0) {
        console.log('  Skipped: no image files found');
        return;
    }

    // Single file
    await runAsync('Single file metadata', () => extractor.extractMetadata(files[0]), 5);

    // Batch of 10 (simulates scanner)
    await runAsync('Batch of 10 files', async () => {
        for (const f of files.slice(0, 10)) {
            await extractor.extractMetadata(f);
        }
    }, 3);
}

async function benchmarkDatabase(dbPath) {
    console.log('\n=== Database Queries ===');
    if (!fs.existsSync(dbPath)) {
        console.log('  Skipped: database not found. Run with --index first.');
        return;
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    const count = db.prepare('SELECT COUNT(*) as c FROM images WHERE is_deleted = 0').get().c;
    console.log(`  Images in DB: ${count}`);

    if (count === 0) {
        db.close();
        return;
    }

    // getAllImages - date order (uses index)
    run('getAllImages ORDER BY date (indexed)', () => {
        db.prepare('SELECT * FROM images WHERE is_deleted = 0 ORDER BY date_taken DESC LIMIT 100').all();
    }, 20);

    // getAllImages - RANDOM (full scan + sort)
    run('getAllImages ORDER BY RANDOM() (slow)', () => {
        db.prepare('SELECT * FROM images WHERE is_deleted = 0 ORDER BY RANDOM() LIMIT 1').get();
    }, 10);

    // getImageByPath (indexed)
    const samplePath = db.prepare('SELECT filepath FROM images LIMIT 1').get().filepath;
    run('getImageByPath (indexed)', () => {
        db.prepare('SELECT * FROM images WHERE filepath = ?').get(samplePath);
    }, 100);

    // Orphan cleanup simulation - full scan + exists check
    run('Orphan check (all paths + existsSync)', () => {
        const rows = db.prepare('SELECT id, filepath FROM images WHERE is_deleted = 0').all();
        let checked = 0;
        for (const row of rows.slice(0, 100)) {
            if (fs.existsSync(row.filepath)) checked++;
        }
    }, 3);

    db.close();
}

function benchmarkColorExtraction() {
    console.log('\n=== Color Extraction (CPU simulation) ===');
    console.log('  Simulates rgbToHsl + findDominantColors without canvas');

    // 200x200 image = 40,000 pixels, sample every 5th = 8,000 iterations
    const pixels200 = 200 * 200 * 4;
    run('200x200 canvas equiv (sampleRate=5)', () => simulateColorExtraction(pixels200, 5), 20);

    // 100x100 = 10,000 pixels
    const pixels100 = 100 * 100 * 4;
    run('100x100 canvas equiv (sampleRate=5)', () => simulateColorExtraction(pixels100, 5), 20);

    // 200x200 with higher sample rate (fewer iterations)
    run('200x200 canvas equiv (sampleRate=15)', () => simulateColorExtraction(pixels200, 15), 20);
}

function benchmarkSmartWeights(imageCount = 5000) {
    console.log('\n=== Smart Mode Weight Calculation ===');
    console.log(`  Simulates weight calc for ${imageCount} images`);

    const fakeImages = Array.from({ length: imageCount }, (_, i) => ({
        id: i,
        is_favorite: i % 10 === 0 ? 1 : 0,
        date_taken: new Date(Date.now() - i * 86400000).toISOString()
    }));

    const today = new Date();
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const todayMonth = today.getMonth();
    const todayDate = today.getDate();

    run('Smart weights + weighted random', () => {
        const weights = fakeImages.map((img) => {
            let weight = 1;
            if (img.is_favorite) weight *= 3;
            if (img.date_taken) {
                const photoDate = new Date(img.date_taken);
                if (photoDate > oneMonthAgo) weight *= 2;
                if (photoDate.getMonth() === todayMonth && photoDate.getDate() === todayDate) weight *= 10;
            }
            return weight;
        });
        const total = weights.reduce((s, w) => s + w, 0);
        let r = Math.random() * total;
        for (let i = 0; i < weights.length; i++) {
            r -= weights[i];
            if (r <= 0) return i;
        }
        return 0;
    }, 50);
}

// --- Main ---
async function main() {
    const args = process.argv.slice(2);
    const photoDir = args.includes('--photo-dir')
        ? args[args.indexOf('--photo-dir') + 1]
        : config.photoDirectory;
    const dbPath = path.resolve(__dirname, '..', config.databasePath || './data/pictureframe.db');

    console.log('Picture Frame Performance Benchmark');
    console.log('====================================');
    console.log(`Photo dir: ${photoDir}`);
    console.log(`DB path:  ${dbPath}`);

    benchmarkColorExtraction();
    benchmarkSmartWeights(5000);
    await benchmarkDatabase(dbPath);
    await benchmarkMetadataExtraction(photoDir);

    console.log('\nDone. See PERFORMANCE_AUDIT.md for optimization recommendations.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
