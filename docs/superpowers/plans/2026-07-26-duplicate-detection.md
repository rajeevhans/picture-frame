# Duplicate Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect exact and near-duplicate images, review/act on them from settings (manual + auto-resolve), and carry a deleted duplicate's favorite/tags/artistic-score onto the kept image.

**Architecture:** Pure hash/tree libs (`src/lib/perceptualHash.js`, `src/lib/bkTree.js`) → a detection service (`src/services/duplicateDetection.js`) that content-hashes files, backfills hashes in throttled batches, and groups duplicates (exact via SQL, similar via BK-tree + union-find) → an Express router (`/api/duplicates`) → a "Duplicates" section in the settings panel. New DB columns/tables via the existing idempotent `migrate()` pattern.

**Tech Stack:** Node.js, Express 4, better-sqlite3 (synchronous), Sharp, vanilla JS frontend. No new dependencies.

## Global Constraints

- **No test framework exists** and none is added. Every task is verified by a runnable `node -e` check or `curl`, with expected output shown; run it and confirm before marking done.
- **Preserve all existing behavior.** This is additive; the feature is dormant unless scanned.
- **Small atomic commits** — one task, one commit; Conventional Commits (`feat:`/`fix:`/`refactor:`). End every commit body with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Run node from the project root `/Users/rhans/picture-frame`; do not `cd` elsewhere; `git add` only the files each task names.
- New DB columns/tables are added in `migrate()` with the `if (!cols.includes(...)) ALTER TABLE` pattern (never destructive), matching `geocode_attempted`/`artistic_score`.
- Perceptual hash = 64-bit dHash stored as 16 lowercase hex chars. Hamming distance is on the 64-bit value.
- Keep policy (keeper selection): highest `width*height`, then highest `artistic_score` (nulls last), then earliest `date_taken` (nulls last).

---

## File Structure

**New:**
- `src/lib/perceptualHash.js` — `dHash(path)`, `hammingDistance(a,b)` (pure)
- `src/lib/bkTree.js` — BK-tree (pure)
- `src/services/duplicateDetection.js` — engine/orchestration
- `src/routes/duplicates.js` — `/api/duplicates` router
- `src/public/js/duplicates.js` — settings review UI

**Modified:**
- `src/database/schema.sql`, `src/database/db.js` — columns, `duplicate_group_members` table, methods
- `src/indexer/scanner.js` — hash on ingest
- `src/routes/images.js` — reset `hash_computed` on rotate
- `src/lib/messages.js` — `duplicateScanMessage`
- `src/server.js` — construct service, mount router
- `config.json` — `duplicates` block
- `src/public/index.html`, `src/public/js/app.js` — Duplicates settings section + SSE case

---

## Task 1: Perceptual hash library (dHash + Hamming)

**Files:**
- Create: `src/lib/perceptualHash.js`

**Interfaces:**
- Produces: `dHash(imagePath: string) => Promise<string>` (16 hex chars); `hammingDistance(hexA: string, hexB: string) => number`.

- [ ] **Step 1: Write the module**

Create `src/lib/perceptualHash.js`:
```javascript
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
```

- [ ] **Step 2: Verify Hamming + dHash behavior**

Run (creates two tiny test images with Sharp — a solid and a near-solid — and checks distances):
```bash
node -e "
const { dHash, hammingDistance } = require('./src/lib/perceptualHash.js');
const sharp = require('sharp');
// hamming correctness on known hex
const h = hammingDistance('0000000000000000','000000000000000f'); // 4 bits set
console.log('hamming 0..f =', h, h===4?'PASS':'FAIL');
(async () => {
  const a = await sharp({create:{width:64,height:64,channels:3,background:{r:10,g:10,b:10}}}).png().toBuffer();
  // gradient-ish image (different)
  const b = await sharp({create:{width:64,height:64,channels:3,background:{r:200,g:50,b:10}}})
    .composite([{input:{create:{width:32,height:64,channels:3,background:{r:0,g:0,b:0}}},left:0,top:0}]).png().toBuffer();
  const ha = await dHash(a); const hb = await dHash(b);
  console.log('dHash lengths', ha.length, hb.length, (ha.length===16&&hb.length===16)?'PASS':'FAIL');
  // identical input -> distance 0
  const ha2 = await dHash(a);
  console.log('identical dist', hammingDistance(ha,ha2), hammingDistance(ha,ha2)===0?'PASS':'FAIL');
  // clearly different images -> distance > 0
  console.log('different dist', hammingDistance(ha,hb), hammingDistance(ha,hb)>0?'PASS':'FAIL');
})().catch(e=>console.log('FAIL',e.message));
"
```
Expected: four `PASS` lines (`hamming 0..f = 4 PASS`, `dHash lengths 16 16 PASS`, `identical dist 0 PASS`, `different dist <n> PASS`).

- [ ] **Step 3: Commit**
```bash
git add src/lib/perceptualHash.js
git commit -m "$(printf 'feat: add perceptual hash (dHash) + hamming distance lib\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: BK-tree library

**Files:**
- Create: `src/lib/bkTree.js`

**Interfaces:**
- Produces: `class BKTree { constructor(distanceFn); insert(key, value); query(key, maxDistance) => Array<{key, value, distance}> }`

- [ ] **Step 1: Write the module**

Create `src/lib/bkTree.js`:
```javascript
/**
 * BK-tree over a metric distance function (here: Hamming distance on
 * perceptual hashes). Enables efficient "all neighbors within d" queries
 * without O(n^2) pairwise comparison.
 */
class BKTree {
    /** @param {(a: any, b: any) => number} distanceFn - integer metric */
    constructor(distanceFn) {
        this.distance = distanceFn;
        this.root = null;
    }

    insert(key, value) {
        const node = { key, value, children: new Map() };
        if (!this.root) { this.root = node; return; }
        let cur = this.root;
        for (;;) {
            const d = this.distance(key, cur.key);
            const child = cur.children.get(d);
            if (!child) { cur.children.set(d, node); return; }
            cur = child;
        }
    }

