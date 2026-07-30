/**
 * Perceptual hashing (dHash) for near-duplicate image detection.
 *
 * dHash: downscale to 9x8 grayscale, then for each row compare each pixel to
 * its right neighbor (8 comparisons/row * 8 rows = 64 bits). Robust to scaling,
 * compression, and minor color shifts; NOT rotation-invariant.
 */
const sharp = require('sharp');

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/**
 * Compute the 64-bit dHash of an image, returned as 16 lowercase hex chars.
 * Rejects if the image cannot be decoded.
 */
async function dHash(imagePath) {
    const buf = await sharp(imagePath)
        .greyscale()
        .resize(HASH_WIDTH, HASH_HEIGHT, { fit: 'fill' })
        .raw()
        .toBuffer(); // length = 72, one byte per pixel

    let bits = 0n;
    for (let row = 0; row < HASH_HEIGHT; row++) {
        for (let col = 0; col < HASH_WIDTH - 1; col++) {
            const left = buf[row * HASH_WIDTH + col];
            const right = buf[row * HASH_WIDTH + col + 1];
            bits = (bits << 1n) | (left > right ? 1n : 0n);
        }
    }
    return bits.toString(16).padStart(16, '0');
}

/** Population count of a 32-bit integer (SWAR). */
function popcount32(n) {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Hamming distance (number of differing bits) between two 16-hex-char hashes.
 * Uses integer math on two 32-bit halves — ~20-50x faster than BigInt at scale.
 */
function hammingDistance(hexA, hexB) {
    const aHi = parseInt(hexA.slice(0, 8), 16), aLo = parseInt(hexA.slice(8, 16), 16);
    const bHi = parseInt(hexB.slice(0, 8), 16), bLo = parseInt(hexB.slice(8, 16), 16);
    return popcount32((aHi ^ bHi) >>> 0) + popcount32((aLo ^ bLo) >>> 0);
}

module.exports = { dHash, hammingDistance, HASH_WIDTH, HASH_HEIGHT };
