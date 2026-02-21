# 4K Image Resize & Year-Based Organization Plan

## Overview

Pre-process all images to 4K resolution (3840×2160) so no resizing occurs at render time. Store resized images in folders organized by the year they were taken. **Originals are deleted** after successful resize; the resized file becomes the canonical file in the DB.

---

## Current State

- **Image serving**: Full-resolution files served via `res.sendFile()` or HEIF→JPEG conversion on-the-fly
- **Display**: CSS `object-fit: contain` fits images to viewport (100vw × 100vh)
- **Storage**: Images in `photoDirectory` (e.g. `/Volumes/1tb/all-pics/`), full paths in DB
- **Metadata**: `date_taken` from EXIF, `width`/`height` in DB
- **Sharp**: Already used for rotation; available for resize

---

## Target Specification

### 4K Resolution
- **Standard**: 3840 × 2160 (UHD)
- **Resize rule**: Scale to fit *within* 3840×2160, preserving aspect ratio
- **Behavior**: Only downscale; images already ≤4K are copied as-is (or optionally upscaled—recommend no upscale for quality)

### Output Structure
Resized images replace originals; stored in `{photoDirectory}/resized/{year}/`. Originals are deleted after resize.

```
{photoDirectory}/resized/
  2020/
    IMG_001.jpg
    vacation_photo.jpg
  2021/
    ...
  2022/
    ...
  2023/
    ...
  unknown/          # Fallback when date_taken is null (use file mtime or date_added)
    ...
```

### Filename Collisions
Multiple originals in the same year can share a filename. Options:
1. **Hash suffix**: `IMG_001_a3f2b1.jpg` (short hash of original path)
2. **Preserve subpath**: `2024/Dec/IMG_001.jpg` (year/month)
3. **Counter suffix**: `IMG_001_2.jpg` when collision

**Recommendation**: Option 1 (hash suffix) — deterministic, no duplicates, simple lookup.

---

## Architecture

### Data Flow
```
Original photos (photoDirectory)
        │
        ▼
  Resize Pipeline (new script/service)
        │  - Read EXIF (date_taken, orientation)
        │  - Resize to max 3840×2160
        │  - Output to {photoDirectory}/resized/{year}/
        │  - Update DB filepath → resized path
        │  - Delete original file
        ▼
  Resized image is now the only file; DB filepath points to it
        │
        ▼
  Serve endpoint: stream file (no resize at render)
```

- `filepath`: Points to resized file in `{photoDirectory}/resized/{year}/` — the original is deleted after successful resize

### Config Additions
Resized directory is derived from the original photo directory: `{photoDirectory}/resized/`

- Preserve original format and quality (no hardcoded values)
- Optional overrides in config for `quality`, `format` only when explicit

```json
{
  "resize": {
    "maxWidth": 3840,
    "maxHeight": 2160
  }
}
```

Example: `photoDirectory: "/Volumes/1tb/all-pics/"` → resized at `/Volumes/1tb/all-pics/resized/2024/`, etc.

---

## Implementation Plan

### Phase 1: Resize Pipeline

**New script**: `scripts/resizeTo4k.js` or `src/indexer/resizePipeline.js`

1. **Input**: Reuse `DirectoryScanner` / `MetadataExtractor` to get image list + metadata
2. **Per image**:
   - Resolve `date_taken` → year (fallback: file mtime or `unknown`)
   - Compute output path: `{photoDirectory}/resized/{year}/{basename}_{shortHash}.{ext}` (preserve original extension)
   - If output exists and source `file_modified` unchanged → skip
   - Load with Sharp, apply EXIF orientation
   - Resize: `sharp().resize(3840, 2160, { fit: 'inside', withoutEnlargement: true })`
   - HEIF/HEIC → convert to JPEG (reuse existing heif-convert or Sharp)
   - Write to output path
   - **Update DB `filepath`** to resized path
   - **Delete original** file (only after DB update succeeds — do not delete if update fails)
3. **Batch processing**: Process in configurable batches (e.g. 10 concurrent) to limit memory
4. **Progress**: Log progress, errors, skip count

**CLI**: `npm run resize` or `node src/server.js --resize`

### Phase 2: Database Integration

1. **No schema change** — reuse `filepath` column; update it to resized path after resize
2. **Indexer changes**: When processing an image, call resize pipeline (or run resize as separate step after index)
3. **Update `filepath`** in DB to resized path after successful resize, then delete original

### Phase 3: Serve

**No change** — `filepath` already points to the resized file. Serve via `sendFile(image.filepath)` as today.

### Phase 4: Operations Consistency