    /** All inserted entries within maxDistance of key (excludes nothing by identity). */
    query(key, maxDistance) {
        const results = [];
        if (!this.root) return results;
        const stack = [this.root];
        while (stack.length) {
            const node = stack.pop();
            const d = this.distance(key, node.key);
            if (d <= maxDistance) results.push({ key: node.key, value: node.value, distance: d });
            const lo = d - maxDistance, hi = d + maxDistance;
            for (const [edge, child] of node.children) {
                if (edge >= lo && edge <= hi) stack.push(child);
            }
        }
        return results;
    }
}

module.exports = BKTree;
```

- [ ] **Step 2: Verify neighbor queries**

Run:
```bash
node -e "
const BKTree = require('./src/lib/bkTree.js');
const { hammingDistance } = require('./src/lib/perceptualHash.js');
const t = new BKTree(hammingDistance);
const items = {
  a:'0000000000000000', b:'0000000000000001', c:'0000000000000003', d:'ffffffffffffffff'
};
for (const [id,h] of Object.entries(items)) t.insert(h, id);
const near = t.query('0000000000000000', 2).map(r=>r.value).sort();
console.log('within2:', JSON.stringify(near), JSON.stringify(near)===JSON.stringify(['a','b','c'])?'PASS':'FAIL');
const far = t.query('ffffffffffffffff', 2).map(r=>r.value).sort();
console.log('near-d:', JSON.stringify(far), JSON.stringify(far)===JSON.stringify(['d'])?'PASS':'FAIL');
"
```
Expected: `within2: ["a","b","c"] PASS` and `near-d: ["d"] PASS` (a=0, b=1 bit, c=2 bits are within 2; d is all-ones).

- [ ] **Step 3: Commit**
```bash
git add src/lib/bkTree.js
git commit -m "$(printf 'feat: add BK-tree for hamming near-neighbor search\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Schema, migration, and hash-storage DB methods

**Files:**
- Modify: `src/database/schema.sql` (fresh-schema columns/table)
- Modify: `src/database/db.js` (`migrate()` ~100-117; new methods)

**Interfaces:**
- Produces: `db.getImagesNeedingHash(limit)`, `db.countImagesNeedingHash()`, `db.setHashes(id, contentHash, perceptualHash)`, `db.resetHashComputed(id)`.

- [ ] **Step 1: Add fresh-schema columns + duplicate-group table**

In `src/database/schema.sql`, add three columns inside the `images` CREATE TABLE, after `tags TEXT,` (line 21):
```sql
    content_hash TEXT,
    perceptual_hash TEXT,
    hash_computed INTEGER DEFAULT 0,
```
Add an index after `idx_filepath` (line 31):
```sql
CREATE INDEX IF NOT EXISTS idx_content_hash ON images(content_hash);
```
Add a new table after the `settings` table block (after line 38):
```sql
-- Duplicate detection: rebuilt on each scan
CREATE TABLE IF NOT EXISTS duplicate_group_members (
    group_id INTEGER NOT NULL,
    image_id INTEGER NOT NULL,
    group_type TEXT NOT NULL,          -- 'exact' | 'similar'
    is_suggested_keeper INTEGER DEFAULT 0,
    is_oversized INTEGER DEFAULT 0,
    is_auto_eligible INTEGER DEFAULT 0, -- eligible for auto-resolve (exact, or similar within the strict threshold)
    PRIMARY KEY (group_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_dgm_image ON duplicate_group_members(image_id);
```

- [ ] **Step 2: Add migration for existing DBs**

In `src/database/db.js`, inside `migrate()`, before the closing `}` (after the `idx_artistic_score` line 116), add:
```javascript
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
```

- [ ] **Step 3: Add hash-storage methods**

In `src/database/db.js`, immediately after the `getImagesNeedingArtisticScore` method (ends line 460), add:
```javascript
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
```

- [ ] **Step 4: Verify migration + methods on a throwaway DB**

Run:
```bash
node -e "
const fs=require('fs'); const p='/tmp/pf-dup3.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const db=new DB(p);
const now=Date.now();
db.insertImage({filepath:'/a.jpg',filename:'a.jpg',fileModified:now});
db.insertImage({filepath:'/b.jpg',filename:'b.jpg',fileModified:now});
console.log('need hash:', db.countImagesNeedingHash(), db.countImagesNeedingHash()===2?'PASS':'FAIL');
const first=db.getImagesNeedingHash(10)[0];
db.setHashes(first.id,'abc','0000000000000001');
console.log('after setHashes:', db.countImagesNeedingHash(), db.countImagesNeedingHash()===1?'PASS':'FAIL');
db.resetHashComputed(first.id);
console.log('after reset:', db.countImagesNeedingHash(), db.countImagesNeedingHash()===2?'PASS':'FAIL');
// idempotent re-open (migration runs again)
db.close(); const db2=new DB(p); console.log('reopen OK', 'PASS');
db2.close();
"
```
Expected: `need hash: 2 PASS`, `after setHashes: 1 PASS`, `after reset: 2 PASS`, `reopen OK PASS`.

- [ ] **Step 5: Commit**
```bash
git add src/database/schema.sql src/database/db.js
git commit -m "$(printf 'feat: add hash columns + duplicate group table + backfill methods\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Group query + group-table DB methods

**Files:**
- Modify: `src/database/db.js`

**Interfaces:**
- Produces: `db.getExactDuplicateGroups()`, `db.getImagesWithPerceptualHash()`, `db.getImagesByIds(ids)`, `db.clearDuplicateGroups()`, `db.insertGroupMembers(rows)`, `db.getDuplicateGroups()`, `db.getDuplicateGroupSummary()`, `db.removeImagesFromGroups(ids)`.

- [ ] **Step 1: Add the methods**

In `src/database/db.js`, after the `resetHashComputed` method added in Task 3, add:
```javascript
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
```

- [ ] **Step 2: Verify exact grouping + round-trip**

Run:
```bash
node -e "
const fs=require('fs'); const p='/tmp/pf-dup4.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const db=new DB(p);
const now=Date.now();
const r1=db.insertImage({filepath:'/a.jpg',filename:'a.jpg',fileModified:now,width:100,height:100});
const r2=db.insertImage({filepath:'/b.jpg',filename:'b.jpg',fileModified:now,width:200,height:200});
const r3=db.insertImage({filepath:'/c.jpg',filename:'c.jpg',fileModified:now});
db.setHashes(1,'SAME','0000000000000000');
db.setHashes(2,'SAME','0000000000000000');
db.setHashes(3,'OTHER','ffffffffffffffff');
const ex=db.getExactDuplicateGroups();
console.log('exact groups:', JSON.stringify(ex), (ex.length===1 && ex[0].ids.length===2)?'PASS':'FAIL');
db.insertGroupMembers([
  {groupId:1,imageId:1,groupType:'exact',isSuggestedKeeper:0,isOversized:0,isAutoEligible:1},
  {groupId:1,imageId:2,groupType:'exact',isSuggestedKeeper:1,isOversized:0,isAutoEligible:1}
]);
const g=db.getDuplicateGroups();
console.log('rendered groups:', g.length, g[0].members.length, (g.length===1&&g[0].members.length===2)?'PASS':'FAIL');
console.log('summary:', JSON.stringify(db.getDuplicateGroupSummary()));
db.removeImagesFromGroups([1,2]);
console.log('after remove:', db.getDuplicateGroups().length, db.getDuplicateGroups().length===0?'PASS':'FAIL');
"
```
Expected: `exact groups: ... PASS`, `rendered groups: 1 2 PASS`, a summary line with `exactGroups:1`, `after remove: 0 PASS`.

- [ ] **Step 3: Commit**
```bash
git add src/database/db.js
git commit -m "$(printf 'feat: add duplicate group query + group-table DB methods\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Keeper selection + transactional carryover

