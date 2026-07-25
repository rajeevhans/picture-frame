# Fix Rough Edges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the identified rough edges in the picture-frame codebase and add shared-secret authentication that leaves the local frame display open.

**Architecture:** A cleanup pass across the existing Node/Express app. Behavior is preserved except where the spec explicitly changes it (self-restart, auth). Work proceeds as small atomic commits, ordered: isolated bug fixes → soft-delete removal → the two reworks → auth.

**Tech Stack:** Node.js, Express 4, better-sqlite3, Sharp, chokidar, vanilla JS frontend. No new runtime dependencies (cookie set via Express's built-in `res.cookie`, cookie read by parsing the header manually, form body via built-in `express.urlencoded`).

## Global Constraints

- **No test framework exists** and none is being added (CLAUDE.md). Per the spec, every task is verified by a concrete runnable check — a `node -e` assertion against the module or a `curl` against a running server — with expected output shown. "Evidence before assertions": run the check and confirm the expected output before marking a step done.
- **Preserve existing behavior** except the two approved changes (self-restart → exit-and-supervise; adding auth). Flag any accidental public-API change.
- **Small atomic commits** — one task, one commit. Commit messages use Conventional Commits (`fix:`, `feat:`, `refactor:`, `docs:`).
- End every commit message body with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Node runs from the project root `/Users/rhans/picture-frame`. Do not `cd` elsewhere.
- Do not touch the destructive-ingest behavior (originals are still deleted after resize).

---

## File Structure

**Modified:**
- `src/slideshow/engine.js` — preload guard, smart-weight versioning, config-default seeding
- `src/server.js` — unconditional shutdown handlers, watcher refresh wiring, geolocation attempted-marking, DB reset via new method, auth mount + startup warning + urlencoded
- `src/indexer/watcher.js` — accept and fire an `onChange` refresh callback (debounced)
- `src/database/schema.sql` — add `geocode_attempted`, drop settings seed block + `is_deleted` column/index
- `src/database/db.js` — migration, `seedSetting`, `markGeocodeAttempted`, `reset`, remove `is_deleted` references, geolocation query change, remove `deleted` stat
- `src/services/geolocation.js` — (no change required; marking happens in server loop)
- `src/routes/images.js` — HEIF on-disk cache in `sendImageOrHeif`
- `src/routes/settings.js` — self-restart rework
- `src/lib/heif.js` — add a cached-conversion helper
- `src/public/js/app.js` — color-array bug, onload-clobber fix, remove `statDeleted`
- `src/public/index.html` — remove the Deleted stat row
- `scripts/benchmark.js` — remove `is_deleted` filters
- `config.json` — add `auth` block
- `README.md`, `CLAUDE.md` — auth docs

**Created:**
- `src/middleware/auth.js` — shared-secret auth middleware with loopback bypass
- `src/routes/login.js` — GET/POST `/login` with brute-force limiter

---

## Task 1: Guard preload against an empty image list

**Files:**
- Modify: `src/slideshow/engine.js:431-445` (`getPreloadImages`)

- [ ] **Step 1: Add the empty-list guard**

In `getPreloadImages`, add an early return at the top of the method body (before the `for` loop). Replace:

```javascript
    getPreloadImages(count = null) {
        // Use configured preload count if not specified
        const preloadCount = count !== null ? count : this.preloadCount;
        // Get next N images for preloading
        const preload = [];

        for (let i = 1; i <= preloadCount; i++) {
```

with:

```javascript
    getPreloadImages(count = null) {
        // Use configured preload count if not specified
        const preloadCount = count !== null ? count : this.preloadCount;
        // Get next N images for preloading
        const preload = [];

        // Empty list → nothing to preload (also avoids `% 0` producing NaN)
        if (this.imageList.length === 0) {
            return preload;
        }

        for (let i = 1; i <= preloadCount; i++) {
```

- [ ] **Step 2: Verify it returns `[]` on an empty list**

Run:
```bash
node -e "const E=require('./src/slideshow/engine.js'); const e=new E(E, {}); e.imageList=[]; const r=e.getPreloadImages(); console.log(JSON.stringify(r), Array.isArray(r) && r.length===0 ? 'PASS':'FAIL')"
```
Expected: `[] PASS`

- [ ] **Step 3: Commit**

```bash
git add src/slideshow/engine.js
git commit -m "$(printf 'fix: guard slideshow preload against empty image list\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Version the smart-mode weight cache to the image list

**Files:**
- Modify: `src/slideshow/engine.js` — constructor (`~47-48`), `refreshImageList` (`~126-130`), `selectSmartImage` (`~267-307`), `updateSettings` (`~420-426`)

**Interfaces:**
- Produces: `this.smartWeightsListVersion` (number), bumped on every `refreshImageList`.

- [ ] **Step 1: Add a list-version counter in the constructor**

Replace (engine.js ~46-48):
```javascript
        // Cache for smart mode weights
        this.smartWeights = null;
        this.smartWeightsTimestamp = 0;
```
with:
```javascript
        // Cache for smart mode weights
        this.smartWeights = null;
        this.smartWeightsTimestamp = 0;
        // Bumped whenever the image list changes so a stale weight array can
        // never be indexed against a newer/shorter list.
        this.listVersion = 0;
        this.smartWeightsListVersion = -1;
```

- [ ] **Step 2: Bump the list version whenever the list is rebuilt**

At the end of `refreshImageList` (after the history-pruning block, engine.js ~129), add:
```javascript
        // Invalidate any cached smart weights — they were computed for the
        // previous list and would index-mismatch the new one.
        this.listVersion++;
```

- [ ] **Step 3: Key the weight cache on both time AND list version**

In `selectSmartImage`, replace (engine.js ~269-272):
```javascript
        const now = Date.now();
        const cacheValid = (now - this.smartWeightsTimestamp) < 5000;
        
        if (!this.smartWeights || !cacheValid) {
```
with:
```javascript
        const now = Date.now();
        const cacheValid = (now - this.smartWeightsTimestamp) < 5000
            && this.smartWeightsListVersion === this.listVersion;

        if (!this.smartWeights || !cacheValid) {
```

- [ ] **Step 4: Record the list version when weights are (re)computed**

In `selectSmartImage`, replace (engine.js ~306):
```javascript
            this.smartWeightsTimestamp = now;
```
with:
```javascript
            this.smartWeightsTimestamp = now;
            this.smartWeightsListVersion = this.listVersion;
```

- [ ] **Step 5: Simplify the manual cache clear in updateSettings**

In `updateSettings`, the `needsRefresh` block already calls `refreshImageList()` (which now bumps `listVersion`). Replace (engine.js ~420-425):
```javascript
        if (needsRefresh) {
            this.refreshImageList();
            // Clear smart mode cache when settings change
            this.smartWeights = null;
            this.smartWeightsTimestamp = 0;
            console.log('Slideshow settings updated and image list refreshed');
        }
```
with:
```javascript
        if (needsRefresh) {
            this.refreshImageList();
            // refreshImageList() bumped listVersion, which invalidates the
            // smart-weight cache on the next selectSmartImage() call.
            console.log('Slideshow settings updated and image list refreshed');
        }
```

- [ ] **Step 6: Verify a list change invalidates the cache**

Run:
```bash
node -e "
const E=require('./src/slideshow/engine.js');
const e=new E(E,{});
e.imageList=[{id:1,is_favorite:0},{id:2,is_favorite:0}];
e.refreshImageList=function(){ this.listVersion++; };  // stub out DB
e.listVersion=1;
e.selectSmartImage();                       // computes weights for 2 items
const v1=e.smartWeightsListVersion, n1=e.smartWeights.length;
e.imageList=[{id:1,is_favorite:0}];         // list shrinks
e.listVersion++;                            // as refreshImageList would
e.selectSmartImage();                       // must recompute despite <5s
const n2=e.smartWeights.length;
console.log(n1, n2, (n1===2 && n2===1) ? 'PASS':'FAIL');
"
```
Expected: `2 1 PASS`

- [ ] **Step 7: Commit**

```bash
git add src/slideshow/engine.js
git commit -m "$(printf 'fix: invalidate smart-weight cache when image list changes\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Register graceful-shutdown handlers unconditionally

**Files:**
- Modify: `src/server.js:244-261`

**Interfaces:**
- Consumes: `slideshowEngine.stopForShutdown()`, `db.close()`, `sseClients`, `FileWatcher`.
- Produces: a module-scoped `let watcher = null;` referenced by the shutdown handler.

- [ ] **Step 1: Hoist the watcher variable and move shutdown out of the photo-dir block**

Replace (server.js ~244-261):
```javascript
    // Start file watcher
    if (fs.existsSync(photoDir) && !forceIndex) {
        const watcher = new FileWatcher(db, scanner, config);
        watcher.start(photoDir);

        // Graceful shutdown (single handler, registered for both signals)
        const shutdown = () => {
            console.log('\nShutting down...');
            slideshowEngine.stopForShutdown();
            watcher.stop();
            sseClients.forEach(client => client.end());
            sseClients.clear();
            db.close();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }
```
with:
```javascript
    // Start file watcher (only when there is a real photo dir to watch)
    let watcher = null;
    if (fs.existsSync(photoDir) && !forceIndex) {
        watcher = new FileWatcher(db, scanner, config, {
            onChange: () => slideshowEngine.refreshImageList()
        });
        watcher.start(photoDir);
    }

    // Graceful shutdown — registered unconditionally so dev mode (no photo
    // dir) also closes the DB cleanly. Guards each subsystem in case it was
    // never started.
    const shutdown = () => {
        console.log('\nShutting down...');
        slideshowEngine.stopForShutdown();
        if (watcher) watcher.stop();
        sseClients.forEach(client => client.end());
        sseClients.clear();
        db.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
```

Note: the `onChange` option passed to `FileWatcher` is wired up in Task 4; passing it here is harmless until then because the watcher ignores unknown options.

- [ ] **Step 2: Verify dev mode installs a SIGTERM handler and closes cleanly**

Run (starts in dev mode with no photo dir, sends SIGTERM, expects a clean "Shutting down..." and exit 0):
```bash
PICFRAME_TEST=1 node -e "
process.argv.push('--dev');
require('./src/server.js');
setTimeout(() => { console.log('LISTENERS', process.listenerCount('SIGTERM')); process.kill(process.pid,'SIGTERM'); }, 1500);
" 2>&1 | grep -E "Shutting down|LISTENERS"
```
Expected: a line `LISTENERS 1` followed by `Shutting down...`.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "$(printf 'fix: register shutdown handlers even without a photo directory\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Refresh the live slideshow when the watcher changes files

**Files:**
- Modify: `src/indexer/watcher.js:4-13` (constructor), `:99-128` (`processQueue`/`processTask`)
- (server.js wiring already added in Task 3)

**Interfaces:**
- Consumes: `deps.onChange` — a `() => void` callback invoked after the queue drains.
- Produces: watcher calls `onChange` (debounced by draining) after add/change/unlink batches.

- [ ] **Step 1: Accept an `onChange` callback in the constructor**

Replace (watcher.js 5-13):
```javascript
    constructor(db, scanner, config) {
        this.db = db;
        this.scanner = scanner;
        this.config = config;
        this.watcher = null;
        this.queue = [];
        this.processing = false;
        this.debounceTimers = new Map();
    }
```
with:
```javascript
    constructor(db, scanner, config, deps = {}) {
        this.db = db;
        this.scanner = scanner;
        this.config = config;
        this.watcher = null;
        this.queue = [];
        this.processing = false;
        this.debounceTimers = new Map();
        // Called once after a batch of file events has been fully processed,
        // so the running slideshow picks up added/removed images. Optional.
        this.onChange = deps.onChange || null;
    }
```

- [ ] **Step 2: Fire `onChange` once after the queue drains**

Replace (watcher.js 99-112, `processQueue`):
```javascript
    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0) {
            const task = this.queue.shift();
            await this.processTask(task);
        }

        this.processing = false;
    }
```
with:
```javascript
    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        let changed = false;

        while (this.queue.length > 0) {
            const task = this.queue.shift();
            const didChange = await this.processTask(task);
            if (didChange) changed = true;
        }

        this.processing = false;

        // One refresh per drained batch (not per file) so a bulk import
        // refreshes the slideshow once.
        if (changed && this.onChange) {
            try {
                this.onChange();
            } catch (error) {
                console.error('Watcher onChange callback failed:', error.message);
            }
        }
    }
```

- [ ] **Step 3: Make `processTask` report whether the index actually changed**

Replace (watcher.js 114-128, `processTask`):
```javascript
    async processTask(task) {
        try {
            switch (task.type) {
                case 'add':
                case 'change':
                    await this.scanner.indexSingleFile(task.filePath);
                    break;
                case 'unlink':
                    this.scanner.removeFromIndex(task.filePath);
                    break;
            }
        } catch (error) {
            console.error(`Error processing task for ${task.filePath}:`, error.message);
        }
    }
```
with:
```javascript
    async processTask(task) {
        try {
            switch (task.type) {
                case 'add':
                case 'change':
                    await this.scanner.indexSingleFile(task.filePath);
                    return true;
                case 'unlink':
                    this.scanner.removeFromIndex(task.filePath);
                    return true;
            }
        } catch (error) {
            console.error(`Error processing task for ${task.filePath}:`, error.message);
        }
        return false;
    }
```

- [ ] **Step 4: Verify the callback fires after a processed task**

Run:
```bash
node -e "
const W=require('./src/indexer/watcher.js');
let called=0;
const scanner={ indexSingleFile: async()=>{}, removeFromIndex: ()=>{} };
const w=new W({}, scanner, {}, { onChange: ()=>{ called++; } });
w.queueTask({ type:'add', filePath:'/x.jpg' });
setTimeout(()=>{ console.log('called', called, called===1?'PASS':'FAIL'); }, 200);
"
```
Expected: `called 1 PASS`

- [ ] **Step 5: Commit**

```bash
git add src/indexer/watcher.js
git commit -m "$(printf 'fix: refresh live slideshow after watcher indexes/removes files\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Apply config slideshow defaults as first-run DB seed

**Files:**
- Modify: `src/database/schema.sql:41-47` (remove hardcoded seed block)
- Modify: `src/database/db.js` — add `seedSetting`
- Modify: `src/slideshow/engine.js` — store config, seed defaults in `initialize`

**Interfaces:**
- Produces: `db.seedSetting(key, value)` — INSERT OR IGNORE, so it only writes on a fresh DB.

- [ ] **Step 1: Remove the hardcoded settings seed from schema.sql**

Delete these lines (schema.sql 41-47):
```sql
-- Insert default settings
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES 
    ('slideshow_mode', 'sequential', strftime('%s', 'now')),
    ('slideshow_interval', '10', strftime('%s', 'now')),
    ('slideshow_order', 'date', strftime('%s', 'now')),
    ('filter_favorites_only', '0', strftime('%s', 'now')),
    ('current_image_id', '0', strftime('%s', 'now'));
```
Leave the `settings` CREATE TABLE in place. Seeding now happens in the engine using config values.

- [ ] **Step 2: Add `seedSetting` to DatabaseManager**

In `src/database/db.js`, immediately after the `setSetting` method (after db.js:317), add:
```javascript
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
```

- [ ] **Step 3: Store config on the engine**

In `src/slideshow/engine.js` constructor, after `this.db = db;` (engine.js:29), add:
```javascript
        this.config = config || {};
```

- [ ] **Step 4: Seed config defaults at the start of initialize()**

In `initialize()`, before `const savedSettings = this.db.getAllSettings();` (engine.js:63-64), add:
```javascript
        // First-run seed: apply config slideshow defaults if the settings
        // table is empty. seedSetting is INSERT OR IGNORE, so this is a no-op
        // on an existing DB — the DB stays authoritative.
        const ss = this.config.slideshow || {};
        this.db.seedSetting('slideshow_mode', ss.defaultMode || 'sequential');
        this.db.seedSetting('slideshow_interval', ss.defaultInterval != null ? ss.defaultInterval : 10);
        this.db.seedSetting('slideshow_order', ss.defaultOrder || 'date');
        this.db.seedSetting('filter_favorites_only', '0');
        this.db.seedSetting('current_image_id', '0');

```

- [ ] **Step 5: Verify config defaults land in a fresh DB**

Run (uses a throwaway DB path, sets defaultMode=random, checks it persisted):
```bash
node -e "
const fs=require('fs'); const p='/tmp/pf-seedtest.db';
for (const f of [p, p+'-wal', p+'-shm']) { try{fs.unlinkSync(f)}catch(_){} }
const DB=require('./src/database/db.js');
const E=require('./src/slideshow/engine.js');
const db=new DB(p);
const cfg={ slideshow:{ defaultMode:'random', defaultInterval:22, defaultOrder:'filename' } };
const e=new E(db, cfg);
// initialize reads settings + refreshImageList (empty DB is fine)
e.initialize();
const s=db.getAllSettings();
console.log(s.slideshow_mode, s.slideshow_interval, s.slideshow_order,
  (s.slideshow_mode==='random' && s.slideshow_interval==='22' && s.slideshow_order==='filename') ? 'PASS':'FAIL');
db.close();
"
```
Expected: `random 22 filename PASS`

- [ ] **Step 6: Commit**

```bash
git add src/database/schema.sql src/database/db.js src/slideshow/engine.js
git commit -m "$(printf 'fix: seed slideshow settings from config on first-run DB init\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: Add a geocode-attempted marker so failed lookups are not re-queried

**Files:**
- Modify: `src/database/schema.sql` (add column to CREATE TABLE)
- Modify: `src/database/db.js` — migration in `initialize`, `markGeocodeAttempted`, change `getImagesNeedingLocation`
- Modify: `src/server.js:314-335` (`processGeolocationBatch`)

**Interfaces:**
- Produces: `db.markGeocodeAttempted(id)` — sets `geocode_attempted = 1`.
- Changes: `getImagesNeedingLocation` now returns rows with GPS **and** `geocode_attempted = 0`.

- [ ] **Step 1: Add the column to the fresh-DB schema**

In `src/database/schema.sql`, in the `images` CREATE TABLE, add a line after `location_country TEXT,` (schema.sql:12):
```sql
    geocode_attempted INTEGER DEFAULT 0,
```

- [ ] **Step 2: Add an idempotent migration for existing DBs**

In `src/database/db.js`, replace the `initialize` method (db.js:86-91):
```javascript
    initialize() {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        this.db.exec(schema);
        console.log('Database initialized successfully');
    }
```
with:
```javascript
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
    }
```

- [ ] **Step 3: Change the "needing location" query to use the marker**

In `src/database/db.js`, replace `getImagesNeedingLocation` (db.js:351-361):
```javascript
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
```
with:
```javascript
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
```
(Note: the `is_deleted = 0` filter is dropped here as part of the soft-delete removal in Task 9; removing it now is safe because every real row has `is_deleted = 0`.)

- [ ] **Step 4: Mark every processed image as attempted in the server loop**

In `src/server.js`, replace `processGeolocationBatch` (server.js:314-335):
```javascript
    async function processGeolocationBatch() {
        const batchSize = 100;
        const imagesToLookup = db.getImagesNeedingLocation(batchSize);
        
        if (imagesToLookup.length > 0) {
            const remaining = db.getImagesNeedingLocation(10000).length; // Get total count
            console.log(`Starting background location lookup: ${imagesToLookup.length} images (${remaining} total remaining)...`);
            
            await geoService.batchLookup(imagesToLookup, (id, location) => {
                return db.updateImage(id, location);
            });
            
            // Check if more images need processing
            const stillRemaining = db.getImagesNeedingLocation(1).length;
            if (stillRemaining > 0) {
                console.log(`Scheduling next batch in 10 seconds...`);
                setTimeout(() => processGeolocationBatch(), 10000); // Wait 10 seconds between batches
            } else {
                console.log(`✓ All location lookups complete!`);
            }
        }
    }
```
with:
```javascript
    async function processGeolocationBatch() {
        const batchSize = 100;
        const imagesToLookup = db.getImagesNeedingLocation(batchSize);

        if (imagesToLookup.length > 0) {
            const remaining = db.getImagesNeedingLocation(10000).length; // Get total count
            console.log(`Starting background location lookup: ${imagesToLookup.length} images (${remaining} total remaining)...`);

            await geoService.batchLookup(imagesToLookup, (id, location) => {
                return db.updateImage(id, location);
            });

            // Mark the whole batch as attempted (success OR no-result) so
            // un-geocodable photos are not re-queried on every restart.
            for (const img of imagesToLookup) {
                db.markGeocodeAttempted(img.id);
            }

            // Check if more images need processing
            const stillRemaining = db.getImagesNeedingLocation(1).length;
            if (stillRemaining > 0) {
                console.log(`Scheduling next batch in 10 seconds...`);
                setTimeout(() => processGeolocationBatch(), 10000); // Wait 10 seconds between batches
            } else {
                console.log(`✓ All location lookups complete!`);
            }
        }
    }
```

- [ ] **Step 5: Verify the marker excludes attempted rows**

Run:
```bash
node -e "
const fs=require('fs'); const p='/tmp/pf-geotest.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js');
const db=new DB(p);
const now=Date.now();
db.insertImage({filepath:'/a.jpg',filename:'a.jpg',fileModified:now,latitude:1,longitude:2});
db.insertImage({filepath:'/b.jpg',filename:'b.jpg',fileModified:now,latitude:3,longitude:4});
let n1=db.getImagesNeedingLocation(10).length;      // 2 need lookup
const first=db.getImagesNeedingLocation(10)[0];
db.markGeocodeAttempted(first.id);
let n2=db.getImagesNeedingLocation(10).length;      // 1 left
console.log(n1, n2, (n1===2 && n2===1)?'PASS':'FAIL');
db.close();
"
```
Expected: `2 1 PASS`

- [ ] **Step 6: Commit**

```bash
git add src/database/schema.sql src/database/db.js src/server.js
git commit -m "$(printf 'fix: stop re-querying failed geocode lookups on every restart\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: Cache HEIF→JPEG conversions on disk

**Files:**
- Modify: `src/lib/heif.js` — add `getCachedJpegPath`
- Modify: `src/routes/images.js:56-123` (`sendImageOrHeif`)

**Interfaces:**
- Produces: `getCachedJpegPath(inputPath, cacheKey, quality)` → `Promise<string>` — returns the path to a cached JPEG, converting into the cache on a miss.

- [ ] **Step 1: Add a cached-conversion helper to heif.js**

In `src/lib/heif.js`, add `os`/`fs`/`path` are already imported. Add this function before `module.exports` (after `libheifInstallHint`, heif.js:109):
```javascript
/**
 * Convert a HEIF file to JPEG on disk, cached by a caller-supplied key.
 * Returns the path to the cached JPEG. On a cache hit no conversion runs.
 * The cache lives under data/heif-cache/ at the project root.
 *
 * @param {string} inputPath - Absolute path to the HEIF source.
 * @param {string} cacheKey - Stable key (e.g. `${id}-${file_modified}`).
 * @param {number} [quality=90] - JPEG quality (1-100).
 * @returns {Promise<string>} Absolute path to the cached JPEG.
 */
async function getCachedJpegPath(inputPath, cacheKey, quality = DEFAULT_QUALITY) {
    const cacheDir = path.join(__dirname, '..', '..', 'data', 'heif-cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    // Sanitize the key for use as a filename.
    const safeKey = String(cacheKey).replace(/[^a-zA-Z0-9._-]/g, '_');
    const cachedPath = path.join(cacheDir, `${safeKey}.jpg`);

    try {
        await fs.promises.access(cachedPath);
        return cachedPath; // hit
    } catch (_) {
        // miss — convert into a temp file, then atomically rename into place
        const tempPath = `${cachedPath}.tmp`;
        await convertHeifToFile(inputPath, tempPath, quality);
        await fs.promises.rename(tempPath, cachedPath);
        return cachedPath;
    }
}
```

And add it to the exports object (heif.js:111-118):
```javascript
module.exports = {
    HEIF_EXTENSIONS,
    DEFAULT_QUALITY,
    isHeif,
    convertHeifToFile,
    streamHeifAsJpeg,
    getCachedJpegPath,
    libheifInstallHint
};
```

- [ ] **Step 2: Use the cache for inline serving in images.js**

In `src/routes/images.js`, update the require (images.js:5):
```javascript
const { isHeif, streamHeifAsJpeg, libheifInstallHint } = require('../lib/heif');
```
to:
```javascript
const { isHeif, streamHeifAsJpeg, getCachedJpegPath, libheifInstallHint } = require('../lib/heif');
```

Then replace the HEIF branch of `sendImageOrHeif` (images.js:97-112):
```javascript
    if (heifFile) {
        try {
            await streamHeifAsJpeg(absolutePath, res, quality);
        } catch (conversionError) {
            if (!res.headersSent) {
                const installCmd = libheifInstallHint();
                console.error(`HEIF conversion error for ${context} ${image.filepath}:`, conversionError.message);
                console.error(`HEIF support may not be installed. Install with: ${installCmd}`);
                res.status(415).json({
                    error: isDownload ? 'HEIF format not supported for download' : 'HEIF format not supported',
                    message: `HEIF conversion failed. Make sure libheif is installed (${installCmd}).`
                });
            }
        }
        return;
    }
```
with:
```javascript
    if (heifFile) {
        try {
            // Inline serving caches the converted JPEG on disk (keyed by
            // id + file_modified, so the rotate mtime-bump invalidates it).
            // Downloads use a distinct quality and are not cached.
            if (!isDownload) {
                const cacheKey = `${image.id}-${image.file_modified}`;
                const cachedPath = await getCachedJpegPath(absolutePath, cacheKey, quality);
                res.sendFile(cachedPath, (err) => {
                    if (err && !res.headersSent) {
                        console.error(`Error sending cached HEIF for ${context} ${image.filepath}:`, err.message);
                        res.status(404).json({ error: 'Image file not found' });
                    }
                });
            } else {
                await streamHeifAsJpeg(absolutePath, res, quality);
            }
        } catch (conversionError) {
            if (!res.headersSent) {
                const installCmd = libheifInstallHint();
                console.error(`HEIF conversion error for ${context} ${image.filepath}:`, conversionError.message);
                console.error(`HEIF support may not be installed. Install with: ${installCmd}`);
                res.status(415).json({
                    error: isDownload ? 'HEIF format not supported for download' : 'HEIF format not supported',
                    message: `HEIF conversion failed. Make sure libheif is installed (${installCmd}).`
                });
            }
        }
        return;
    }
```

- [ ] **Step 3: Verify the cache helper hits on the second call**

This test needs no libheif — it stubs conversion by pre-creating the cache file, then confirms a hit does not re-convert. Run:
```bash
node -e "
const fs=require('fs'); const path=require('path');
const heif=require('./src/lib/heif.js');
const dir=path.join(__dirname,'data','heif-cache');
fs.mkdirSync(dir,{recursive:true});
const key='999-12345';
const target=path.join(dir, key+'.jpg');
try{fs.unlinkSync(target)}catch(_){}
fs.writeFileSync(target,'CACHED');           // simulate an existing cache entry
heif.getCachedJpegPath('/does/not/exist.heic', key, 90).then(p=>{
  console.log(p===target && fs.readFileSync(p,'utf8')==='CACHED' ? 'PASS':'FAIL');
  fs.unlinkSync(target);
}).catch(e=>{ console.log('FAIL', e.message); });
"
```
Expected: `PASS` (the existing cache file is returned; no conversion attempted on the nonexistent source).

- [ ] **Step 4: Ensure the cache directory is git-ignored**

Check `.gitignore` includes the data dir. Run:
```bash
grep -qE "^/?data/" .gitignore && echo "already ignored" || printf '\n# HEIF conversion cache and runtime data\n/data/\n' >> .gitignore
```
If it appends, `git add .gitignore`. If `data/` is already ignored, no change.

- [ ] **Step 5: Commit**

```bash
git add src/lib/heif.js src/routes/images.js .gitignore
git commit -m "$(printf 'fix: cache HEIF-to-JPEG conversions on disk for inline serving\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8: Fix frontend color-array bug and onload clobbering

**Files:**
- Modify: `src/public/js/app.js:1186-1188` (bad index) and `:962-975` (`extractDominantColors` wait branch)

- [ ] **Step 1: Fix the secondary/tertiary color index**

In `src/public/js/app.js`, replace (app.js:1186-1188):
```javascript
        const primaryColor = colors[0];
        const secondaryColor = colors[colors.length > 1 ? 1 : colors[0]];
        const tertiaryColor = colors[colors.length > 2 ? 2 : colors[0]];
```
with:
```javascript
        const primaryColor = colors[0];
        // Fall back to the primary color when fewer than 3 were extracted.
        // (The old code used a color OBJECT as an array index, yielding
        // undefined and a crash on 1-2 color images.)
        const secondaryColor = colors.length > 1 ? colors[1] : colors[0];
        const tertiaryColor = colors.length > 2 ? colors[2] : colors[0];
```

- [ ] **Step 2: Stop clobbering the display element's onload during extraction**

In `src/public/js/app.js`, replace the wait branch of `extractDominantColors` (app.js:962-975):
```javascript
async function extractDominantColors(imageElement, colorCount = 3) {
    // Wait for load if needed — recurse once the image is ready.
    if (!imageElement.complete) {
        console.warn('Image not complete, waiting...');
        return new Promise((resolve) => {
            imageElement.onload = () => {
                extractDominantColors(imageElement, colorCount).then(resolve);
            };
            imageElement.onerror = () => {
                console.error('Image failed to load for color extraction');
                resolve(FALLBACK_PALETTE_NORMAL);
            };
        });
    }
```
with:
```javascript
async function extractDominantColors(imageElement, colorCount = 3) {
    // Wait for load if needed. Do NOT reassign imageElement.onload/onerror —
    // that clobbers the display's own crossfade handlers. Extract from a
    // detached clone with the same src so the live element is untouched.
    if (!imageElement.complete) {
        console.warn('Image not complete, extracting from a detached clone...');
        return new Promise((resolve) => {
            const clone = new Image();
            if (imageElement.crossOrigin) clone.crossOrigin = imageElement.crossOrigin;
            clone.addEventListener('load', () => {
                extractDominantColors(clone, colorCount).then(resolve);
            }, { once: true });
            clone.addEventListener('error', () => {
                console.error('Image failed to load for color extraction');
                resolve(FALLBACK_PALETTE_NORMAL);
            }, { once: true });
            clone.src = imageElement.src;
        });
    }
```

- [ ] **Step 3: Verify the source has no remaining `imageElement.onload =` clobber and the bad index is gone**

Run:
```bash
grep -n "imageElement.onload = " src/public/js/app.js && echo "FAIL: clobber remains" || echo "PASS: no clobber"
grep -n "colors\[colors.length > 1 ? 1 : colors\[0\]\]" src/public/js/app.js && echo "FAIL: bad index remains" || echo "PASS: index fixed"
```
Expected: `PASS: no clobber` and `PASS: index fixed`.

- [ ] **Step 4: Verify app.js still parses**

Run:
```bash
node --check src/public/js/app.js && echo "PARSE OK"
```
Expected: `PARSE OK`

- [ ] **Step 5: Commit**

```bash
git add src/public/js/app.js
git commit -m "$(printf 'fix: correct matting color fallback index and stop onload clobber\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 9: Remove soft-delete dead code

**Files:**
- Modify: `src/database/schema.sql` (drop column + index from fresh schema)
- Modify: `src/database/db.js` (remove all `is_deleted` references and the `deleted` stat)
- Modify: `src/public/index.html` (remove Deleted stat row)
- Modify: `src/public/js/app.js` (remove `statDeleted`)
- Modify: `scripts/benchmark.js` (remove `is_deleted` filters)

**Interfaces:**
- Changes: `db.getStats()` no longer returns a `deleted` field.

Note: existing databases keep a harmless unused `is_deleted` column — no destructive column-drop migration is performed. Only fresh schemas omit it and all code references are removed.

- [ ] **Step 1: Remove the column and its index from the fresh schema**

In `src/database/schema.sql`, delete the line (schema.sql:20):
```sql
    is_deleted INTEGER DEFAULT 0,
```
and delete the index line (schema.sql:30):
```sql
CREATE INDEX IF NOT EXISTS idx_is_deleted ON images(is_deleted);
```

- [ ] **Step 2: Remove is_deleted from insertImage and the field map**

In `src/database/db.js`, in `IMAGE_FIELD_MAP` delete the entry (db.js:37):
```javascript
    isDeleted:        { col: 'is_deleted', type: 'bool' },
```

In `insertImage`, change the column list (db.js:99) from:
```javascript
                camera_model, camera_make, is_favorite, is_deleted, tags,
```
to:
```javascript
                camera_model, camera_make, is_favorite, tags,
```
and the VALUES list (db.js:104) from:
```javascript
                @cameraModel, @cameraMake, @isFavorite, @isDeleted, @tags,
```
to:
```javascript
                @cameraModel, @cameraMake, @isFavorite, @tags,
```
and remove the bound param (db.js:127):
```javascript
            isDeleted: imageData.isDeleted || 0,
```

- [ ] **Step 3: Remove is_deleted from UPDATABLE**

In `updateImage`, change (db.js:226):
```javascript
        const UPDATABLE = ['isFavorite', 'isDeleted', 'tags', 'locationCity', 'locationCountry', 'rotation'];
```
to:
```javascript
        const UPDATABLE = ['isFavorite', 'tags', 'locationCity', 'locationCountry', 'rotation'];
```

- [ ] **Step 4: Remove `WHERE is_deleted = 0` from remaining queries**

In `src/database/db.js`, make these edits:

`getImageById` (db.js:144):
```javascript
        const stmt = this.db.prepare('SELECT * FROM images WHERE id = ? AND is_deleted = 0');
```
→
```javascript
        const stmt = this.db.prepare('SELECT * FROM images WHERE id = ?');
```

`getAllImages` (db.js:154):
```javascript
        let query = 'SELECT * FROM images WHERE is_deleted = 0';
```
→
```javascript
        let query = 'SELECT * FROM images WHERE 1 = 1';
```

`getImagesCount` (db.js:198):
```javascript
        let query = 'SELECT COUNT(*) as count FROM images WHERE is_deleted = 0';
```
→
```javascript
        let query = 'SELECT COUNT(*) as count FROM images WHERE 1 = 1';
```

`getImagesNotResized` (db.js:262):
```javascript
        const stmt = this.db.prepare('SELECT * FROM images WHERE is_deleted = 0');
```
→
```javascript
        const stmt = this.db.prepare('SELECT * FROM images');
```

`cleanupOrphanedEntries` (db.js:279):
```javascript
        const stmt = this.db.prepare('SELECT id, filepath FROM images WHERE is_deleted = 0');
```
→
```javascript
        const stmt = this.db.prepare('SELECT id, filepath FROM images');
```

(Note: `getImagesNeedingLocation` was already updated in Task 6.)

- [ ] **Step 5: Remove the `deleted` stat from getStats**

In `src/database/db.js`, replace `getStats` (db.js:330-348):
```javascript
    getStats() {
        const total = this.getImagesCount(false);
        const favorites = this.getImagesCount(true);
        
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
```
with:
```javascript
    getStats() {
        const total = this.getImagesCount(false);
        const favorites = this.getImagesCount(true);

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
```

- [ ] **Step 6: Update the doc comments that mention is_deleted**

In `src/database/db.js`, the comment block above `IMAGE_FIELD_MAP` (db.js:17) reads:
```javascript
 * columns not exposed to clients (file_modified, is_deleted) are handled
```
change to:
```javascript
 * columns not exposed to clients (file_modified) are handled
```
and the comment inside `formatImage` (db.js:45):
```javascript
 * Note: fileModified, isDeleted, createdAt, updatedAt are intentionally
```
change to:
```javascript
 * Note: fileModified, createdAt, updatedAt are intentionally
```

- [ ] **Step 7: Remove the Deleted stat from the frontend**

In `src/public/index.html`, delete the stat-item block (index.html:202-205):
```html
                    <div class="stat-item">
                        <span class="stat-label">Deleted:</span>
                        <span id="statDeleted" class="stat-value">-</span>
                    </div>
```

In `src/public/js/app.js`, delete the element lookup (app.js:67):
```javascript
    statDeleted: document.getElementById('statDeleted'),
```
and delete the assignment (app.js:492):
```javascript
        elements.statDeleted.textContent = stats.deleted;
```

- [ ] **Step 8: Remove is_deleted filters from benchmark.js**

In `scripts/benchmark.js`, replace each of these (lines 175, 185, 190, 201):
```javascript
    const count = db.prepare('SELECT COUNT(*) as c FROM images WHERE is_deleted = 0').get().c;
```
→
```javascript
    const count = db.prepare('SELECT COUNT(*) as c FROM images').get().c;
```
```javascript
        db.prepare('SELECT * FROM images WHERE is_deleted = 0 ORDER BY date_taken DESC LIMIT 100').all();
```
→
```javascript
        db.prepare('SELECT * FROM images ORDER BY date_taken DESC LIMIT 100').all();
```
```javascript
        db.prepare('SELECT * FROM images WHERE is_deleted = 0 ORDER BY RANDOM() LIMIT 1').get();
```
→
```javascript
        db.prepare('SELECT * FROM images ORDER BY RANDOM() LIMIT 1').get();
```
```javascript
        const rows = db.prepare('SELECT id, filepath FROM images WHERE is_deleted = 0').all();
```
→
```javascript
        const rows = db.prepare('SELECT id, filepath FROM images').all();
```

- [ ] **Step 9: Verify no is_deleted references remain and getStats has no `deleted`**

Run:
```bash
grep -rn "is_deleted\|isDeleted\|statDeleted\|stats.deleted" src/ scripts/ && echo "FAIL: references remain" || echo "PASS: none remain"
node -e "
const fs=require('fs'); const p='/tmp/pf-stats.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const db=new DB(p);
const s=db.getStats();
console.log(JSON.stringify(s), ('deleted' in s)?'FAIL':'PASS');
db.close();
"
```
Expected: `PASS: none remain` and a stats object with no `deleted` key printing `PASS`.

- [ ] **Step 10: Commit**

```bash
git add src/database/schema.sql src/database/db.js src/public/index.html src/public/js/app.js scripts/benchmark.js
git commit -m "$(printf 'refactor: remove dead soft-delete code (column, stat, filters)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 10: Rework DB reset to a real method (no Object.assign swap)

**Files:**
- Modify: `src/database/db.js` — add `reset()`
- Modify: `src/server.js:169-214` (reset endpoint)

**Interfaces:**
- Produces: `db.reset()` — closes, deletes the DB files, recreates schema, reopens; preserves the manager instance identity.

- [ ] **Step 1: Add a reset() method to DatabaseManager**

In `src/database/db.js`, the constructor sets `this.db = new Database(dbPath)`. To reset in place we need the path. Add `this.dbPath = dbPath;` in the constructor, immediately after the `mkdirSync` block (db.js:77), before `this.db = new Database(dbPath);`:
```javascript
        this.dbPath = dbPath;
```

Then add a `reset()` method right before `close()` (db.js:372):
```javascript
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
```

- [ ] **Step 2: Use db.reset() in the server endpoint**

In `src/server.js`, replace the reset endpoint body (server.js:169-214):
```javascript
app.post('/api/database/reset', async (req, res) => {
    try {
        console.log('Database reset requested...');
        
        // Close current database connection
        db.close();
        
        // Delete database files
        const dbFiles = [
            dbPath,
            `${dbPath}-shm`,
            `${dbPath}-wal`
        ];
        
        for (const file of dbFiles) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
                console.log(`Deleted: ${file}`);
            }
        }
        
        // Reinitialize database (creates new one)
        const DatabaseManager = require('./database/db');
        const newDb = new DatabaseManager(dbPath);
        Object.assign(db, newDb); // Replace old db instance
        
        // Re-index photos
        console.log('Re-indexing photos...');
        await scanner.scanDirectory(photoDir, { forceReindex: true });
        
        // Refresh slideshow
        slideshowEngine.refreshImageList();
        
        const stats = db.getStats();
        console.log('Database reset complete!');
        
        res.json({
            success: true,
            message: 'Database reset and re-indexed successfully',
            stats
        });
    } catch (error) {
        console.error('Error resetting database:', error);
        res.status(500).json({ error: 'Failed to reset database', details: error.message });
    }
});
```
with:
```javascript
app.post('/api/database/reset', async (req, res) => {
    try {
        console.log('Database reset requested...');

        // Reset the database in place (preserves the manager instance).
        db.reset();

        // Re-index photos
        console.log('Re-indexing photos...');
        await scanner.scanDirectory(photoDir, { forceReindex: true });

        // Refresh slideshow
        slideshowEngine.refreshImageList();

        const stats = db.getStats();
        console.log('Database reset complete!');

        res.json({
            success: true,
            message: 'Database reset and re-indexed successfully',
            stats
        });
    } catch (error) {
        console.error('Error resetting database:', error);
        res.status(500).json({ error: 'Failed to reset database', details: error.message });
    }
});
```

The `fs` require at the top of server.js (server.js:3) is still used elsewhere (`fs.existsSync(photoDir)`), so leave it.

- [ ] **Step 3: Verify reset preserves instance identity and empties the DB**

Run:
```bash
node -e "
const fs=require('fs'); const p='/tmp/pf-reset.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const db=new DB(p);
db.insertImage({filepath:'/a.jpg',filename:'a.jpg',fileModified:Date.now()});
const before=db.getImagesCount();
const sameRef=db;
db.reset();
const after=db.getImagesCount();
console.log(before, after, (sameRef===db && before===1 && after===0)?'PASS':'FAIL');
db.close();
"
```
Expected: `1 0 PASS`

- [ ] **Step 4: Commit**

```bash
git add src/database/db.js src/server.js
git commit -m "$(printf 'refactor: reset database via DatabaseManager.reset instead of Object.assign\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 11: Rework self-restart to exit-and-let-supervisor-respawn

**Files:**
- Modify: `src/routes/settings.js:1-8` (imports), `:76-97` (`/restart`)

**Behavior change (approved):** `/restart` now exits the process cleanly and relies on the supervisor (systemd `Restart=always`, Electron's child-death handler) to respawn. When no supervisor is detected (bare `npm start`), it logs a clear warning and still exits, so the operator understands the process will not come back on its own.

- [ ] **Step 1: Detect a supervisor via environment**

At the top of `src/routes/settings.js`, replace the imports (settings.js:1-7):
```javascript
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const { PROJECT_ROOT } = require('../lib/paths');
const { imageMessage, settingsMessage } = require('../lib/messages');
const { SettingsValidationError } = require('../slideshow/engine');
const router = express.Router();
```
with:
```javascript
const express = require('express');
const { imageMessage, settingsMessage } = require('../lib/messages');
const { SettingsValidationError } = require('../slideshow/engine');
const router = express.Router();

/**
 * True when the process is managed by something that will restart it on
 * exit: systemd (INVOCATION_ID / JOURNAL_STREAM set) or the Electron
 * wrapper (ELECTRON_APP=1, whose child-death handler relaunches the server).
 */
function isSupervised() {
    return process.env.ELECTRON_APP === '1'
        || !!process.env.INVOCATION_ID
        || !!process.env.JOURNAL_STREAM;
}
```
(`spawn`, `path`, and `PROJECT_ROOT` are no longer used and are removed.)

- [ ] **Step 2: Replace the /restart handler**

In `src/routes/settings.js`, replace the restart route (settings.js:76-97):
```javascript
    // Restart the photo frame process
    router.post('/restart', (req, res) => {
        try {
            res.json({ success: true, message: 'Restarting...' });

            // Delay restart to allow response to be sent
            setTimeout(() => {
                console.log('Restart requested, spawning replacement process...');
                const serverPath = path.join(PROJECT_ROOT, 'src', 'server.js');
                const child = spawn(process.argv[0], [serverPath, ...process.argv.slice(2)], {
                    stdio: 'inherit',
                    detached: true,
                    cwd: PROJECT_ROOT
                });
                child.unref();
                process.exit(0);
            }, 500);
        } catch (error) {
            console.error('Error restarting:', error);
            res.status(500).json({ error: 'Failed to restart' });
        }
    });
```
with:
```javascript
    // Restart the photo frame process by exiting cleanly and letting the
    // supervisor (systemd / Electron) respawn it.
    router.post('/restart', (req, res) => {
        try {
            const supervised = isSupervised();
            res.json({
                success: true,
                message: supervised
                    ? 'Restarting...'
                    : 'Exiting. No supervisor detected — the server will not restart on its own.'
            });

            // Delay exit to allow the response to flush.
            setTimeout(() => {
                if (supervised) {
                    console.log('Restart requested; exiting for supervisor to respawn...');
                } else {
                    console.warn('Restart requested but no supervisor detected '
                        + '(not systemd/Electron). Exiting — start again with `npm start`.');
                }
                process.exit(0);
            }, 500);
        } catch (error) {
            console.error('Error restarting:', error);
            res.status(500).json({ error: 'Failed to restart' });
        }
    });
```

- [ ] **Step 3: Verify supervisor detection and that settings.js parses**

Run:
```bash
node --check src/routes/settings.js && echo "PARSE OK"
node -e "
process.env.INVOCATION_ID='abc';
delete require.cache[require.resolve('./src/routes/settings.js')];
// isSupervised is module-private; assert via env logic directly:
const supervised = process.env.ELECTRON_APP==='1' || !!process.env.INVOCATION_ID || !!process.env.JOURNAL_STREAM;
console.log(supervised ? 'PASS (supervised)' : 'FAIL');
"
```
Expected: `PARSE OK` and `PASS (supervised)`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/settings.js
git commit -m "$(printf 'refactor: restart by exiting for supervisor respawn instead of detached spawn\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 12: Add the auth config block and a startup warning

**Files:**
- Modify: `config.json` (add `auth`)
- Modify: `src/server.js` (startup warning near config load, server.js:15-16)

**Interfaces:**
- Produces: `config.auth = { enabled, secret, trustLoopback, cookieName }`.

- [ ] **Step 1: Add the auth block to config.json**

In `config.json`, add an `auth` block after the `resize` block (before the closing brace, config.json:19-23). Change:
```json
  "resize": {
    "maxWidth": 3840,
    "maxHeight": 2160,
    "runOnStartup": true
  }
}
```
to:
```json
  "resize": {
    "maxWidth": 3840,
    "maxHeight": 2160,
    "runOnStartup": true
  },
  "auth": {
    "enabled": false,
    "secret": null,
    "trustLoopback": true,
    "cookieName": "pf_auth"
  }
}
```

Default `enabled: false` so existing installs are unaffected until the operator sets a secret and enables auth in `~/picframe-config.json`.

- [ ] **Step 2: Add a startup warning when auth is enabled without a secret**

In `src/server.js`, right after `const config = loadConfig();` (server.js:16), add:
```javascript

// Auth sanity check: enabled but no secret → fail OPEN with a loud warning so
// the frame is never bricked into a locked-out state.
if (config.auth && config.auth.enabled && !config.auth.secret) {
    console.warn('⚠  auth.enabled is true but auth.secret is not set — '
        + 'authentication is DISABLED. Set auth.secret in ~/picframe-config.json.');
}
```

- [ ] **Step 3: Verify config parses and the warning fires**

Run:
```bash
node -e "const {loadConfig}=require('./src/config.js'); const c=loadConfig(); console.log('auth' in c ? 'PASS':'FAIL', JSON.stringify(c.auth));"
node --check src/server.js && echo "PARSE OK"
```
Expected: `PASS {"enabled":false,"secret":null,"trustLoopback":true,"cookieName":"pf_auth"}` and `PARSE OK`.

- [ ] **Step 4: Commit**

```bash
git add config.json src/server.js
git commit -m "$(printf 'feat: add auth config block and startup safety warning\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 13: Add the shared-secret auth middleware

**Files:**
- Create: `src/middleware/auth.js`

**Interfaces:**
- Produces: `createAuthMiddleware(config)` → Express middleware `(req, res, next)`.
- Behavior: pass-through when disabled/no-secret; loopback bypass when `trustLoopback`; otherwise require the secret via cookie `pf_auth`, `Authorization: Bearer`, or `X-Auth-Token`. `/login` is always exempt. Unauthenticated `/api/*` → 401 JSON; other paths → 302 redirect to `/login?next=<path>`.

- [ ] **Step 1: Write the middleware**

Create `src/middleware/auth.js`:
```javascript
const crypto = require('crypto');

/**
 * Loopback addresses that identify the physical frame talking to its own
 * server. IPv4, IPv6, and IPv4-mapped-IPv6 forms.
 */
function isLoopback(address) {
    if (!address) return false;
    return address === '127.0.0.1'
        || address === '::1'
        || address === '::ffff:127.0.0.1'
        || address.startsWith('127.');
}

/**
 * Parse a Cookie header into a plain object. Avoids adding cookie-parser as
 * a dependency (Express's res.cookie() is built in for the write side).
 */
function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    }
    return out;
}

/**
 * Constant-time string comparison that tolerates differing lengths by
 * comparing SHA-256 digests (always equal length).
 */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/**
 * Extract a presented secret from the request: Authorization: Bearer,
 * X-Auth-Token header, or the auth cookie.
 */
function presentedSecret(req, cookieName) {
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const hdr = req.headers['x-auth-token'];
    if (hdr) return String(hdr);
    const cookies = parseCookies(req.headers['cookie']);
    if (cookies[cookieName]) return cookies[cookieName];
    return null;
}

/**
 * Build the auth middleware. The physical frame (loopback) is always allowed
 * when trustLoopback is set; every other client must present the shared
 * secret. Fails OPEN when disabled or no secret is configured.
 */
function createAuthMiddleware(config) {
    const auth = (config && config.auth) || {};
    const { enabled, secret, trustLoopback = true, cookieName = 'pf_auth' } = auth;

    return function authMiddleware(req, res, next) {
        // Disabled or misconfigured → fail open.
        if (!enabled || !secret) return next();

        // The login page/handler must always be reachable.
        if (req.path === '/login') return next();

        // The physical frame talking to its own server.
        const remote = req.socket && req.socket.remoteAddress;
        if (trustLoopback && isLoopback(remote)) return next();

        // Everyone else must present the secret.
        const provided = presentedSecret(req, cookieName);
        if (provided && safeEqual(provided, secret)) return next();

        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const nextParam = encodeURIComponent(req.originalUrl || req.url || '/');
        return res.redirect(302, `/login?next=${nextParam}`);
    };
}

module.exports = { createAuthMiddleware, isLoopback, parseCookies, safeEqual };
```

- [ ] **Step 2: Verify the middleware logic**

Run:
```bash
node -e "
const { createAuthMiddleware, safeEqual } = require('./src/middleware/auth.js');
// safeEqual basic
console.log(safeEqual('abc','abc')===true && safeEqual('abc','abcd')===false ? 'PASS safeEqual':'FAIL safeEqual');
const mw = createAuthMiddleware({ auth:{ enabled:true, secret:'pin123', trustLoopback:true, cookieName:'pf_auth' } });
function run(req){ let out={code:200,redir:null,json:null,nexted:false};
  const res={ status(c){out.code=c; return this;}, json(j){out.json=j; return this;}, redirect(c,u){out.code=c; out.redir=u;} };
  mw(req, res, ()=>{ out.nexted=true; }); return out; }
// loopback bypass
console.log(run({path:'/api/stats', originalUrl:'/api/stats', socket:{remoteAddress:'127.0.0.1'}, headers:{}}).nexted ? 'PASS loopback':'FAIL loopback');
// LAN api no token -> 401
let r=run({path:'/api/stats', originalUrl:'/api/stats', socket:{remoteAddress:'192.168.1.9'}, headers:{}});
console.log(r.code===401 ? 'PASS lan-401':'FAIL lan-401');
// LAN page no token -> redirect to /login
r=run({path:'/remote/', originalUrl:'/remote/', socket:{remoteAddress:'192.168.1.9'}, headers:{}});
console.log(r.code===302 && r.redir.startsWith('/login?next=') ? 'PASS redirect':'FAIL redirect');
// LAN with correct bearer -> next
r=run({path:'/api/stats', originalUrl:'/api/stats', socket:{remoteAddress:'192.168.1.9'}, headers:{authorization:'Bearer pin123'}});
console.log(r.nexted ? 'PASS bearer':'FAIL bearer');
// LAN with correct cookie -> next
r=run({path:'/api/stats', originalUrl:'/api/stats', socket:{remoteAddress:'192.168.1.9'}, headers:{cookie:'pf_auth=pin123'}});
console.log(r.nexted ? 'PASS cookie':'FAIL cookie');
// /login always exempt
r=run({path:'/login', originalUrl:'/login', socket:{remoteAddress:'192.168.1.9'}, headers:{}});
console.log(r.nexted ? 'PASS login-exempt':'FAIL login-exempt');
"
```
Expected: all seven lines print `PASS ...`.

- [ ] **Step 3: Commit**

```bash
git add src/middleware/auth.js
git commit -m "$(printf 'feat: add shared-secret auth middleware with loopback bypass\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 14: Add the login flow and wire auth into the server

**Files:**
- Create: `src/routes/login.js`
- Modify: `src/server.js` — `express.urlencoded`, mount auth middleware + login routes

**Interfaces:**
- Consumes: `createAuthMiddleware` (Task 13), `config.auth`.
- Produces: `createLoginRoutes(config)` → Express router serving `GET /login` (form) and `POST /login` (validate → set cookie → redirect), with an in-memory brute-force limiter.

- [ ] **Step 1: Write the login routes**

Create `src/routes/login.js`:
```javascript
const express = require('express');
const { safeEqual } = require('../middleware/auth');

/**
 * Login routes for the shared-secret scheme. GET /login renders a minimal
 * self-contained form (no external assets, so it works even while the rest
 * of the site is gated). POST /login validates the secret, sets an HttpOnly
 * cookie, and redirects. A small in-memory limiter throttles brute force.
 */
function createLoginRoutes(config) {
    const router = express.Router();
    const auth = (config && config.auth) || {};
    const cookieName = auth.cookieName || 'pf_auth';
    const secret = auth.secret;

    // ip -> { count, first } within a rolling window
    const attempts = new Map();
    const MAX_ATTEMPTS = 10;
    const WINDOW_MS = 5 * 60 * 1000;

    function tooManyAttempts(ip) {
        const now = Date.now();
        const rec = attempts.get(ip);
        if (!rec || now - rec.first > WINDOW_MS) return false;
        return rec.count >= MAX_ATTEMPTS;
    }

    function recordFailure(ip) {
        const now = Date.now();
        const rec = attempts.get(ip);
        if (!rec || now - rec.first > WINDOW_MS) {
            attempts.set(ip, { count: 1, first: now });
        } else {
            rec.count++;
        }
    }

    function loginPage(nextUrl, error) {
        const safeNext = String(nextUrl || '/').replace(/"/g, '&quot;');
        const errHtml = error ? `<p class="err">${error}</p>` : '';
        return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Picture Frame — Sign in</title>
<style>
  body{font-family:system-ui,sans-serif;background:#1a1a1a;color:#eee;display:flex;
    min-height:100vh;align-items:center;justify-content:center;margin:0}
  form{background:#262626;padding:2rem;border-radius:12px;width:min(90vw,320px)}
  h1{font-size:1.1rem;margin:0 0 1rem}
  input{width:100%;box-sizing:border-box;padding:.7rem;margin:.3rem 0 1rem;
    border-radius:8px;border:1px solid #444;background:#1a1a1a;color:#eee;font-size:1rem}
  button{width:100%;padding:.7rem;border:0;border-radius:8px;background:#4a7dff;
    color:#fff;font-size:1rem;cursor:pointer}
  .err{color:#ff7676;font-size:.9rem;margin:.2rem 0 .6rem}
</style></head><body>
<form method="POST" action="/login">
  <h1>Picture Frame</h1>
  ${errHtml}
  <input type="password" name="secret" placeholder="Access code" autofocus autocomplete="current-password">
  <input type="hidden" name="next" value="${safeNext}">
  <button type="submit">Sign in</button>
</form></body></html>`;
    }

    router.get('/login', (req, res) => {
        res.set('Content-Type', 'text/html').send(loginPage(req.query.next, null));
    });

    router.post('/login', (req, res) => {
        const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
        const nextUrl = (req.body && req.body.next) || '/';

        if (tooManyAttempts(ip)) {
            return res.status(429).set('Content-Type', 'text/html')
                .send(loginPage(nextUrl, 'Too many attempts. Wait a few minutes.'));
        }

        const provided = (req.body && req.body.secret) || '';
        if (secret && safeEqual(provided, secret)) {
            res.cookie(cookieName, secret, {
                httpOnly: true,
                sameSite: 'lax',
                maxAge: 365 * 24 * 60 * 60 * 1000 // 1 year
            });
            // Only allow same-site relative redirects.
            const dest = nextUrl.startsWith('/') ? nextUrl : '/';
            return res.redirect(302, dest);
        }

        recordFailure(ip);
        return res.status(401).set('Content-Type', 'text/html')
            .send(loginPage(nextUrl, 'Incorrect access code.'));
    });

    return router;
}

module.exports = createLoginRoutes;
```

- [ ] **Step 2: Wire urlencoded, auth middleware, and login routes into server.js**

In `src/server.js`, add the requires near the other route requires (after server.js:13):
```javascript
const { createAuthMiddleware } = require('./middleware/auth');
const createLoginRoutes = require('./routes/login');
```

Add urlencoded body parsing right after `app.use(express.json());` (server.js:20):
```javascript
app.use(express.urlencoded({ extended: false }));
```

Mount the login routes and auth middleware BEFORE the API routes and static serving. Insert immediately after the urlencoded line and before the `// Resolve paths` comment is fine, but the middleware must sit before all protected routes. Place this block right before the `// API Routes` comment (server.js:66):
```javascript
// Login routes (always reachable) then the auth gate. Everything mounted
// after this point is protected for non-loopback clients when auth is on.
app.use(createLoginRoutes(config));
app.use(createAuthMiddleware(config));

```

- [ ] **Step 3: Verify the end-to-end auth flow against a running server**

Start a server with auth enabled on a throwaway config, then exercise it. Run:
```bash
# Launch with auth on via env-injected user config override is not available,
# so use a temp home with a user config that enables auth.
TMPHOME=$(mktemp -d)
cat > "$TMPHOME/picframe-config.json" <<'JSON'
{ "photoDirectory": "/tmp/pf-nophotos", "databasePath": "/tmp/pf-authtest.db",
  "auth": { "enabled": true, "secret": "pin123", "trustLoopback": false, "cookieName": "pf_auth" } }
JSON
rm -f /tmp/pf-authtest.db /tmp/pf-authtest.db-wal /tmp/pf-authtest.db-shm
HOME="$TMPHOME" node src/server.js --dev >/tmp/pf-authtest.log 2>&1 &
SRV=$!
sleep 2
echo "--- no token (expect 401) ---"; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/stats
echo "--- bad login (expect 401) ---"; curl -s -o /dev/null -w "%{http_code}\n" -d "secret=nope" http://127.0.0.1:3000/login
echo "--- good bearer (expect 200) ---"; curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer pin123" http://127.0.0.1:3000/api/stats
echo "--- login sets cookie + redirect (expect 302) ---"; curl -s -o /dev/null -w "%{http_code}\n" -d "secret=pin123&next=/remote/" http://127.0.0.1:3000/login
kill $SRV 2>/dev/null
```
Expected output (the four codes): `401`, `401`, `200`, `302`. (`trustLoopback:false` is used here specifically so the loopback test client is still challenged.)

- [ ] **Step 4: Verify server.js parses**

Run:
```bash
node --check src/server.js && echo "PARSE OK"
```
Expected: `PARSE OK`

- [ ] **Step 5: Commit**

```bash
git add src/routes/login.js src/server.js
git commit -m "$(printf 'feat: add login flow and mount shared-secret auth gate\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 15: Document authentication

**Files:**
- Modify: `README.md` (add an Authentication section)
- Modify: `CLAUDE.md` (note the auth middleware and config)

- [ ] **Step 1: Add an Authentication section to README.md**

Append a new section to `README.md` (place it near the configuration docs; if unsure, add before the final section):
```markdown
## Authentication

The picture frame supports an optional shared-secret gate. The **physical
frame display is always open over loopback** (`127.0.0.1`), so the wall-mounted
screen never needs a login. Every other client — LAN browsers, the phone
remote, Stream Deck — must present the secret when auth is enabled.

Enable it in `~/picframe-config.json`:

```json
{
  "auth": {
    "enabled": true,
    "secret": "your-access-code",
    "trustLoopback": true,
    "cookieName": "pf_auth"
  }
}
```

- `enabled` — turn the gate on. If `enabled` is true but `secret` is empty,
  auth **fails open** (disabled) with a startup warning, so the frame is never
  locked out.
- `secret` — the shared access code / PIN.
- `trustLoopback` — when true (default), requests from the device itself
  bypass auth. Set to false to challenge even local browsers.

**How clients authenticate:**
- Browsers: visit any protected page and you are redirected to `/login`;
  entering the code sets an HttpOnly cookie for a year.
- API clients (Stream Deck, scripts): send `Authorization: Bearer <secret>`
  or `X-Auth-Token: <secret>`.

Login is rate-limited to 10 attempts per 5 minutes per IP.
```

- [ ] **Step 2: Note auth in CLAUDE.md**

In `CLAUDE.md`, under the **Routes** or **Services** area, add a bullet documenting the middleware. Add after the existing Routes list:
```markdown
**Auth** (`src/middleware/auth.js`, `src/routes/login.js`): Optional shared-secret gate. Loopback (the physical frame) is always allowed when `auth.trustLoopback` is set; all other clients must present `config.auth.secret` via the `pf_auth` cookie (set by `/login`), `Authorization: Bearer`, or `X-Auth-Token`. Fails open when disabled or unconfigured. Configured under `auth` in config.
```

- [ ] **Step 3: Verify the docs mention the key facts**

Run:
```bash
grep -q "Authentication" README.md && grep -q "trustLoopback" README.md && grep -q "auth.js" CLAUDE.md && echo "PASS docs" || echo "FAIL docs"
```
Expected: `PASS docs`

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "$(printf 'docs: document optional shared-secret authentication\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Final verification (after all tasks)

- [ ] **Full smoke test with a real photo directory** (per the `verify` skill): start the server normally, confirm the slideshow advances, drop a new image into the photo dir and confirm it enters the running slideshow (Task 4), serve a HEIF twice and confirm the second is served from `data/heif-cache/` (Task 7), toggle a favorite, delete an image, and reset the DB from the settings panel (Task 10). Confirm the display renders with matting on 1-2 color images without the old crash (Task 8).
- [ ] **Auth on/off**: with `auth.enabled:false` (default), everything works with no login. With `auth.enabled:true` + a secret, the loopback display still works and a LAN client is challenged.

## Self-Review notes

- **Spec coverage:** Section 1 (auth) → Tasks 12-15. Section 2a (DB reset) → Task 10. Section 2b (restart) → Task 11. Section 3 items 1-8 → Tasks 4, 7, 6, 8, 2, 1, 3, 5 respectively. Section 4 (soft-delete removal) → Task 9. All spec sections are covered.
- **Ordering dependency:** Task 3 wires the `onChange` option into `FileWatcher` before Task 4 implements it; Task 3 notes the option is ignored until then, so intermediate state is safe. Task 6 removes the `is_deleted = 0` filter from `getImagesNeedingLocation` ahead of Task 9's broader removal; noted inline.
- **Type consistency:** `listVersion`/`smartWeightsListVersion` (Task 2), `seedSetting` (Task 5), `markGeocodeAttempted`/`getImagesNeedingLocation` (Task 6), `getCachedJpegPath` (Task 7), `db.reset`/`this.dbPath` (Task 10), `createAuthMiddleware`/`safeEqual`/`createLoginRoutes` (Tasks 13-14) are defined before use and referenced consistently.
