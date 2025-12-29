const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

class ImageRotationService {
    /**
     * Rotate an image file by a specified angle
     * @param {string} imagePath - Path to the image file
     * @param {number} degrees - Rotation angle (90, 180, 270)
     * @returns {Promise<void>}
     */
    async rotateImage(imagePath, degrees) {
        // Validate rotation angle
        if (![90, 180, 270, -90].includes(degrees)) {
            throw new Error('Rotation must be 90, 180, 270, or -90 degrees');
        }

        // Resolve full path
        const fullPath = path.resolve(imagePath);
        
        // Check if file exists
        if (!fs.existsSync(fullPath)) {
            throw new Error(`Image file not found: ${fullPath}`);
        }

        // Create backup filename
        const ext = path.extname(fullPath);
        const baseName = path.basename(fullPath, ext);
        const dirName = path.dirname(fullPath);
        const backupPath = path.join(dirName, `.${baseName}_backup${ext}`);
        
        try {
            // Create backup of original file
            await fs.promises.copyFile(fullPath, backupPath);
            
            // Read image and rotate
            const image = sharp(fullPath);
            const metadata = await image.metadata();
            
            // Rotate the image
            await image
                .rotate(degrees)
                .toFile(fullPath + '.tmp');
            
            // Replace original with rotated version
            await fs.promises.rename(fullPath + '.tmp', fullPath);
            
            // Delete backup after successful rotation
            await fs.promises.unlink(backupPath);
            
            console.log(`Rotated ${imagePath} by ${degrees} degrees`);
            
            return {
                success: true,
                originalSize: `${metadata.width}x${metadata.height}`,
                rotated: degrees
            };
        } catch (error) {
            // If rotation failed, restore from backup
            if (fs.existsSync(backupPath)) {
                await fs.promises.copyFile(backupPath, fullPath);
                await fs.promises.unlink(backupPath);
            }
            
            // Clean up temp file if it exists
            if (fs.existsSync(fullPath + '.tmp')) {
                await fs.promises.unlink(fullPath + '.tmp');
            }
            
            throw new Error(`Failed to rotate image: ${error.message}`);
        }
    }

    /**
     * Rotate left (counter-clockwise 90 degrees)
     * @param {string} imagePath
     * @returns {Promise<void>}
     */
    async rotateLeft(imagePath) {
        return await this.rotateImage(imagePath, -90);
    }

    /**
     * Rotate right (clockwise 90 degrees)
     * @param {string} imagePath
     * @returns {Promise<void>}
     */
    async rotateRight(imagePath) {
        return await this.rotateImage(imagePath, 90);
    }

    /**
     * Rotate 180 degrees
     * @param {string} imagePath
     * @returns {Promise<void>}
     */
    async rotate180(imagePath) {
        return await this.rotateImage(imagePath, 180);
    }
}

module.exports = ImageRotationService;