**Files:**
- Modify: `src/database/db.js`

**Interfaces:**
- Produces: `db.pickKeeper(ids) => keeperId`, `db.applyDuplicateCarryover(keeperId, deleteIds)` (transaction; updates keeper only, does not delete).

- [ ] **Step 1: Add keeper + carryover methods**

In `src/database/db.js`, after the group methods from Task 4, add:
```javascript
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
```

- [ ] **Step 2: Verify keeper + carryover**

Run:
```bash
node -e "
const fs=require('fs'); const p='/tmp/pf-dup5.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const db=new DB(p);
const now=Date.now();
db.insertImage({filepath:'/a.jpg',filename:'a.jpg',fileModified:now,width:100,height:100,dateTaken:'2020-01-01',tags:['x']});           // id1 small
db.insertImage({filepath:'/b.jpg',filename:'b.jpg',fileModified:now,width:400,height:400,dateTaken:'2021-01-01',isFavorite:1,tags:['y']}); // id2 big + favorite
// give id1 an artistic score, id2 none
db.updateImage(1,{}); db.db=db.db; // no-op guard
db.db.prepare('UPDATE images SET artistic_score=? WHERE id=?').run(500000,1);
const keeper=db.pickKeeper([1,2]);
console.log('keeper=', keeper, keeper===2?'PASS (highest res)':'FAIL');
db.applyDuplicateCarryover(2,[1]);
const k=db.getImageById(2);
const tags=JSON.parse(k.tags).sort();
console.log('favorite:', k.is_favorite, k.is_favorite===1?'PASS':'FAIL');
console.log('tags:', JSON.stringify(tags), JSON.stringify(tags)===JSON.stringify(['x','y'])?'PASS':'FAIL');
console.log('score copied:', k.artistic_score, k.artistic_score===500000?'PASS':'FAIL');
"
```
Expected: `keeper= 2 PASS (highest res)`, `favorite: 1 PASS`, `tags: ["x","y"] PASS`, `score copied: 500000 PASS`.

- [ ] **Step 3: Commit**
```bash
git add src/database/db.js
git commit -m "$(printf 'feat: add keeper selection + transactional duplicate carryover\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: Config block

**Files:**
- Modify: `config.json`

- [ ] **Step 1: Add the `duplicates` block**

In `config.json`, add after the `artisticScore` block (it is the last key; add a comma after its closing `}` and insert):
```json
  "duplicates": {
    "similarThreshold": 10,
    "similarAutoThreshold": 5,
    "maxGroupSize": 25,
    "hashBatchSize": 100
  }
```

- [ ] **Step 2: Verify JSON + load**

Run:
```bash
node -e "const {loadConfig}=require('./src/config.js'); const c=loadConfig(); console.log(JSON.stringify(c.duplicates), (c.duplicates && c.duplicates.similarThreshold===10)?'PASS':'FAIL')"
```
Expected: `{"similarThreshold":10,"similarAutoThreshold":5,"maxGroupSize":25,"hashBatchSize":100} PASS`.

- [ ] **Step 3: Commit**
```bash
git add config.json
git commit -m "$(printf 'feat: add duplicates config block\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: Hash on ingest

**Files:**
- Modify: `src/indexer/scanner.js` — `indexSingleFile` (~209-243) and `processBatch` (after `insertImagesBatch`, ~176-178)

**Interfaces:**
- Consumes: `dHash` from `src/lib/perceptualHash.js`; `db.setHashes`, `db.getImageByPath`.

- [ ] **Step 1: Require the hash helpers at the top of scanner.js**

