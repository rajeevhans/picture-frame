/**
 * HEIF/HEIC conversion utilities.
 *
 * Sharp can handle many HEIF files, but some compression formats fail.
 * This module wraps the `heif-convert` CLI tool (from libheif) as a
 * reliable fallback / primary converter, and exposes a shared extension
 * check so callers don't repeat the inline array.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HEIF_EXTENSIONS = ['.heic', '.heif'];
const DEFAULT_QUALITY = 90;

function isHeif(extOrPath) {
    const ext = path.extname(extOrPath).toLowerCase() || extOrPath.toLowerCase();
    return HEIF_EXTENSIONS.includes(ext);
}

/**
 * Convert a HEIF file to a JPEG file on disk.
 *
 * @param {string} inputPath - Absolute path to the HEIF source.
 * @param {string} outputPath - Absolute path to write the JPEG to.
 * @param {number} [quality=90] - JPEG quality (1-100).
 * @returns {Promise<void>} Resolves when heif-convert exits with code 0.
 */
function convertHeifToFile(inputPath, outputPath, quality = DEFAULT_QUALITY) {
    return new Promise((resolve, reject) => {
        const q = String(quality);
        const proc = spawn('heif-convert', ['-q', q, inputPath, outputPath], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`heif-convert failed with code ${code}: ${stderr}`));
        });

        proc.on('error', (spawnErr) => {
            reject(new Error(`Failed to spawn heif-convert: ${spawnErr.message}. Make sure libheif is installed.`));
        });
    });
}

/**
 * Convert a HEIF file and stream the resulting JPEG bytes to a writable stream
 * (typically an HTTP response). Uses a temporary file internally because
 * heif-convert requires a filesystem output; the temp file is cleaned up
 * after streaming, even on error.
 *
 * @param {string} inputPath - Absolute path to the HEIF source.
 * @param {NodeJS.WritableStream} outputStream - Destination stream.
 * @param {number} [quality=90] - JPEG quality (1-100).
 * @returns {Promise<void>} Resolves once the temp file has been streamed.
 */
async function streamHeifAsJpeg(inputPath, outputStream, quality = DEFAULT_QUALITY) {
    const tempFile = path.join(
        os.tmpdir(),
        `heif_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`
    );

    const cleanup = async () => {
        try {
            await fs.promises.unlink(tempFile);
        } catch (_) {
            // ignore cleanup errors
        }
    };

    try {
        await convertHeifToFile(inputPath, tempFile, quality);
    } catch (err) {
        await cleanup();
        throw err;
    }

    return new Promise((resolve, reject) => {
        const fileStream = fs.createReadStream(tempFile);
        // Default pipe() ends the destination stream when the source ends —
        // for HTTP responses this signals request completion, which is what
        // the original implementation relied on.
        fileStream.pipe(outputStream);
        fileStream.on('end', async () => {
            await cleanup();
            resolve();
        });
        fileStream.on('error', async (err) => {
            await cleanup();
            reject(err);
        });
    });
}

/**
 * Platform-appropriate install command for libheif (for error messages).
 */
function libheifInstallHint() {
    return process.platform === 'darwin'
        ? 'brew install libheif'
        : 'sudo apt-get install libheif-dev libde265-dev libx265-dev';
}

module.exports = {
    HEIF_EXTENSIONS,
    DEFAULT_QUALITY,
    isHeif,
    convertHeifToFile,
    streamHeifAsJpeg,
    libheifInstallHint
};
