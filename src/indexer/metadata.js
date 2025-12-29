const ExifReader = require('exifreader');
const fs = require('fs');
const path = require('path');

class MetadataExtractor {
    constructor() {
        this.supportedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'];
    }

    async extractMetadata(filePath) {
        try {
            const buffer = fs.readFileSync(filePath);
            const tags = ExifReader.load(buffer, { expanded: true });

            const metadata = {
                filepath: filePath,
                filename: path.basename(filePath),
                fileModified: fs.statSync(filePath).mtimeMs,
                dateTaken: this.getDateTaken(tags),
                dateAdded: Date.now(),
                latitude: this.getLatitude(tags),
                longitude: this.getLongitude(tags),
                width: this.getWidth(tags),
                height: this.getHeight(tags),
                orientation: this.getOrientation(tags),
                cameraModel: this.getCameraModel(tags),
                cameraMake: this.getCameraMake(tags),
                tags: this.generateTags(tags, filePath)
            };

            return metadata;
        } catch (error) {
            console.warn(`Failed to extract metadata from ${filePath}:`, error.message);
            // Return basic metadata even if EXIF extraction fails
            return {
                filepath: filePath,
                filename: path.basename(filePath),
                fileModified: fs.statSync(filePath).mtimeMs,
                dateAdded: Date.now(),
                tags: this.generateBasicTags(filePath)
            };
        }
    }

    getDateTaken(tags) {
        try {
            // Try multiple EXIF date fields
            if (tags.exif && tags.exif.DateTimeOriginal) {
                return this.parseExifDate(tags.exif.DateTimeOriginal.description);
            }
            if (tags.exif && tags.exif.DateTime) {
                return this.parseExifDate(tags.exif.DateTime.description);
            }
            if (tags.exif && tags.exif.DateTimeDigitized) {
                return this.parseExifDate(tags.exif.DateTimeDigitized.description);
            }
        } catch (error) {
            // Ignore parsing errors
        }
        return null;
    }

    parseExifDate(dateStr) {
        // EXIF date format: "YYYY:MM:DD HH:MM:SS"
        if (!dateStr) return null;
        
        try {
            const parts = dateStr.split(' ');
            if (parts.length !== 2) return null;
            
            const datePart = parts[0].replace(/:/g, '-');
            const timePart = parts[1];
            const isoDate = `${datePart}T${timePart}`;
            
            return new Date(isoDate).toISOString();
        } catch (error) {
            return null;
        }
    }

    getLatitude(tags) {
        try {
            if (tags.gps && tags.gps.Latitude !== undefined) {
                return tags.gps.Latitude;
            }
        } catch (error) {
            // Ignore
        }
        return null;
    }

    getLongitude(tags) {
        try {
            if (tags.gps && tags.gps.Longitude !== undefined) {
                return tags.gps.Longitude;
            }
        } catch (error) {
            // Ignore
        }
        return null;
    }

    getWidth(tags) {
        try {
            if (tags.file && tags.file['Image Width']) {
                return tags.file['Image Width'].value;
            }
            if (tags.exif && tags.exif.PixelXDimension) {
                return tags.exif.PixelXDimension.value;
            }
        } catch (error) {
            // Ignore
        }
        return null;
    }

    getHeight(tags) {
        try {
            if (tags.file && tags.file['Image Height']) {
                return tags.file['Image Height'].value;
            }
            if (tags.exif && tags.exif.PixelYDimension) {
                return tags.exif.PixelYDimension.value;
            }
        } catch (error) {
            // Ignore
        }
        return null;
    }

    getOrientation(tags) {
        try {
            if (tags.exif && tags.exif.Orientation) {
                return tags.exif.Orientation.value;
            }
        } catch (error) {
            // Ignore
        }
        return 1; // Default orientation
    }

    getCameraModel(tags) {
        try {
            if (tags.exif && tags.exif.Model) {
                return tags.exif.Model.description;
            }
        } catch (error) {
            // Ignore
        }
        return null;
    }

    getCameraMake(tags) {
        try {
            if (tags.exif && tags.exif.Make) {
                return tags.exif.Make.description;
            }
        } catch (error) {
            // Ignore
        }
        return null;
    }

    generateTags(tags, filePath) {
        const tagList = [];

        // Add year and month tags
        const dateTaken = this.getDateTaken(tags);
        if (dateTaken) {
            const date = new Date(dateTaken);
            tagList.push(`year:${date.getFullYear()}`);
            tagList.push(`month:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
        }

        // Add location tag if GPS available
        if (this.getLatitude(tags) !== null && this.getLongitude(tags) !== null) {
            tagList.push('geotagged');
        }

        // Add camera tag if available
        const cameraModel = this.getCameraModel(tags);
        if (cameraModel) {
            tagList.push(`camera:${cameraModel.toLowerCase().replace(/\s+/g, '-')}`);
        }

        // Add file extension
        const ext = path.extname(filePath).toLowerCase().substring(1);
        tagList.push(`type:${ext}`);

        return tagList;
    }

    generateBasicTags(filePath) {
        const tagList = [];
        const ext = path.extname(filePath).toLowerCase().substring(1);
        tagList.push(`type:${ext}`);
        return tagList;
    }

    isImageFile(filePath, extensions = this.supportedExtensions) {
        const ext = path.extname(filePath).toLowerCase();
        return extensions.includes(ext);
    }
}

module.exports = MetadataExtractor;