Add near the other requires at the top of `src/indexer/scanner.js`:
```javascript
const crypto = require('crypto');
const { dHash } = require('../lib/perceptualHash');
```
(If `crypto` or `fs` is already required, don't duplicate.)

- [ ] **Step 2: Add a private hash helper method on the scanner class**

Add this method to the `DirectoryScanner` class body (near `indexSingleFile`):
```javascript
    // Compute + store content/perceptual hashes for an already-inserted image.
    async hashImage(id, resizedPath) {
        try {
            const bytes = await require('fs').promises.readFile(resizedPath);
            const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
            let perceptualHash = null;
            try { perceptualHash = await dHash(resizedPath); } catch (_) { perceptualHash = null; }
            this.db.setHashes(id, contentHash, perceptualHash);
        } catch (err) {
            // File unreadable — mark computed (nulls) so it doesn't block future scans.
            this.db.setHashes(id, null, null);
        }
    }
```

- [ ] **Step 3: Hash in the single-file path**

In `indexSingleFile`, immediately after `this.db.insertImage(batchItem);` (line 233), add:
```javascript
        const insertedSingle = this.db.getImageByPath(resized.outputPath);
        if (insertedSingle) await this.hashImage(insertedSingle.id, resized.outputPath);
```

- [ ] **Step 4: Hash in the batch path**

In `processBatch`, right after `this.db.insertImagesBatch(batch);` succeeds (~line 178), add a loop that hashes each freshly-inserted row:
```javascript
        for (const item of batch) {
            const row = this.db.getImageByPath(item.filepath);
            if (row) await this.hashImage(row.id, item.filepath);
        }
```
(Place this inside the same `try` block that calls `insertImagesBatch`, after the insert, before deleting originals.)

- [ ] **Step 5: Verify hashing runs on a real resized file**

This uses a small real PNG written to disk, inserted, then hashed via the scanner helper. Run:
```bash
node -e "
const fs=require('fs'); const sharp=require('sharp'); const p='/tmp/pf-dup7.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const Scanner=require('./src/indexer/scanner.js');
const db=new DB(p); const sc=new Scanner(db,{fileExtensions:['.png'],indexing:{}});
(async()=>{
  const img='/tmp/pf-dup7.png';
  await sharp({create:{width:32,height:32,channels:3,background:{r:20,g:120,b:200}}}).png().toFile(img);
  db.insertImage({filepath:img,filename:'pf-dup7.png',fileModified:Date.now(),width:32,height:32});
  const row=db.getImageByPath(img);
  await sc.hashImage(row.id, img);
  const after=db.getImageById(row.id);
  console.log('content_hash len', after.content_hash?.length, 'perceptual', after.perceptual_hash?.length, 'computed', after.hash_computed,
    (after.content_hash?.length===64 && after.perceptual_hash?.length===16 && after.hash_computed===1)?'PASS':'FAIL');
})().catch(e=>console.log('FAIL',e.message));
"
```
Expected: `content_hash len 64 perceptual 16 computed 1 PASS`.

- [ ] **Step 6: Commit**
```bash
git add src/indexer/scanner.js
git commit -m "$(printf 'feat: compute content + perceptual hashes on image ingest\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8: Reset hash on rotate

**Files:**
- Modify: `src/routes/images.js` — `/:id/rotate-left` (~461-500) and `/:id/rotate-right` (~503-542)

- [ ] **Step 1: Reset `hash_computed` after each rotation**

In BOTH rotate routes, immediately after the `db.updateFileModified(imageId, stats.mtimeMs);` line, add:
```javascript
        // Bytes and perceptual hash both change on rotation — re-hash next scan.
        db.resetHashComputed(imageId);
```

- [ ] **Step 2: Verify both routes call it**

Run:
```bash
grep -c "db.resetHashComputed(imageId);" src/routes/images.js
node --check src/routes/images.js && echo "PARSE OK"
```
Expected: `2` (one per rotate route) and `PARSE OK`.

- [ ] **Step 3: Commit**
```bash
git add src/routes/images.js
git commit -m "$(printf 'feat: reset hash_computed after physical rotation\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 9: duplicateScan SSE message factory

**Files:**
- Modify: `src/lib/messages.js`

**Interfaces:**
- Produces: `duplicateScanMessage(state) => { type: 'duplicateScan', ...state }`

- [ ] **Step 1: Add the factory**

In `src/lib/messages.js`, add before `module.exports`:
```javascript
function duplicateScanMessage(state) {
    return { type: 'duplicateScan', ...state };
}
```
And add `duplicateScanMessage,` to the `module.exports` object.

- [ ] **Step 2: Verify**
```bash
node -e "const {duplicateScanMessage}=require('./src/lib/messages.js'); const m=duplicateScanMessage({phase:'hashing',processed:5,total:10}); console.log(JSON.stringify(m), (m.type==='duplicateScan'&&m.processed===5)?'PASS':'FAIL')"
```
Expected: `{"type":"duplicateScan","phase":"hashing","processed":5,"total":10} PASS`.

- [ ] **Step 3: Commit**
```bash
git add src/lib/messages.js
git commit -m "$(printf 'feat: add duplicateScan SSE message factory\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 10: Detection service

**Files:**
- Create: `src/services/duplicateDetection.js`

**Interfaces:**
- Consumes: `db` (Tasks 3-5 methods), `perceptualHash.hammingDistance`, `bkTree`, `duplicateScanMessage`.
- Produces: `class DuplicateDetectionService { constructor(db, config, { broadcast }); getStatus(); requestCancel(); async runScan() }`

- [ ] **Step 1: Write the service**

Create `src/services/duplicateDetection.js`:
```javascript
const crypto = require('crypto');
const fs = require('fs');
const BKTree = require('../lib/bkTree');
const { hammingDistance } = require('../lib/perceptualHash');
const { duplicateScanMessage } = require('../lib/messages');

class DuplicateDetectionService {
    constructor(db, config = {}, { broadcast } = {}) {
        this.db = db;
        this.cfg = config.duplicates || {};
        this.broadcast = broadcast || (() => {});
        this.cancelRequested = false;
        this.state = this._idle();
    }

    _idle() {
        return { phase: 'idle', processed: 0, total: 0, exactGroups: 0, similarGroups: 0, startedAt: null, finishedAt: null };
    }

    getStatus() { return { ...this.state }; }
    requestCancel() { this.cancelRequested = true; }
    isRunning() { return this.state.phase === 'hashing' || this.state.phase === 'detecting'; }

    _emit() { this.broadcast(duplicateScanMessage(this.getStatus())); }

    async runScan() {
        if (this.isRunning()) return this.getStatus();
        this.cancelRequested = false;
        this.state = { ...this._idle(), phase: 'hashing', startedAt: Date.now(), total: this.db.countImagesNeedingHash() };
        this._emit();

        await this._hashBackfill();
        if (this.cancelRequested) { this.state.phase = 'canceled'; this.state.finishedAt = Date.now(); this._emit(); return this.getStatus(); }

        this.state.phase = 'detecting'; this._emit();
        this._detectGroups();

        this.state.phase = 'done'; this.state.finishedAt = Date.now(); this._emit();
        return this.getStatus();
    }

    async _hashBackfill() {
        const batchSize = this.cfg.hashBatchSize || 100;
        for (;;) {
            if (this.cancelRequested) return;
            const rows = this.db.getImagesNeedingHash(batchSize);
            if (rows.length === 0) return;
            for (const row of rows) {
                try {
                    const bytes = await fs.promises.readFile(row.filepath);
                    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
                    let perceptualHash = null;
                    try {
                        const { dHash } = require('../lib/perceptualHash');
                        perceptualHash = await dHash(row.filepath);
                    } catch (_) { perceptualHash = null; }
                    this.db.setHashes(row.id, contentHash, perceptualHash);
                } catch (_) {
                    this.db.setHashes(row.id, null, null);
                }
                this.state.processed++;
            }
            this._emit();
        }
    }

    _detectGroups() {
        this.db.clearDuplicateGroups();
        let groupId = 0;
        const memberRows = [];
        const inExact = new Set();

        // Exact groups
        const exact = this.db.getExactDuplicateGroups();
        for (const g of exact) {
            groupId++;
            const keeper = this.db.pickKeeper(g.ids);
            for (const id of g.ids) {
                inExact.add(id);
                memberRows.push({ groupId, imageId: id, groupType: 'exact', isSuggestedKeeper: id === keeper ? 1 : 0, isOversized: 0, isAutoEligible: 1 });
            }
        }
        this.state.exactGroups = exact.length;

        // Similar groups via BK-tree + union-find (skip images already exact-grouped)
        const rows = this.db.getImagesWithPerceptualHash().filter(r => !inExact.has(r.id));
        const threshold = this.cfg.similarThreshold ?? 10;
        const autoThreshold = this.cfg.similarAutoThreshold ?? 5;
        const maxGroupSize = this.cfg.maxGroupSize ?? 25;
        const idToHash = new Map(rows.map(r => [r.id, r.perceptual_hash]));

        const tree = new BKTree(hammingDistance);
        for (const r of rows) tree.insert(r.perceptual_hash, r.id);

        const parent = new Map();
        const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
        const union = (a, b) => { parent.set(find(a), find(b)); };
        for (const r of rows) parent.set(r.id, r.id);

        for (const r of rows) {
            const neighbors = tree.query(r.perceptual_hash, threshold);
            for (const n of neighbors) {
                if (n.value !== r.id) union(r.id, n.value);
            }
        }

        const components = new Map();
        for (const r of rows) {
            const root = find(r.id);
            if (!components.has(root)) components.set(root, []);
            components.get(root).push(r.id);
        }

        let similarCount = 0;
        for (const ids of components.values()) {
            if (ids.length < 2) continue;
            similarCount++;
            groupId++;
            const oversized = ids.length > maxGroupSize ? 1 : 0;
            const keeper = oversized ? null : this.db.pickKeeper(ids);
            // Auto-eligible only when not oversized AND the whole component stays a
            // single connected component under the stricter auto threshold.
            const autoEligible = (!oversized && this._connectedAtThreshold(ids, idToHash, autoThreshold)) ? 1 : 0;
            for (const id of ids) {
                memberRows.push({ groupId, imageId: id, groupType: 'similar', isSuggestedKeeper: id === keeper ? 1 : 0, isOversized: oversized, isAutoEligible: autoEligible });
            }
        }
        this.state.similarGroups = similarCount;

        if (memberRows.length) this.db.insertGroupMembers(memberRows);
    }

    /** True if `ids` form one connected component under Hamming <= threshold. */
    _connectedAtThreshold(ids, idToHash, threshold) {
        const parent = new Map(ids.map(id => [id, id]));
        const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                if (hammingDistance(idToHash.get(ids[i]), idToHash.get(ids[j])) <= threshold) {
                    parent.set(find(ids[i]), find(ids[j]));
                }
            }
        }
        const roots = new Set(ids.map(find));
        return roots.size === 1;
    }
}

