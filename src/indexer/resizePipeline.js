/**
 * Resize pipeline: resize images to 4K, output to {photoDirectory}/resized/{year}/,
 * update DB, delete original.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { spawn } = require('child_process');
const os = require('os');

const RESIZED_SUBDIR = 'resized';

function getYearFromMetadata(metadata, filePath) {
    const dateStr = metadata?.dateTaken || metadata?.date_taken;
    if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
            return String(d.getFullYear());
        }
    }
    try {
        const stat = fs.statSync(filePath);
        return String(new Date(stat.mtimeMs).getFullYear());
    } catch {
        return 'unknown';
    }
}

function shortHash(str) {
    return crypto.createHash('sha256').update(str).digest('hex').substring(0, 8);
}

function getOutputPath(photoDirectory, originalPath, metadata, ext) {
    const year = getYearFromMetadata(metadata, originalPath);
    const baseName = path.basename(originalPath, path.extname(originalPath));
    const hash = shortHash(path.resolve(originalPath));
    const outputDir = path.join(photoDirectory, RESIZED_SUBDIR, year);
    let outputPath = path.join(outputDir, `${baseName}_${hash}${ext}`);

    let counter = 0;
    while (fs.existsSync(outputPath)) {
        counter++;
        outputPath = path.join(outputDir, `${baseName}_${hash}_${counter}${ext}`);
    }
    return outputPath;
}

function isHeif(ext) {
    return ['.heic', '.heif'].includes(ext.toLowerCase());
}

function heifToJpegSync(heifPath, outputPath, quality) {
    return new Promise((resolve, reject) => {
        const q = quality !== undefined ? quality.toString() : '90';
        const proc = spawn('heif-convert', ['-q', q, heifPath, outputPath], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`heif-convert failed: ${stderr}`));
        });
        proc.on('error', reject);
    });
}

async function resizeWithSharp(inputPath, outputPath, config) {
    let pipeline = sharp(inputPath);
    const meta = await pipeline.metadata();

    if (meta.orientation && meta.orientation > 1) {
        pipeline = pipeline.rotate();
    }

    const resizeConfig = config?.resize || {};
    const maxWidth = resizeConfig.maxWidth ?? 3840;
    const maxHeight = resizeConfig.maxHeight ?? 2160;
    const quality = resizeConfig.quality;
    const format = resizeConfig.format;

    pipeline = pipeline.resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
    });

    const outputFormat = format || meta.format || 'jpeg';
    const formatOpts = (outputFormat === 'jpeg' || outputFormat === 'jpg')
        ? (quality !== undefined ? { quality } : {})
        : {};

    // Preserve EXIF and other metadata in the resized file. If we applied rotation,
    // set output orientation to 1 so EXIF matches the already-rotated pixels.
    const appliedRotation = meta.orientation && meta.orientation > 1;
    const metadataOpts = appliedRotation ? { orientation: 1 } : {};
    await pipeline.toFormat(outputFormat, formatOpts).withMetadata(metadataOpts).toFile(outputPath);
}

/**
 * Resize a single image. Handles HEIF via heif-convert when Sharp fails.
 * @param {string} originalPath - Full path to original file
 * @param {object} metadata - Extracted metadata (dateTaken, etc.)
 * @param {object} config - App config with resize options
 * @returns {Promise<{outputPath: string, filename: string, fileModified: number}>}
 */
async function resizeImage(originalPath, metadata, config) {
    const ext = path.extname(originalPath).toLowerCase();
    const photoDir = path.resolve(config.photoDirectory);
    const isHeifFile = isHeif(ext);

    const outputExt = isHeifFile ? '.jpg' : ext;
    const outputPath = getOutputPath(photoDir, originalPath, metadata, outputExt);

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    let tempHeifJpeg = null;
    let inputForSharp = originalPath;

    if (isHeifFile) {
        try {
            await resizeWithSharp(originalPath, outputPath, config);
        } catch (sharpErr) {
            tempHeifJpeg = path.join(os.tmpdir(), `heif_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
            await heifToJpegSync(originalPath, tempHeifJpeg, config.resize?.quality);
            inputForSharp = tempHeifJpeg;
            await resizeWithSharp(tempHeifJpeg, outputPath, config);
        }
    } else {
        await resizeWithSharp(originalPath, outputPath, config);
    }

    if (tempHeifJpeg && fs.existsSync(tempHeifJpeg)) {
        try {
            fs.unlinkSync(tempHeifJpeg);
        } catch (_) {}
    }

    const stat = fs.statSync(outputPath);
    let width = null, height = null;
    try {
        const outMeta = await sharp(outputPath).metadata();
        width = outMeta.width;
        height = outMeta.height;
    } catch (_) {}

    return {
        outputPath,
        filename: path.basename(outputPath),
        fileModified: stat.mtimeMs,
        width,
        height
    };
}

/**
 * Check if a filepath is under the resized directory.
 */
function isResizedPath(filepath, photoDirectory) {
    const resolved = path.resolve(photoDirectory, RESIZED_SUBDIR);
    const fileResolved = path.resolve(filepath);
    return fileResolved.startsWith(resolved + path.sep) || fileResolved === resolved;
}

/**
 * Check if a directory path should be excluded from scanning (resized folder).
 */
function shouldExcludeFromScan(dirPath, photoDirectory) {
    const resolved = path.resolve(photoDirectory, RESIZED_SUBDIR);
    const dirResolved = path.resolve(dirPath);
    return dirResolved === resolved || dirResolved.startsWith(resolved + path.sep);
}

module.exports = {
    resizeImage,
    isResizedPath,
    shouldExcludeFromScan,
    RESIZED_SUBDIR,
    getYearFromMetadata,
    getOutputPath
};