| Operation | Behavior |
|-----------|----------|
| **Rotate** | Rotate file at `filepath` (the resized file) in place |
| **Delete** | Move file at `filepath` to data/deleted (same as current) |
| **Re-index** | Scan for new originals (exclude `resized/`); resize, update DB, delete original |
| **New file** | Index, resize, update DB filepath, delete original |

### Phase 5: File Watcher

- **Exclude** `resized/` from watch — only watch for new originals outside resized
- On `add` / `change`: Resize, update DB filepath, delete original
- On `unlink`: Remove from DB (file already gone)

---

## Resize Algorithm (Sharp)

- Preserve original format and quality — no hardcoded values
- Use config overrides only when explicitly set (`config.resize.quality`, `config.resize.format`)
- HEIF/HEIC: convert to JPEG (or configurable format) since display requires raster; quality from config if set, else Sharp default

```javascript
const sharp = require('sharp');

async function resizeTo4k(inputPath, outputPath, config) {
  let pipeline = sharp(inputPath);
  const meta = await pipeline.metadata();
  
  if (meta.orientation && meta.orientation > 1) {
    pipeline = pipeline.rotate();
  }
  
  const { maxWidth, maxHeight, quality, format } = config.resize || {};
  
  pipeline = pipeline.resize(maxWidth, maxHeight, {
    fit: 'inside',
    withoutEnlargement: true
  });
  
  // Preserve original format; only apply quality/format when config specifies
  const outputFormat = format || meta.format || 'jpeg';
  const formatOpts = (outputFormat === 'jpeg' || outputFormat === 'jpg')
    ? (quality !== undefined ? { quality } : {})  // omit = Sharp default
    : {};
  await pipeline.toFormat(outputFormat, formatOpts).toFile(outputPath);
}
```

- **HEIF/HEIC**: Use Sharp if supported, else `heif-convert` → temp file → Sharp resize → output
- **PNG/WebP**: Preserve format unless config specifies otherwise

---

## Folder Structure Summary

With `photoDirectory: "/Volumes/1tb/all-pics/"`:

```
/Volumes/1tb/all-pics/
  (new originals go here; scanned, resized, then deleted)
  resized/
    2019/
      IMG_001_a1b2c3.jpg
      photo_xyz789.jpg
    2020/
      ...
    2021/
      ...
    unknown/
      no_date_abc123.jpg
```

Originals are deleted after resize. DB `filepath` points to `resized/{year}/...`.

---

## Migration Strategy

1. **Initial run**: `npm run resize` — processes all indexed images, resizes to year folders, updates DB filepath, deletes originals
2. **Incremental**: File watcher (excluding `resized/`) + resize-on-add for new files
3. **Backfill**: Optional `--resize-only` flag to re-resize existing files (e.g. after config change)

---

## Edge Cases

| Case | Handling |
|------|----------|
| No `date_taken` | Use `unknown/` folder or derive from `date_added` / file mtime |
| Same filename, same year | Hash suffix: `IMG_001_{pathHash}.jpg` |
| HEIF conversion fails | Skip resize, log error; leave original in place, do not delete |
| Read-only source | Resized dir must be writable; fail gracefully |
| Cross-filesystem | Resized lives with originals; ensure `photoDirectory` is writable |
| Resize succeeds, delete fails | Original remains; DB points to resized. Consider retry or manual cleanup |

---

## Performance Considerations

- **Concurrency**: Limit parallel Sharp operations (e.g. 4–8) to avoid memory spikes
- **Disk**: Resized dir on fast storage (SSD) if possible
- **Storage**: Resized replace originals; net storage typically decreases (smaller 4K files vs raw)
- **First run**: Can take hours for large libraries; run as background job

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `scripts/resizeTo4k.js` or `src/indexer/resizePipeline.js` | **Create** — resize pipeline (update DB filepath, delete original) |
| `src/database/db.js` | **Modify** — add `updateFilePath(id, newPath)` for post-resize update |
| `src/indexer/scanner.js` | **Modify** — exclude `resized/` from scan; trigger resize after index |
| `src/services/imageRotation.js` | **Modify** — rotate file at filepath (resized file) |
| `src/indexer/watcher.js` | **Modify** — exclude `resized/` from watch |
| `config.json` | **Modify** — add `resize` options |
| `package.json` | **Modify** — add `resize` script |

---

## Success Criteria

- [ ] All displayed images are ≤3840×2160
- [ ] No runtime resize in serve path
- [ ] Resized images in `{photoDirectory}/resized/{year}/`; originals deleted
- [ ] DB filepath updated to resized path after each resize
- [ ] Rotation and delete work on resized files
- [ ] New files: resize, update DB, delete original (watcher or index)