module.exports = DuplicateDetectionService;
```

- [ ] **Step 2: Verify detection end-to-end on a seeded DB**

Run (seeds exact + similar + unique rows with crafted hashes, runs detection):
```bash
node -e "
const fs=require('fs'); const p='/tmp/pf-dup10.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const Svc=require('./src/services/duplicateDetection.js');
const db=new DB(p);
const now=Date.now();
function ins(fp,ch,ph,w){ db.insertImage({filepath:fp,filename:fp,fileModified:now,width:w,height:w}); const r=db.getImageByPath(fp); db.setHashes(r.id,ch,ph); return r.id; }
ins('/a','H1','0000000000000000',100); ins('/b','H1','0000000000000000',200);   // exact pair (same content hash)
ins('/c','H2','0000000000000010',100); ins('/d','H3','0000000000000011',100);   // similar pair (1 bit apart)
ins('/e','H4','ffffffffffffffff',100);                                          // unique
const svc=new Svc(db,{duplicates:{similarThreshold:10,maxGroupSize:25}},{});
svc._detectGroups();
console.log('summary:', JSON.stringify(db.getDuplicateGroupSummary()));
const s=db.getDuplicateGroupSummary();
console.log((s.exactGroups===1 && s.similarGroups===1)?'PASS':'FAIL');
const groups=db.getDuplicateGroups();
const exactG=groups.find(g=>g.groupType==='exact');
const keeper=exactG.members.find(m=>m.isSuggestedKeeper);
console.log('exact keeper is bigger res:', keeper.id, keeper.width===200?'PASS':'FAIL');
"
```
Expected: a summary with `exactGroups:1,similarGroups:1`, then `PASS`, then `exact keeper is bigger res: <id> PASS`.

- [ ] **Step 3: Commit**
```bash
git add src/services/duplicateDetection.js
git commit -m "$(printf 'feat: add duplicate detection service (backfill + grouping)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 11: Routes + server wiring

**Files:**
- Create: `src/routes/duplicates.js`
- Modify: `src/server.js` — construct the service (near line 52) + mount the router (after the `/api/settings` mount, ~line 103)

**Interfaces:**
- Consumes: `db`, `duplicateService`, `slideshowEngine`, `broadcastMessage`, `moveFileToDeleted` (re-exported).
- Produces: `POST /api/duplicates/scan`, `POST /api/duplicates/cancel`, `GET /api/duplicates/status`, `GET /api/duplicates/groups`, `POST /api/duplicates/resolve`, `POST /api/duplicates/auto-resolve`.

- [ ] **Step 1: Export `moveFileToDeleted` from images.js for reuse**

At the bottom of `src/routes/images.js`, change `module.exports = createImageRoutes;` to also expose the helper:
```javascript
module.exports = createImageRoutes;
module.exports.moveFileToDeleted = moveFileToDeleted;
```

- [ ] **Step 2: Write the router**

