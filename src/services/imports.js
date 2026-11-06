const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const IMPORTS_DIR = 'imports';
// An import counts as finished when none of its photos has been indexed for
// this long. Bulk copies index continuously (resize takes ~1 s per photo), so
// gaps between photos are far shorter than this.
const READY_QUIET_MS = 15000;

/**
 * Event imports: photos copied into {photoDir}/imports/<Event name>/ become
 * one named import per folder, with an id from the date the folder first
 * appeared (2026-11-05, then 2026-11-05-2, ...). Loose files placed directly
 * in imports/ form that day's unnamed import. Adding files to an existing
 * folder later extends the same import.
 *
 * The scanner asks importIdForPath() while ingesting a file and calls
 * noteIndexed() after inserting it. Once an import goes quiet, onReady fires
 * (the server switches the slideshow to it).
 */
class ImportService {
    /**
     * @param {object} db - DatabaseManager
     * @param {string} photoDir - absolute photo directory
     * @param {{onReady?: (imp: {id, name, count}) => void, now?: () => Date}} [deps]
     */
    constructor(db, photoDir, deps = {}) {
        this.db = db;
        this.photoDir = path.resolve(photoDir);
        this.importsDir = path.join(this.photoDir, IMPORTS_DIR);
        this.onReady = deps.onReady || null;       // first time an import is complete
        this.onUpdated = deps.onUpdated || null;   // more photos arrived later
        this.now = deps.now || (() => new Date());
        this.readyTimers = new Map();
        this.quietMs = deps.quietMs || READY_QUIET_MS;
    }

    /**
     * Import id for an original file, creating the import on first sight, or
     * null if the file isn't under imports/.
     */
    importIdForPath(filePath) {
        const rel = path.relative(this.importsDir, path.resolve(filePath));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
        const parts = rel.split(path.sep);
        // imports/<folder>/... -> folder; imports/photo.jpg -> loose files of today
        const folder = parts.length > 1 ? parts[0] : `@loose/${this.today()}`;
        const name = parts.length > 1 ? parts[0] : null;
        let imp = this.db.getImportByFolder(folder);
        if (!imp) {
            imp = this.db.createImport({ date: this.today(), name, folder });
            logger.info('Import created', { id: imp.id, name: imp.name, folder });
            console.log(`New import ${imp.id}${imp.name ? ` (${imp.name})` : ''}`);
        }
        return imp.id;
    }

    /** A photo of this import was indexed; (re)start its "finished" timer. */
    noteIndexed(importId) {
        if (!importId) return;
        clearTimeout(this.readyTimers.get(importId));
        this.readyTimers.set(importId, setTimeout(() => {
            this.readyTimers.delete(importId);
            const imp = this.db.getImport(importId);
            if (!imp) return;
            const count = this.db.countImportImages(importId);
            if (count === 0) return;
            // First time this import goes quiet: switch to it. After that
            // (late photos after a pause, more photos added later) only
            // announce the additions, so a mid-copy pause can't keep
            // overriding the user's "Show all photos".
            const firstTime = !imp.shown_at;
            if (firstTime) this.db.markImportShown(importId);
            logger.info('Import ready', { id: importId, count, firstTime });
            const handler = firstTime ? this.onReady : this.onUpdated;
            if (handler) {
                try {
                    handler({ id: imp.id, name: imp.name, count });
                } catch (error) {
                    console.error('Import ready handler failed:', error.message);
                }
            }
        }, this.quietMs));
    }

    /**
     * Imports that finished arriving but were never shown (e.g. the frame
     * restarted within the quiet period): run their ready timers again.
     */
    resumeUnshown() {
        for (const imp of this.db.getUnshownImports()) this.noteIndexed(imp.id);
    }

    /**
     * Image files still sitting under imports/ (the watcher ignores files
     * that existed before it started, e.g. if the frame restarted mid-copy).
     * @param {string[]} extensions - e.g. ['.jpg', '.heic']
     */
    findPending(extensions) {
        const exts = new Set(extensions.map(e => e.toLowerCase()));
        const found = [];
        const walk = (dir) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (exts.has(path.extname(entry.name).toLowerCase())) found.push(full);
            }
        };
        walk(this.importsDir);
        return found.sort();
    }

    /** Create {photoDir}/imports so it's there to copy into. */
    ensureDir() {
        try {
            fs.mkdirSync(this.importsDir, { recursive: true });
        } catch (error) {
            console.error(`Could not create ${this.importsDir}:`, error.message);
        }
    }

    stop() {
        for (const timer of this.readyTimers.values()) clearTimeout(timer);
        this.readyTimers.clear();
    }

    today() {
        const d = this.now();
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
}

module.exports = ImportService;
module.exports.IMPORTS_DIR = IMPORTS_DIR;
