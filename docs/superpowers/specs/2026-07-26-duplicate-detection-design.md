# Duplicate Detection — Design Spec

**Date:** 2026-07-26
**Status:** Approved, ready for planning
**Scope:** Detect exact and near-duplicate images in the library, review/act on them from settings, and carry a deleted duplicate's favorite/tags/artistic-score onto the retained image.

## Goal

Add a duplicate-detection feature to the picture-frame app. It finds **exact** duplicates (byte-identical resized files) and **similar** images (perceptual near-matches), lets the user act on them from the settings panel (manual review and one-click auto-resolve), and preserves metadata: when a duplicate is deleted, its favorite flag, tags, and artistic score carry over to the kept image.

The library is large (~150k images on the production Mac mini), so the design must find near-neighbors without O(n²) comparison and must not surprise-hammer the frame with background work.

There is no test framework in this repo. Verification is by runnable `node -e` unit checks and `curl` against a running server (see §9).

## Locked decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Action model | **Both** — manual per-group review AND one-click auto-resolve |
| Auto-resolve scope | Works on exact AND similar; **similar uses a stricter threshold + an explicit confirmation step** |
| Keep policy (which to retain) | **Highest resolution → highest artistic score → oldest `date_taken`** |
| Backfill trigger | **On-demand button with progress** (not automatic-on-startup) |
| Carryover on delete | **Favorite flag + union of tags + artistic score** (score copied only if the keeper lacks one) |
| Similar near-neighbor engine | **In-memory BK-tree over Hamming distance** (approach A) |
| Remote UI | Out of scope for v1 — feature lives in the main display's settings panel |

## Non-goals (v1)

- Remote-control-UI surface for duplicates (main display settings only).
- Rotation-invariant or crop-invariant similarity (dHash is not rotation-invariant; acceptable).
- Cross-format "same photo, different original resolution" exactness (handled as *similar*, not *exact*).
- Persistent LSH/band indexes — the on-demand scan rebuilds the BK-tree each run.

---

## 1. Architecture & components

**New files:**
- `src/lib/perceptualHash.js` — `dHash(imagePath) -> Promise<string>` (64-bit as 16 hex chars) and `hammingDistance(hexA, hexB) -> number`. Pure/testable; uses Sharp.
- `src/lib/bkTree.js` — a BK-tree keyed by Hamming distance: `insert(key, value)`, `query(key, maxDistance) -> [{value, distance}]`. Pure/testable.
- `src/services/duplicateDetection.js` — orchestration: content hashing, hashing-backfill batches, group detection (exact + similar), scan-state/progress, single-run guard.
- `src/routes/duplicates.js` — Express router mounted at `/api/duplicates`.

**Modified files:**
- `src/database/schema.sql` + `src/database/db.js` — new columns, `duplicate_group_members` table, migration, new methods.
- `src/indexer/resizePipeline.js` or `src/indexer/scanner.js` — compute hashes on ingest.
- `src/services/imageRotation.js` (or the rotate route) — reset `hash_computed=0` after a physical rotation.
- `src/lib/messages.js` — a `duplicateScan` SSE message factory.
- `src/server.js` — mount the duplicates router; wire the detection service.
- `src/public/index.html` + `src/public/js/app.js` (or a new `src/public/js/duplicates.js`) — the settings "Duplicates" section.

**Design boundaries:** the pure hash/tree libs know nothing about the DB or Express; the service composes them and owns DB access; the route is a thin HTTP layer.

---

## 2. Hashing & schema