Create `src/routes/duplicates.js`:
```javascript
const express = require('express');
const path = require('path');
const { moveFileToDeleted } = require('./images');

/**
 * Duplicate detection + resolution routes.
 * @param {object} db
 * @param {object} duplicateService - DuplicateDetectionService
 * @param {object} slideshowEngine
 * @param {(msg:object)=>void} broadcastMessage
 */
function createDuplicateRoutes(db, duplicateService, slideshowEngine, broadcastMessage) {
    const router = express.Router();

    router.get('/status', (req, res) => {
        res.json({ ...duplicateService.getStatus(), ...db.getDuplicateGroupSummary() });
    });

    router.get('/groups', (req, res) => {
        res.json({ groups: db.getDuplicateGroups() });
    });

    router.post('/scan', (req, res) => {
        if (duplicateService.isRunning()) {
            return res.status(409).json({ error: 'A scan is already running', status: duplicateService.getStatus() });
        }
        // Fire and forget; progress streams over SSE.
        duplicateService.runScan().catch(err => console.error('Duplicate scan failed:', err));
        res.json({ success: true, status: duplicateService.getStatus() });
    });

    router.post('/cancel', (req, res) => {
        duplicateService.requestCancel();
        res.json({ success: true });
    });

    // Resolve a single group: keep keeperId, delete deleteIds (with carryover).
    router.post('/resolve', async (req, res) => {
        const keeperId = parseInt(req.body.keeperId);
        const deleteIds = Array.isArray(req.body.deleteIds) ? req.body.deleteIds.map(Number) : [];
        if (!keeperId || deleteIds.includes(keeperId) || deleteIds.length === 0) {
            return res.status(400).json({ error: 'Invalid keeperId/deleteIds' });
        }
        try {
            const deleted = await resolve(db, slideshowEngine, keeperId, deleteIds);
            broadcastMessage && broadcastMessage(require('../lib/messages').duplicateScanMessage(duplicateService.getStatus()));
            res.json({ success: true, deleted });
        } catch (error) {
            console.error('Resolve group failed:', error);
            res.status(500).json({ error: 'Failed to resolve group' });
        }
    });

    // Auto-resolve all eligible groups of a scope using the suggested keeper.
    router.post('/auto-resolve', async (req, res) => {
        const scope = req.body.scope === 'similar' ? 'similar' : 'exact';
        if (scope === 'similar' && req.body.confirm !== true) {
            return res.status(400).json({ error: 'Similar auto-resolve requires confirm:true' });
        }
        try {
            // autoEligible: exact groups are always eligible; similar groups only
            // when the component holds together under the stricter auto threshold.
            const groups = db.getDuplicateGroups().filter(g => g.groupType === scope && !g.oversized && g.autoEligible);
            let totalDeleted = 0;
            for (const g of groups) {
                const keeper = g.members.find(m => m.isSuggestedKeeper) || g.members[0];
                const deleteIds = g.members.filter(m => m.id !== keeper.id).map(m => m.id);
                if (!deleteIds.length) continue;
                const deleted = await resolve(db, slideshowEngine, keeper.id, deleteIds);
                totalDeleted += deleted.length;
            }
            res.json({ success: true, groupsResolved: groups.length, imagesDeleted: totalDeleted });
        } catch (error) {
            console.error('Auto-resolve failed:', error);
            res.status(500).json({ error: 'Auto-resolve failed' });
        }
    });

    return router;
}

/**
 * Carry metadata to the keeper, move each deleted file to data/deleted/, hard-delete
 * its row, and prune group membership. Returns the list of deleted ids.
 */
async function resolve(db, slideshowEngine, keeperId, deleteIds) {
    db.applyDuplicateCarryover(keeperId, deleteIds);
    const done = [];
    for (const id of deleteIds) {
        const img = db.getImageById(id);
        if (!img) continue;
        try {
            await moveFileToDeleted(path.resolve(img.filepath));
        } catch (err) {
            console.error(`Duplicate resolve: file move failed for ${img.filepath}:`, err.message);
        }
        db.hardDelete(id);
        done.push(id);
    }
    db.removeImagesFromGroups([keeperId, ...deleteIds]); // keeper's group is resolved too
    slideshowEngine.refreshImageList();
    return done;
}

module.exports = createDuplicateRoutes;
```

- [ ] **Step 3: Construct the service in server.js**

In `src/server.js`, after the `artisticScoringService` construction (line 52), add:
```javascript
const DuplicateDetectionService = require('./services/duplicateDetection');
const duplicateService = new DuplicateDetectionService(db, config, { broadcast: broadcastMessage });
```
(Place the `require` with the other top requires if you prefer; the inline require here is fine since `broadcastMessage` is defined below — so instead put the `require` at the top with the others, and the `new` call *after* `broadcastMessage` is defined, i.e. right after the `slideshowEngine` construction at line 75.)

Concretely: add to the top requires block (near line 20):
```javascript
const DuplicateDetectionService = require('./services/duplicateDetection');
```
And after `const slideshowEngine = new SlideshowEngine(...)` (line 75), add:
```javascript
const duplicateService = new DuplicateDetectionService(db, config, { broadcast: broadcastMessage });
```

- [ ] **Step 4: Mount the router in server.js**

In `src/server.js`, immediately after the `app.use('/api/settings', ...)` block (ends ~line 103), add:
```javascript
const createDuplicateRoutes = require('./routes/duplicates');
app.use('/api/duplicates', createDuplicateRoutes(db, duplicateService, slideshowEngine, broadcastMessage));
```

- [ ] **Step 5: Verify end-to-end via HTTP (isolated server, seeded DB)**

