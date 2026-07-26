const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

/**
 * Canonical mapping between camelCase (JS/API) and snake_case (DB column)
 * for the `images` table. Used by:
 *   - updateImage: decide which columns the caller asked to update
 *   - formatImage: convert DB rows to the client-facing shape
 *
 * Each entry: jsKey -> { col: sqlColumnName, type?: 'json'|'bool'|'raw' }
 *   - 'json'  : JSON-encode on write, JSON-parse (or []) on read
 *   - 'bool'  : read-side coerce 0/1 -> true/false (writes pass through)
 *   - 'raw'   : no transformation (default)
 *
 * Columns only written by insertImage (e.g. created_at, updated_at) and
 * columns not exposed to clients (file_modified) are handled
 * directly in their specific methods and are not listed here.
 */
const IMAGE_FIELD_MAP = {
    filepath:         { col: 'filepath' },
    filename:         { col: 'filename' },
    fileModified:     { col: 'file_modified' },
    dateTaken:        { col: 'date_taken' },
    dateAdded:        { col: 'date_added' },
    latitude:         { col: 'latitude' },
    longitude:        { col: 'longitude' },
    locationCity:     { col: 'location_city' },
    locationCountry:  { col: 'location_country' },
    width:            { col: 'width' },
    height:           { col: 'height' },
    orientation:      { col: 'orientation' },
    rotation:         { col: 'rotation' },
    cameraModel:      { col: 'camera_model' },
    cameraMake:       { col: 'camera_make' },
    isFavorite:       { col: 'is_favorite', type: 'bool' },
    tags:             { col: 'tags',        type: 'json' }
};

/**
 * Convert a raw DB row to the client-facing image shape. This is the
 * single source of truth for camelCase field names the frontend consumes.
 *
 * Note: fileModified, createdAt, updatedAt are intentionally
 * omitted — they're server-side bookkeeping, not part of the public shape.
 */
function formatImage(row) {
    if (!row) return null;
    return {
        id: row.id,
        filepath: row.filepath,
        filename: row.filename,
        dateTaken: row.date_taken,
        dateAdded: row.date_added,
        latitude: row.latitude,
        longitude: row.longitude,
        locationCity: row.location_city,
        locationCountry: row.location_country,
        width: row.width,
        height: row.height,
        orientation: row.orientation,
        rotation: row.rotation || 0,
        cameraModel: row.camera_model,
        cameraMake: row.camera_make,
        isFavorite: row.is_favorite === 1,
        tags: row.tags ? JSON.parse(row.tags) : []
    };
}

class DatabaseManager {
    constructor(dbPath) {
        // Ensure data directory exists
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        this.dbPath = dbPath;
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
        this.migrate();
        console.log('Database initialized successfully');
    }