### Columns added to `images` (idempotent `migrate()`, same pattern as `geocode_attempted`/`artistic_score`)
- `content_hash TEXT` — SHA-256 (hex) of the resized file's bytes.
- `perceptual_hash TEXT` — 64-bit dHash as 16 hex chars (nullable when the image can't be decoded).
- `hash_computed INTEGER DEFAULT 0` — 1 once hashing was attempted (success or skip).
- Index: `idx_content_hash ON images(content_hash)`.

### New table (rebuilt on each scan)
```
duplicate_group_members (
  group_id INTEGER NOT NULL,        -- stable within a scan
  image_id INTEGER NOT NULL,
  group_type TEXT NOT NULL,         -- 'exact' | 'similar'
  is_suggested_keeper INTEGER DEFAULT 0,
  PRIMARY KEY (group_id, image_id)
)
```
Also index `idx_dgm_image ON duplicate_group_members(image_id)`.

### Hash computation
- **Content hash:** stream the resized file through SHA-256.
- **Perceptual hash (dHash):** `sharp(path).greyscale().resize(9, 8, { fit: 'fill' }).raw()`, then for each row compare the 8 adjacent pixel pairs (9→8 differences × 8 rows = 64 bits); pack to hex.

### When hashing happens
- **On ingest:** after a successful resize + DB insert, compute both hashes and set `hash_computed=1`.
- **On rotate:** the rotate flow sets `hash_computed=0` (bytes and perceptual hash both change), so the next scan re-hashes it.
- **Backfill:** `getImagesNeedingHash(limit)` returns rows with `hash_computed=0`; processed in throttled batches during a scan.

---

## 3. Detection engine

### Exact groups
```
SELECT content_hash, GROUP_CONCAT(id) FROM images
WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1
```

### Similar groups (BK-tree + union-find)
1. Load all `(id, perceptual_hash)` where `perceptual_hash IS NOT NULL`.
2. Insert every hash into a BK-tree.
3. For each image, `query(hash, threshold)` for neighbors within the Hamming threshold.
4. Merge matched pairs with **union-find** into connected components (transitive: A~B, B~C ⇒ {A,B,C}).
5. Drop any pair/group already fully represented by an exact group.

### Guardrails
- **Configurable thresholds:** `similarThreshold` (default 10 bits) for review; `similarAutoThreshold` (default 5 bits) for the auto-resolve-similar path.
- **Max group size cap:** `maxGroupSize` (default 25). A similar-component exceeding the cap is flagged `oversized` and excluded from auto-resolve — surfaced for manual review only, so a loose threshold can't chain unrelated photos into a mass deletion.
- **Single-run guard:** one scan at a time; a second request returns the in-progress state.

### Suggested keeper
Computed per group with the keep policy: highest `width*height`, then highest `artistic_score`, then earliest `date_taken` (nulls last). Marked `is_suggested_keeper=1`.

---

## 4. Scan lifecycle & progress

Scan **progress** is held in-memory on the detection service (resets to `idle` on restart): `phase` ('idle'|'hashing'|'detecting'|'done'|'canceled'), `processed`, `total`, `exactGroups`, `similarGroups`, `startedAt`, `finishedAt`. Exposed via `GET /api/duplicates/status`. The **group results** persist in the `duplicate_group_members` table, so a completed review survives a restart even though the live progress state does not.

Flow on `POST /api/duplicates/scan`:
1. **Hashing phase** — throttled batches over `hash_computed=0` images; emit progress.
2. **Detecting phase** — exact SQL grouping + BK-tree similar grouping; populate `duplicate_group_members`.
3. **Done** — broadcast summary counts.

Progress is broadcast on the existing SSE channel via a new `duplicateScan` message (phase + processed/total + counts). `POST /api/duplicates/cancel` sets a stop flag honored between hashing batches.

---

## 5. Settings UI — review + act

A new "Duplicates" section in the settings panel (`index.html`):
- **Scan control:** "Scan library for duplicates" button; progress bar bound to `duplicateScan` SSE; summary line (`N exact groups, M similar groups`).
- **Group list:** each group renders member thumbnails (via existing `/api/image/:id/serve`), the suggested keeper highlighted, badges for ⭐ favorite / resolution / artistic score, and an Exact/Similar label. Oversized similar groups are labeled and excluded from auto actions.
- **Per-group action:** change the keeper, select which members to delete (default = all non-keepers), **Apply**.
- **Auto-resolve:** "Auto-resolve all exact duplicates" (one click, no confirm needed); "Auto-resolve similar" (uses `similarAutoThreshold`, requires an explicit confirmation dialog naming how many images will be deleted).

---

## 6. Delete + carryover (transactional)

`db.resolveGroup(keeperId, deleteIds)` — validated (`keeperId ∉ deleteIds`, all ids exist), run in a single transaction for the DB mutations:
1. Aggregate the to-be-deleted rows: if any `is_favorite=1` → set keeper `is_favorite=1`; **union** their `tags` into the keeper's tags (deduped); if keeper `artistic_score IS NULL` and any deleted row has one → copy `artistic_score` (+ `artistic_score_details`) to the keeper.
2. Delete each `deleteId` row (`hardDelete`).
3. Remove the affected ids from `duplicate_group_members`.

File moves to `data/deleted/` (via the existing `moveFileToDeleted`) happen per deleted image; on any file-move error the row is still removed from the DB (consistent with the current delete behavior), and errors are logged. After the operation: `slideshowEngine.refreshImageList()` and broadcast.

Endpoints:
- `POST /api/duplicates/resolve` — body `{ keeperId, deleteIds }` → applies one group.
- `POST /api/duplicates/auto-resolve` — body `{ scope: 'exact'|'similar' }` → applies the keep policy across all eligible (non-oversized) groups of that scope; `similar` requires `{ confirm: true }`.

---

## 7. Error handling & edge cases

- **Undecodable/corrupt image:** during hashing, catch, set `hash_computed=1` with `perceptual_hash=NULL` (content hash may still succeed from raw bytes), log, continue.
- **Rotation:** resets `hash_computed=0`; the image re-hashes on the next scan (both hashes change).
- **HEIF:** hashing runs on the resized JPEG, so no HEIF-specific handling is needed.
- **Stale groups:** if an image referenced by a group was deleted elsewhere between scan and resolve, skip missing ids gracefully.
- **Loose-threshold chaining:** bounded by `maxGroupSize`; oversized groups are review-only.
- **Concurrent scans:** rejected by the single-run guard.
- **Empty/one-image groups:** never produced (exact requires COUNT>1; similar requires ≥1 neighbor).

---

## 8. Configuration

Add a `duplicates` block to `config.json` defaults (overridable via `~/picframe-config.json`):
```
duplicates: {
  similarThreshold: 10,       // Hamming bits for review-level similarity
  similarAutoThreshold: 5,    // stricter bits for auto-resolving similar
  maxGroupSize: 25,           // components larger than this are review-only
  hashBatchSize: 100          // images hashed per throttled backfill batch
}
```

---

## 9. Testing / verification

No test framework; per-unit runnable checks:
- **perceptualHash:** dHash a fixture and a slightly-modified copy → small Hamming distance; two unrelated images → large distance; `hammingDistance` correctness on known hex pairs.
- **bkTree:** insert known hashes, assert `query` returns exactly the within-threshold neighbors.
- **grouping/union-find:** synthetic hash sets forming known components → assert group membership and the oversized cap.
- **keep policy & carryover:** seeded temp DB with crafted rows (varying resolution/score/date/favorite/tags) → assert suggested keeper and post-`resolveGroup` keeper metadata (favorite set, tags unioned, score copied) and that deleted rows are gone.
- **end-to-end:** seeded temp DB + `curl` the scan/list/resolve/auto-resolve endpoints; assert group counts and resolution results; confirm files land in `data/deleted/`.

## File structure summary

```
src/lib/perceptualHash.js      (new) dHash + hamming — pure
src/lib/bkTree.js              (new) BK-tree — pure
src/services/duplicateDetection.js (new) engine/orchestration
src/routes/duplicates.js       (new) /api/duplicates
src/database/schema.sql        columns + duplicate_group_members
src/database/db.js             migrate + methods (hashing, groups, resolveGroup)
src/indexer/resizePipeline.js  hash-on-ingest
src/services/imageRotation.js  reset hash_computed on rotate
src/lib/messages.js            duplicateScan message
src/server.js                  mount router + wire service
src/public/index.html          Duplicates settings section
src/public/js/duplicates.js    (new) review UI logic
config.json                    duplicates config block
```