Run:
```bash
TMPH=$(mktemp -d); mkdir -p "$TMPH/photos"
cat > "$TMPH/picframe-config.json" <<JSON
{ "photoDirectory": "$TMPH/photos", "databasePath": "$TMPH/d.db", "serverPort": 3997, "auth": {"enabled": false}, "artisticScore": {"enabled": false}, "resize": {"runOnStartup": false}, "debug": {"enabled": false} }
JSON
# seed the DB before boot
node -e "
const DB=require('./src/database/db.js'); const db=new DB('$TMPH/d.db'); const now=Date.now();
function ins(fp,ch,ph,w){db.insertImage({filepath:fp,filename:fp,fileModified:now,width:w,height:w});const r=db.getImageByPath(fp);db.setHashes(r.id,ch,ph);}
ins('/a','H1','0000000000000000',100); ins('/b','H1','0000000000000000',200);
ins('/c','H2','0000000000000010',100); ins('/d','H3','0000000000000011',100);
db.close();
"
HOME="$TMPH" node src/server.js --dev > "$TMPH/s.log" 2>&1 &
SRV=$!; sleep 4
echo '-- scan --'; curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3997/api/duplicates/scan
sleep 2
echo '-- status --'; curl -s http://127.0.0.1:3997/api/duplicates/status
echo; echo '-- groups count --'; curl -s http://127.0.0.1:3997/api/duplicates/groups | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const g=JSON.parse(d).groups;console.log(g.length, g.length===2?'PASS':'FAIL')})"
echo '-- auto-resolve exact --'; curl -s -X POST -H 'Content-Type: application/json' -d '{"scope":"exact"}' http://127.0.0.1:3997/api/duplicates/auto-resolve
kill $SRV 2>/dev/null; rm -rf "$TMPH"
```
Expected: scan → `200`; status JSON with `exactGroups:1,similarGroups:1`; groups count `2 PASS`; auto-resolve → `{"success":true,"groupsResolved":1,"imagesDeleted":1}`.

- [ ] **Step 6: Commit**
```bash
git add src/routes/duplicates.js src/routes/images.js src/server.js
git commit -m "$(printf 'feat: add /api/duplicates routes and wire detection service\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 12: Settings UI — Duplicates section

**Files:**
- Modify: `src/public/index.html` (settings panel, after the Stats `settings-group`, ~line 215)
- Create: `src/public/js/duplicates.js`
- Modify: `src/public/js/app.js` — add a `duplicateScan` SSE case (~line 183) and call `initDuplicates()` from `openSettings()` (~line 1399); load the script in index.html

- [ ] **Step 1: Add the Duplicates settings section (index.html)**

In `src/public/index.html`, after the Stats `settings-group` block (closes ~line 215), add:
```html
                <div class="settings-group duplicates">
                    <h3>Duplicates</h3>
                    <button id="dupScanBtn" class="btn">Scan library for duplicates</button>
                    <div id="dupProgress" class="dup-progress hidden">
                        <span id="dupPhase">idle</span>
                        <progress id="dupBar" value="0" max="100"></progress>
                        <span id="dupCounts"></span>
                    </div>
                    <div id="dupSummary" class="dup-summary"></div>
                    <div class="dup-actions">
                        <button id="dupAutoExact" class="btn">Auto-resolve exact duplicates</button>
                        <button id="dupAutoSimilar" class="btn btn-warn">Auto-resolve similar…</button>
                    </div>
                    <div id="dupGroups" class="dup-groups"></div>
                </div>
```
Add the script tag near the other JS includes at the bottom of index.html (before `app.js` is fine, or after — it defines globals used by app.js):
```html
    <script src="/js/duplicates.js"></script>
