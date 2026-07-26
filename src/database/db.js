const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

class DatabaseManager {
    constructor(dbPath) {
        // Ensure data directory exists
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -64000'); // 64MB cache
        this.initialize();
    }

    initialize() {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        this.db.exec(schema);

        // Migration: add artistic score columns
        try {
            this.db.exec('ALTER TABLE images ADD COLUMN artistic_score INTEGER');
        } catch (e) { /* column already exists */ }
        try {
            this.db.exec('ALTER TABLE images ADD COLUMN artistic_score_details TEXT');
        } catch (e) { /* column already exists */ }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_artistic_score ON images(artistic_score)');

        console.log('Database initialized successfully');
    }

    // Image operations
    insertImage(imageData) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO images (
                filepath, filename, file_modified, date_taken, date_added,
                latitude, longitude, location_city, location_country, width, height, orientation, rotation,
                camera_model, camera_make, is_favorite, is_deleted, tags,
                created_at, updated_at
            ) VALUES (
                @filepath, @filename, @fileModified, @dateTaken, @dateAdded,
                @latitude, @longitude, @locationCity, @locationCountry, @width, @height, @orientation, @rotation,
                @cameraModel, @cameraMake, @isFavorite, @isDeleted, @tags,
                @createdAt, @updatedAt
            )
        `);
        
        const now = Date.now();
        return stmt.run({
            filepath: imageData.filepath,
            filename: imageData.filename,
            fileModified: imageData.fileModified,
            dateTaken: imageData.dateTaken || null,
            dateAdded: imageData.dateAdded || now,
            latitude: imageData.latitude || null,
            longitude: imageData.longitude || null,
            locationCity: imageData.locationCity || null,
            locationCountry: imageData.locationCountry || null,
            width: imageData.width || null,
            height: imageData.height || null,
            orientation: imageData.orientation || 1,
            rotation: imageData.rotation || 0,
            cameraModel: imageData.cameraModel || null,
            cameraMake: imageData.cameraMake || null,
            isFavorite: imageData.isFavorite || 0,
            isDeleted: imageData.isDeleted || 0,
            tags: imageData.tags ? JSON.stringify(imageData.tags) : null,
            createdAt: now,
            updatedAt: now
        });
    }

    insertImagesBatch(images) {
        const insert = this.db.transaction((imgs) => {
            for (const img of imgs) {
                this.insertImage(img);
            }
        });
        return insert(images);
    }

    getImageById(id) {
        const stmt = this.db.prepare('SELECT * FROM images WHERE id = ? AND is_deleted = 0');
        return stmt.get(id);
    }

    getImageByPath(filepath) {
        const stmt = this.db.prepare('SELECT * FROM images WHERE filepath = ?');
        return stmt.get(filepath);
    }

    /**
     * Validates a filter SQL query. The query must be a SELECT that returns an id column.
     * @param {string} sql - The filter query (e.g. "SELECT id FROM images WHERE tags LIKE '%vacation%'")
     * @returns {{ valid: boolean, error?: string }}
     */
    validateFilterQuery(sql) {
        const trimmed = (sql || '').trim();
        if (!trimmed) {
            return { valid: true };
        }

        const upper = trimmed.toUpperCase();
        if (!upper.startsWith('SELECT')) {
            return { valid: false, error: 'Query must start with SELECT' };
        }

        const dangerous = [/^INSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /\bCREATE\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i];
        for (const re of dangerous) {
            if (re.test(trimmed)) {
                return { valid: false, error: 'Query contains forbidden keyword (only SELECT is allowed)' };
            }
        }
        if (trimmed.includes('--')) {
            return { valid: false, error: 'SQL comments (--) are not allowed' };
        }

        if (trimmed.includes(';')) {
            return { valid: false, error: 'Only a single SELECT statement is allowed' };
        }

        try {
            this.db.prepare(`SELECT * FROM (${trimmed}) LIMIT 1`).get();
        } catch (err) {
            return { valid: false, error: err.message || 'Invalid SQL syntax' };
        }

        return { valid: true };
    }

    getAllImages(options = {}) {
        let query = 'SELECT * FROM images WHERE is_deleted = 0';
        const params = [];

        if (options.favoritesOnly) {
            query += ' AND is_favorite = 1';
        }

        // Filter by custom SQL query - only include images whose id is in the result set
        // Wrap in SELECT id FROM (...) so queries returning multiple columns (e.g. SELECT *) work
        const filterSql = (options.filterSql || '').trim();
        if (filterSql) {
            query += ` AND id IN (SELECT id FROM (${filterSql}))`;
        }

        // Filter for "this day in history" - photos from today's month/day across all years
        if (options.thisDay) {
            const now = new Date();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            
            // Match photos where date_taken month and day match today
            // Format: YYYY-MM-DD, so we match on characters 6-10 (MM-DD)
            query += ` AND substr(date_taken, 6, 5) = '${month}-${day}'`;
        }

        if (options.orderBy === 'date') {
            query += ' ORDER BY date_taken DESC, date_added DESC';
        } else if (options.orderBy === 'filename') {
            query += ' ORDER BY filename ASC';
        } else if (options.orderBy === 'random') {
            query += ' ORDER BY RANDOM()';
        } else if (options.orderBy === 'artisticScore') {
            query += ' ORDER BY artistic_score IS NULL, artistic_score DESC';
        } else if (options.orderBy === 'thisday') {
            // For "this day", order by year descending (most recent years first)
            query += ' ORDER BY date_taken DESC';
        }

        if (options.limit) {
            query += ' LIMIT ?';
            params.push(options.limit);
        }

        if (options.offset) {
            query += ' OFFSET ?';
            params.push(options.offset);
        }

        const stmt = this.db.prepare(query);
        return stmt.all(...params);
    }

    getImagesCount(favoritesOnly = false, thisDay = false, filterSql = null) {
        let query = 'SELECT COUNT(*) as count FROM images WHERE is_deleted = 0';
        if (favoritesOnly) {
            query += ' AND is_favorite = 1';
        }

        const filterSqlTrimmed = (filterSql || '').trim();
        if (filterSqlTrimmed) {
            query += ` AND id IN (SELECT id FROM (${filterSqlTrimmed}))`;
        }
        
        // Filter for "this day in history"
        if (thisDay) {
            const now = new Date();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            query += ` AND substr(date_taken, 6, 5) = '${month}-${day}'`;
        }
        
        const stmt = this.db.prepare(query);
        return stmt.get().count;
    }

    updateImage(id, updates) {
        const fields = [];
        const values = {};
        
        if (updates.isFavorite !== undefined) {
            fields.push('is_favorite = @isFavorite');
            values.isFavorite = updates.isFavorite;
        }
        if (updates.isDeleted !== undefined) {
            fields.push('is_deleted = @isDeleted');
            values.isDeleted = updates.isDeleted;
        }
        if (updates.tags !== undefined) {
            fields.push('tags = @tags');
            values.tags = JSON.stringify(updates.tags);
        }
        if (updates.locationCity !== undefined) {
            fields.push('location_city = @locationCity');
            values.locationCity = updates.locationCity;
        }
        if (updates.locationCountry !== undefined) {
            fields.push('location_country = @locationCountry');
            values.locationCountry = updates.locationCountry;
        }
        if (updates.rotation !== undefined) {
            fields.push('rotation = @rotation');
            values.rotation = updates.rotation;
        }
        if (updates.artisticScore !== undefined) {
            fields.push('artistic_score = @artisticScore');
            values.artisticScore = updates.artisticScore;
        }
        if (updates.artisticScoreDetails !== undefined) {
            fields.push('artistic_score_details = @artisticScoreDetails');
            values.artisticScoreDetails = typeof updates.artisticScoreDetails === 'string'
                ? updates.artisticScoreDetails
                : JSON.stringify(updates.artisticScoreDetails);
        }

        fields.push('updated_at = @updatedAt');
        values.updatedAt = Date.now();
        values.id = id;

        const query = `UPDATE images SET ${fields.join(', ')} WHERE id = @id`;
        const stmt = this.db.prepare(query);
        return stmt.run(values);
    }
    
    setRotation(id, rotation) {
        const stmt = this.db.prepare('UPDATE images SET rotation = ?, updated_at = ? WHERE id = ?');
        return stmt.run(rotation, Date.now(), id);
    }

    updateFileModified(id, fileModified) {
        const stmt = this.db.prepare('UPDATE images SET file_modified = ?, updated_at = ? WHERE id = ?');
        return stmt.run(fileModified, Date.now(), id);
    }

    updateFilePath(id, filepath, filename, fileModified) {
        const stmt = this.db.prepare(`
            UPDATE images SET filepath = ?, filename = ?, file_modified = ?, updated_at = ? WHERE id = ?
        `);
        return stmt.run(filepath, filename, fileModified ?? 0, Date.now(), id);
    }

    getImagesNotResized(photoDirectory) {
        const stmt = this.db.prepare('SELECT * FROM images WHERE is_deleted = 0');
        const all = stmt.all();
        const resizedDir = path.join(path.resolve(photoDirectory), 'resized');
        return all.filter(img => {
            const full = path.resolve(img.filepath);
            return !full.startsWith(resizedDir + path.sep) && full !== resizedDir;
        });
    }

    deleteImageByPath(filepath) {
        const stmt = this.db.prepare('DELETE FROM images WHERE filepath = ?');
        const result = stmt.run(filepath);
        return result.changes > 0; // Return true if a row was deleted
    }
    
    // Check if image file exists and remove from DB if not
    cleanupOrphanedEntries(checkFileExists) {
        const stmt = this.db.prepare('SELECT id, filepath FROM images WHERE is_deleted = 0');
        const images = stmt.all();
        let removedCount = 0;
        
        for (const image of images) {
            if (!checkFileExists(image.filepath)) {
                logger.debug('Cleaning up orphaned entry', { filepath: image.filepath });
                console.log(`Cleaning up orphaned entry: ${image.filepath}`);
                this.deleteImageByPath(image.filepath);
                removedCount++;
            }
        }
        
        return removedCount;
    }

    toggleFavorite(id) {
        const stmt = this.db.prepare('UPDATE images SET is_favorite = NOT is_favorite, updated_at = ? WHERE id = ?');
        return stmt.run(Date.now(), id);
    }

    softDelete(id) {
        const stmt = this.db.prepare('UPDATE images SET is_deleted = 1, updated_at = ? WHERE id = ?');
        return stmt.run(Date.now(), id);
    }
    
    hardDelete(id) {
        const stmt = this.db.prepare('DELETE FROM images WHERE id = ?');
        const result = stmt.run(id);
        logger.debug('hardDelete', { id, changes: result.changes });
        return result;
    }

    // Settings operations
    getSetting(key) {
        const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
        const result = stmt.get(key);
        return result ? result.value : null;
    }

    setSetting(key, value) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO settings (key, value, updated_at)
            VALUES (?, ?, ?)
        `);
        return stmt.run(key, value.toString(), Date.now());
    }

    getAllSettings() {
        const stmt = this.db.prepare('SELECT key, value FROM settings');
        const rows = stmt.all();
        const settings = {};
        rows.forEach(row => {
            settings[row.key] = row.value;
        });
        return settings;
    }

    // Statistics
    getStats() {
        const filterSql = this.getSetting('filter_sql');
        const total = this.getImagesCount(false, false, filterSql);
        const favorites = this.getImagesCount(true, false, filterSql);
        
        const dateRange = this.db.prepare(`
            SELECT MIN(date_taken) as earliest, MAX(date_taken) as latest
            FROM images WHERE is_deleted = 0 AND date_taken IS NOT NULL
        `).get();

        const deletedCount = this.db.prepare('SELECT COUNT(*) as count FROM images WHERE is_deleted = 1').get().count;

        return {
            total,
            favorites,
            deleted: deletedCount,
            earliestPhoto: dateRange.earliest,
            latestPhoto: dateRange.latest
        };
    }
    
    // Artistic score operations
    getImagesNeedingArtisticScore(limit = 10) {
        const stmt = this.db.prepare(`
            SELECT * FROM images
            WHERE is_deleted = 0
            AND artistic_score IS NULL
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    // Location operations
    getImagesNeedingLocation(limit = 10) {
        const stmt = this.db.prepare(`
            SELECT * FROM images 
            WHERE is_deleted = 0 
            AND latitude IS NOT NULL 
            AND longitude IS NOT NULL
            AND location_city IS NULL
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    close() {
        this.db.close();
    }
}

module.exports = DatabaseManager;