    /**
     * Idempotent, additive migrations for databases created before a column
     * existed. CREATE TABLE IF NOT EXISTS never alters an existing table, so
     * new columns are added here.
     */
    migrate() {
        const cols = this.db.prepare('PRAGMA table_info(images)').all().map(c => c.name);
        if (!cols.includes('geocode_attempted')) {
            this.db.exec('ALTER TABLE images ADD COLUMN geocode_attempted INTEGER DEFAULT 0');
            // Rows that already have a resolved city were effectively attempted.
            this.db.exec('UPDATE images SET geocode_attempted = 1 WHERE location_city IS NOT NULL');
            console.log('Migration: added geocode_attempted column');
        }
        if (!cols.includes('artistic_score')) {
            this.db.exec('ALTER TABLE images ADD COLUMN artistic_score INTEGER');
            console.log('Migration: added artistic_score column');
        }
        if (!cols.includes('artistic_score_details')) {
            this.db.exec('ALTER TABLE images ADD COLUMN artistic_score_details TEXT');
            console.log('Migration: added artistic_score_details column');
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_artistic_score ON images(artistic_score)');
        if (!cols.includes('content_hash')) {
            this.db.exec('ALTER TABLE images ADD COLUMN content_hash TEXT');
            console.log('Migration: added content_hash column');
        }
        if (!cols.includes('perceptual_hash')) {
            this.db.exec('ALTER TABLE images ADD COLUMN perceptual_hash TEXT');
            console.log('Migration: added perceptual_hash column');
        }
        if (!cols.includes('hash_computed')) {
            this.db.exec('ALTER TABLE images ADD COLUMN hash_computed INTEGER DEFAULT 0');
            console.log('Migration: added hash_computed column');
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_content_hash ON images(content_hash)');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS duplicate_group_members (
                group_id INTEGER NOT NULL,
                image_id INTEGER NOT NULL,
                group_type TEXT NOT NULL,
                is_suggested_keeper INTEGER DEFAULT 0,
                is_oversized INTEGER DEFAULT 0,
                is_auto_eligible INTEGER DEFAULT 0,
                PRIMARY KEY (group_id, image_id)
            )
        `);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_dgm_image ON duplicate_group_members(image_id)');
    }

    // Image operations
    insertImage(imageData) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO images (
                filepath, filename, file_modified, date_taken, date_added,
                latitude, longitude, location_city, location_country, width, height, orientation, rotation,
                camera_model, camera_make, is_favorite, tags,
                created_at, updated_at
            ) VALUES (
                @filepath, @filename, @fileModified, @dateTaken, @dateAdded,
                @latitude, @longitude, @locationCity, @locationCountry, @width, @height, @orientation, @rotation,
                @cameraModel, @cameraMake, @isFavorite, @tags,
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
        const stmt = this.db.prepare('SELECT * FROM images WHERE id = ?');
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
        let query = 'SELECT * FROM images WHERE 1 = 1';
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
        let query = 'SELECT COUNT(*) as count FROM images WHERE 1 = 1';
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

    /**
     * Previously this was a ~35-line chain of `if (updates.X !== undefined)`
     * blocks; now it iterates IMAGE_FIELD_MAP so adding a settable field is
     * a one-line map entry.
     *
     * Only columns present in IMAGE_FIELD_MAP are updatable. Keys not in the
     * map are silently ignored (matches historical behavior, which only
     * accepted isFavorite / tags / locationCity / locationCountry
     * / rotation).
     */
    updateImage(id, updates) {
        const UPDATABLE = ['isFavorite', 'tags', 'locationCity', 'locationCountry', 'rotation'];
        const fields = [];
        const values = { id, updatedAt: Date.now() };

        for (const jsKey of UPDATABLE) {
            if (updates[jsKey] === undefined) continue;
            const { col, type } = IMAGE_FIELD_MAP[jsKey];
            fields.push(`${col} = @${jsKey}`);
            values[jsKey] = (type === 'json') ? JSON.stringify(updates[jsKey]) : updates[jsKey];
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
        const stmt = this.db.prepare('SELECT * FROM images');
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
        const stmt = this.db.prepare('SELECT id, filepath FROM images');
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

    /**
     * Insert a default setting only if the key does not already exist. Used
     * on first run to seed slideshow defaults from config; the DB is
     * authoritative thereafter (setSetting overwrites, seedSetting does not).
     */
    seedSetting(key, value) {
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO settings (key, value, updated_at)
            VALUES (?, ?, ?)
        `);
        return stmt.run(key, String(value), Date.now());
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
            FROM images WHERE date_taken IS NOT NULL
        `).get();

        return {
            total,
            favorites,
            earliestPhoto: dateRange.earliest,
            latestPhoto: dateRange.latest
        };
    }
    
    // Artistic score operations
    getImagesNeedingArtisticScore(limit = 10) {
        const stmt = this.db.prepare(`
            SELECT * FROM images
            WHERE artistic_score IS NULL
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    // Duplicate-detection: hash backfill
    getImagesNeedingHash(limit = 100) {
        const stmt = this.db.prepare('SELECT id, filepath FROM images WHERE hash_computed = 0 LIMIT ?');
        return stmt.all(limit);
    }

    countImagesNeedingHash() {
        return this.db.prepare('SELECT COUNT(*) AS c FROM images WHERE hash_computed = 0').get().c;
    }

    setHashes(id, contentHash, perceptualHash) {
        const stmt = this.db.prepare(
            'UPDATE images SET content_hash = ?, perceptual_hash = ?, hash_computed = 1, updated_at = ? WHERE id = ?'
        );
        return stmt.run(contentHash, perceptualHash, Date.now(), id);
    }

    resetHashComputed(id) {
        const stmt = this.db.prepare('UPDATE images SET hash_computed = 0, updated_at = ? WHERE id = ?');
        return stmt.run(Date.now(), id);
    }

    // Duplicate-detection: grouping
    getExactDuplicateGroups() {
        const rows = this.db.prepare(`
            SELECT content_hash, GROUP_CONCAT(id) AS ids
            FROM images
            WHERE content_hash IS NOT NULL
            GROUP BY content_hash HAVING COUNT(*) > 1
        `).all();
        return rows.map(r => ({ contentHash: r.content_hash, ids: r.ids.split(',').map(Number) }));
    }

    getImagesWithPerceptualHash() {
        return this.db.prepare(
            'SELECT id, perceptual_hash, content_hash FROM images WHERE perceptual_hash IS NOT NULL'
        ).all();
    }

    getImagesByIds(ids) {
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(',');
        return this.db.prepare(`SELECT * FROM images WHERE id IN (${placeholders})`).all(...ids);
    }

    clearDuplicateGroups() {
        return this.db.prepare('DELETE FROM duplicate_group_members').run();
    }

    insertGroupMembers(rows) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO duplicate_group_members
                (group_id, image_id, group_type, is_suggested_keeper, is_oversized, is_auto_eligible)
            VALUES (@groupId, @imageId, @groupType, @isSuggestedKeeper, @isOversized, @isAutoEligible)
        `);
        const insert = this.db.transaction((rs) => { for (const r of rs) stmt.run(r); });
        return insert(rows);
    }

    /** All current groups with their member image rows joined, for the review UI. */
    getDuplicateGroups() {
        const members = this.db.prepare(`
            SELECT m.group_id, m.image_id, m.group_type, m.is_suggested_keeper, m.is_oversized, m.is_auto_eligible,
                   i.filepath, i.filename, i.width, i.height, i.is_favorite, i.artistic_score, i.date_taken
            FROM duplicate_group_members m JOIN images i ON i.id = m.image_id
            ORDER BY m.group_id, m.image_id
        `).all();
        const groups = new Map();
        for (const m of members) {
            if (!groups.has(m.group_id)) {
                groups.set(m.group_id, { groupId: m.group_id, groupType: m.group_type, oversized: !!m.is_oversized, autoEligible: !!m.is_auto_eligible, members: [] });
            }
            groups.get(m.group_id).members.push({
                id: m.image_id, filename: m.filename, width: m.width, height: m.height,
                isFavorite: m.is_favorite === 1, artisticScore: m.artistic_score,
                dateTaken: m.date_taken, isSuggestedKeeper: m.is_suggested_keeper === 1
            });
        }
        return Array.from(groups.values());
    }

    /**
     * Bounded view for the review UI: at most maxGroups groups; oversized groups
     * return only a small member preview (with the true memberCount). Members are
     * ordered so the suggested keeper is always included in the preview.
     */
    getDuplicateGroupsForReview(maxGroups = 150, previewForOversized = 8) {
        const headers = this.db.prepare(`
            SELECT group_id, group_type,
                   MAX(is_oversized) AS oversized,
                   MAX(is_auto_eligible) AS auto_eligible,
                   COUNT(*) AS member_count
            FROM duplicate_group_members
            GROUP BY group_id ORDER BY group_id LIMIT ?
        `).all(maxGroups + 1);
        const truncated = headers.length > maxGroups;
        const use = headers.slice(0, maxGroups);

        const sel = `SELECT m.image_id, m.is_suggested_keeper,
                   i.filename, i.width, i.height, i.is_favorite, i.artistic_score, i.date_taken
            FROM duplicate_group_members m JOIN images i ON i.id = m.image_id
            WHERE m.group_id = ? ORDER BY m.is_suggested_keeper DESC, m.image_id`;
        const stmtAll = this.db.prepare(sel);
        const stmtLimited = this.db.prepare(sel + ' LIMIT ?');

        const groups = use.map(h => {
            const rows = h.oversized ? stmtLimited.all(h.group_id, previewForOversized) : stmtAll.all(h.group_id);
            return {
                groupId: h.group_id, groupType: h.group_type,
                oversized: !!h.oversized, autoEligible: !!h.auto_eligible,
                memberCount: h.member_count,
                members: rows.map(m => ({
                    id: m.image_id, filename: m.filename, width: m.width, height: m.height,
                    isFavorite: m.is_favorite === 1, artisticScore: m.artistic_score,
                    dateTaken: m.date_taken, isSuggestedKeeper: m.is_suggested_keeper === 1
                }))
            };
        });
        return { groups, truncated };
    }

    getDuplicateGroupSummary() {
        const row = this.db.prepare(`
            SELECT
              COUNT(DISTINCT CASE WHEN group_type='exact' THEN group_id END) AS exactGroups,
              COUNT(DISTINCT CASE WHEN group_type='similar' THEN group_id END) AS similarGroups
            FROM duplicate_group_members
        `).get();
        return { exactGroups: row.exactGroups || 0, similarGroups: row.similarGroups || 0 };
    }

    removeImagesFromGroups(ids) {
        if (!ids.length) return;
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM duplicate_group_members WHERE image_id IN (${placeholders})`).run(...ids);
    }

    /**
     * Keep policy: highest resolution, then highest artistic_score (nulls last),
     * then earliest date_taken (nulls last). Returns the id to retain.
     */
    pickKeeper(ids) {
        const rows = this.getImagesByIds(ids);
        rows.sort((a, b) => {
            const areaA = (a.width || 0) * (a.height || 0);
            const areaB = (b.width || 0) * (b.height || 0);
            if (areaA !== areaB) return areaB - areaA;
            const sa = a.artistic_score == null ? -1 : a.artistic_score;
            const sb = b.artistic_score == null ? -1 : b.artistic_score;
            if (sa !== sb) return sb - sa;
            const da = a.date_taken || '9999';
            const db_ = b.date_taken || '9999';
            if (da < db_) return -1;
            if (da > db_) return 1;
            return a.id - b.id; // stable tiebreak
        });
        return rows.length ? rows[0].id : null;
    }

    /**
     * Carry metadata from soon-to-be-deleted duplicates onto the keeper, in a
     * transaction. Sets keeper favorite if any deleted copy was; unions tags;
     * copies artistic_score (+ details) if keeper lacks one. Does NOT delete.
     */
    applyDuplicateCarryover(keeperId, deleteIds) {
        const tx = this.db.transaction(() => {
            const keeper = this.db.prepare('SELECT * FROM images WHERE id = ?').get(keeperId);
            if (!keeper) return;
            const deleted = this.getImagesByIds(deleteIds);

            let favorite = keeper.is_favorite === 1;
            const tagSet = new Set(keeper.tags ? JSON.parse(keeper.tags) : []);
            let score = keeper.artistic_score;
            let scoreDetails = keeper.artistic_score_details;

            for (const d of deleted) {
                if (d.is_favorite === 1) favorite = true;
                if (d.tags) { for (const t of JSON.parse(d.tags)) tagSet.add(t); }
                if (score == null && d.artistic_score != null) {
                    score = d.artistic_score;
                    scoreDetails = d.artistic_score_details;
                }
            }

            this.db.prepare(`
                UPDATE images SET is_favorite = ?, tags = ?, artistic_score = ?, artistic_score_details = ?, updated_at = ?
                WHERE id = ?
            `).run(
                favorite ? 1 : 0,
                tagSet.size ? JSON.stringify(Array.from(tagSet)) : null,
                score == null ? null : score,
                scoreDetails == null ? null : scoreDetails,
                Date.now(),
                keeperId
            );
        });
        return tx();
    }

    // Location operations
    getImagesNeedingLocation(limit = 10) {
        const stmt = this.db.prepare(`
            SELECT * FROM images
            WHERE latitude IS NOT NULL
            AND longitude IS NOT NULL
            AND geocode_attempted = 0
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    /**
     * Mark an image as having had a reverse-geocode attempt (success or not)
     * so it is not re-queried on every restart.
     */
    markGeocodeAttempted(id) {
        const stmt = this.db.prepare('UPDATE images SET geocode_attempted = 1, updated_at = ? WHERE id = ?');
        return stmt.run(Date.now(), id);
    }

    /**
     * Convenience: delegates to the module-level formatImage. Kept as an
     * instance method so callers holding a `db` reference can format rows
     * without importing the standalone function.
     */
    formatImage(row) {
        return formatImage(row);
    }

    /**
     * Reset the database in place: close the connection, delete the DB files
     * (including WAL/SHM), then recreate an empty schema and reopen. The
     * DatabaseManager instance identity is preserved, so every existing
     * reference (routes, engine, scanner) stays valid.
     */
    reset() {
        this.db.close();

        for (const file of [this.dbPath, `${this.dbPath}-shm`, `${this.dbPath}-wal`]) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
                console.log(`Deleted: ${file}`);
            }
        }

        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -64000');
        this.initialize();
    }

    close() {
        this.db.close();
    }
}

module.exports = DatabaseManager;
module.exports.formatImage = formatImage;
module.exports.IMAGE_FIELD_MAP = IMAGE_FIELD_MAP;