```

- [ ] **Step 2: Write the review UI (duplicates.js)**

Create `src/public/js/duplicates.js`:
```javascript
/* Duplicate review UI. Uses global apiCall() from app.js. */
(function () {
    let initialized = false;

    async function api(path, opts) {
        const res = await fetch('/api/duplicates' + path, opts);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    function el(id) { return document.getElementById(id); }

    async function refresh() {
        const status = await api('/status');
        el('dupSummary').textContent =
            `${status.exactGroups || 0} exact group(s), ${status.similarGroups || 0} similar group(s).`;
        renderProgress(status);
        const { groups } = await api('/groups');
        renderGroups(groups);
    }

    function renderProgress(s) {
        const box = el('dupProgress');
        if (s.phase === 'idle' || s.phase === 'done' || s.phase === 'canceled') {
            box.classList.add('hidden');
        } else {
            box.classList.remove('hidden');
            el('dupPhase').textContent = s.phase;
            const pct = s.total ? Math.round((s.processed / s.total) * 100) : 0;
            el('dupBar').value = pct;
            el('dupCounts').textContent = `${s.processed}/${s.total}`;
        }
    }

    function renderGroups(groups) {
        const container = el('dupGroups');
        container.innerHTML = '';
        for (const g of groups) {
            const div = document.createElement('div');
            div.className = 'dup-group';
            const label = g.oversized ? `${g.groupType} (oversized — review only)` : g.groupType;
            div.innerHTML = `<div class="dup-group-label">${label}</div>`;
            const row = document.createElement('div');
            row.className = 'dup-thumbs';
            for (const m of g.members) {
                const fig = document.createElement('figure');
                fig.className = 'dup-thumb' + (m.isSuggestedKeeper ? ' keeper' : '');
                fig.innerHTML =
                    `<img src="/api/image/${m.id}/serve" alt="${m.filename}">` +
                    `<figcaption>${m.isFavorite ? '⭐ ' : ''}${m.width}×${m.height}` +
                    `${m.artisticScore != null ? ' · ' + m.artisticScore : ''}` +
                    `${m.isSuggestedKeeper ? ' · KEEP' : ''}</figcaption>`;
                row.appendChild(fig);
            }
            div.appendChild(row);
            const keeper = g.members.find(m => m.isSuggestedKeeper) || g.members[0];
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.textContent = 'Keep suggested, delete the rest';
            btn.onclick = async () => {
                const deleteIds = g.members.filter(m => m.id !== keeper.id).map(m => m.id);
                await api('/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keeperId: keeper.id, deleteIds }) });
                await refresh();
            };
            div.appendChild(btn);
            container.appendChild(div);
        }
    }

    function init() {
        if (initialized) { refresh().catch(() => {}); return; }
        initialized = true;
        el('dupScanBtn').onclick = async () => { await api('/scan', { method: 'POST' }); };
        el('dupAutoExact').onclick = async () => {
            await api('/auto-resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: 'exact' }) });
            await refresh();
        };
        el('dupAutoSimilar').onclick = async () => {
            if (!confirm('Auto-resolve SIMILAR images? This deletes near-duplicates using the strict threshold. Continue?')) return;
            await api('/auto-resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: 'similar', confirm: true }) });
            await refresh();
        };
        refresh().catch(() => {});
    }

    // Called by app.js on the duplicateScan SSE event.
    function onScanEvent(state) {
        renderProgress(state);
        if (state.phase === 'done') refresh().catch(() => {});
    }

    window.PictureFrameDuplicates = { init, onScanEvent };
})();
```

- [ ] **Step 3: Wire the SSE case + openSettings in app.js**

In `src/public/js/app.js`, in the `switch (data.type)` in `handleSSEMessage`, add a case before `default:` (~line 183):
```javascript
        case 'duplicateScan':
            if (window.PictureFrameDuplicates) window.PictureFrameDuplicates.onScanEvent(data);
            break;
```
In `openSettings()` (~line 1399), after `loadStats();`, add:
```javascript
    if (window.PictureFrameDuplicates) window.PictureFrameDuplicates.init();
```

- [ ] **Step 4: Verify frontend files parse and are referenced**

Run:
```bash
node --check src/public/js/duplicates.js && echo "duplicates.js PARSE OK"
node --check src/public/js/app.js && echo "app.js PARSE OK"
grep -q "duplicates.js" src/public/index.html && echo "script included"
grep -q "case 'duplicateScan'" src/public/js/app.js && echo "sse case present"
grep -q "PictureFrameDuplicates.init" src/public/js/app.js && echo "init wired"
```
Expected: `duplicates.js PARSE OK`, `app.js PARSE OK`, `script included`, `sse case present`, `init wired`.

- [ ] **Step 5: Commit**
```bash
git add src/public/index.html src/public/js/duplicates.js src/public/js/app.js
git commit -m "$(printf 'feat: add Duplicates settings UI (scan, review, resolve)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 13: End-to-end verification with real images

**Files:** none (verification only)

- [ ] **Step 1: Drive the full flow with real images through a running server**

Run (creates two byte-identical images + one near-identical + one distinct, ingests via the running server's scanner is out of scope here, so seed with real hashes computed by the pipeline, then scan + resolve over HTTP):
```bash
TMPH=$(mktemp -d); mkdir -p "$TMPH/photos" "$TMPH/data"
cat > "$TMPH/picframe-config.json" <<JSON
{ "photoDirectory": "$TMPH/photos", "databasePath": "$TMPH/e.db", "serverPort": 3996, "auth": {"enabled": false}, "artisticScore": {"enabled": false}, "resize": {"runOnStartup": false}, "debug": {"enabled": false}, "duplicates": {"similarThreshold": 12, "similarAutoThreshold": 6, "maxGroupSize": 25, "hashBatchSize": 50} }
JSON
node -e "
const sharp=require('sharp'); const fs=require('fs'); const dir='$TMPH/photos';
(async()=>{
  const base=await sharp({create:{width:200,height:200,channels:3,background:{r:30,g:90,b:160}}}).jpeg().toBuffer();
  fs.writeFileSync(dir+'/one.jpg', base); fs.writeFileSync(dir+'/one_copy.jpg', base); // exact dup
  await sharp(base).modulate({brightness:1.02}).toFile(dir+'/one_similar.jpg');          // near dup
  await sharp({create:{width:200,height:200,channels:3,background:{r:200,g:20,b:20}}}).jpeg().toFile(dir+'/distinct.jpg');
  const DB=require('./src/database/db.js'); const Scanner=require('./src/indexer/scanner.js');
  const db=new DB('$TMPH/e.db'); const sc=new Scanner(db,{fileExtensions:['.jpg']});
  for (const f of ['one.jpg','one_copy.jpg','one_similar.jpg','distinct.jpg']) {
    const fp=dir+'/'+f; db.insertImage({filepath:fp,filename:f,fileModified:Date.now(),width:200,height:200});
    const r=db.getImageByPath(fp); await sc.hashImage(r.id, fp);
  }
  db.close();
})();
"
sleep 1
HOME="$TMPH" node src/server.js --dev > "$TMPH/s.log" 2>&1 &
SRV=$!; sleep 4
curl -s -X POST http://127.0.0.1:3996/api/duplicates/scan >/dev/null; sleep 2
echo '-- summary --'; curl -s http://127.0.0.1:3996/api/duplicates/status
echo; echo '-- resolve exact --'; curl -s -X POST -H 'Content-Type: application/json' -d '{"scope":"exact"}' http://127.0.0.1:3996/api/duplicates/auto-resolve
echo; echo '-- deleted dir has the removed exact dup? --'; ls "$TMPH"/data/deleted 2>/dev/null | wc -l
kill $SRV 2>/dev/null; rm -rf "$TMPH"
```
Expected: status shows at least `exactGroups:1` (the two identical JPEGs) and typically `similarGroups:1` (the brightness-shifted copy); exact auto-resolve returns `imagesDeleted:1`; the deleted-dir file count is `1`.

- [ ] **Step 2: Confirm no regressions to normal boot**

Run:
```bash
for f in src/server.js src/routes/duplicates.js src/services/duplicateDetection.js src/database/db.js; do node --check "$f" && echo "$f OK"; done
```
Expected: all `OK`.

---

## Self-Review notes

- **Spec coverage:** §1 architecture → Tasks 1,2,10,11,12. §2 hashing/schema → Tasks 3,7,8. §3 detection engine (BK-tree, union-find, maxGroupSize, suggested keeper) → Task 10 (+5 keeper). §4 scan lifecycle/progress → Tasks 9,10,11 (SSE + status). §5 settings UI → Task 12. §6 delete+carryover → Tasks 5,11. §7 error handling → Task 10 (`_hashBackfill` try/catch), Task 11 (`resolve` move-error tolerance). §8 config → Task 6. §9 testing → per-task checks + Task 13.
- **Type/name consistency:** `getImagesNeedingHash/countImagesNeedingHash/setHashes/resetHashComputed` (T3), `getExactDuplicateGroups/getImagesWithPerceptualHash/getImagesByIds/clearDuplicateGroups/insertGroupMembers/getDuplicateGroups/getDuplicateGroupSummary/removeImagesFromGroups` (T4), `pickKeeper/applyDuplicateCarryover` (T5), `dHash/hammingDistance` (T1), `BKTree` (T2), `duplicateScanMessage` (T9), `DuplicateDetectionService.{getStatus,requestCancel,isRunning,runScan}` (T10) are defined before use and referenced consistently by the service, routes, and UI.
- **Ordering:** Task 7's ingest hashing and Task 11's routes both depend on Tasks 1-5; Task 12's UI depends on Task 11's endpoints. Tasks are ordered so each builds only on earlier ones.
