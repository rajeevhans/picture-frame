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

/**
 * Hamming distance (number of differing bits) between two 16-hex-char hashes.
 */
function hammingDistance(hexA, hexB) {
    let x = (BigInt('0x' + hexA) ^ BigInt('0x' + hexB));
    let count = 0;
    while (x > 0n) {
        count += Number(x & 1n);
        x >>= 1n;
    }
    return count;
}

module.exports = { dHash, hammingDistance, HASH_WIDTH, HASH_HEIGHT };
