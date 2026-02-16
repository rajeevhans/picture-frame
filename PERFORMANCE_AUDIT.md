# Raspberry Pi Performance Audit

This document identifies performance bottlenecks in the Picture Frame application when running on a Raspberry Pi (typically Pi 3/4/5 with limited CPU, GPU, and memory).

---

## Raspberry Pi Constraints

| Resource | Pi 3 | Pi 4 (2GB) | Pi 5 |
|----------|------|------------|------|
| CPU | 4× Cortex-A53 @ 1.2GHz | 4× Cortex-A72 @ 1.5GHz | 4× Cortex-A76 @ 2.4GHz |
| RAM | 1GB | 2–8GB | 4–8GB |
| GPU | VideoCore IV | VideoCore VI | VideoCore VII |
| Browser | Chromium (software rendering often) | Chromium (may use GPU) | Chromium |

**Key constraints:**
- Single-threaded JavaScript execution
- Limited GPU acceleration for CSS effects
- Slow disk I/O on SD cards
- Memory pressure with many preloaded images

---

## 1. Frontend: CSS Rendering (High Impact)

### 1.1 Matting Background – Pre-rendered Texture ✓ Implemented

**File:** `src/public/css/style.css`, `src/public/textures/paper.svg`, `src/public/js/app.js`

Previously: 10 stacked gradient layers. **Implemented:** Single pre-rendered `paper.svg` (64×64 tileable) + 2 color gradients = 3 layers total. Filter and box-shadow removed from matting.

---

### 1.2 `filter` on Matting ✓ Implemented

**File:** `src/public/css/style.css`

Previously: `filter: contrast(1.2) brightness(0.96)` on matting. **Implemented:** Removed from matting background.

---

### 1.3 Multiple `box-shadow` on Matting ✓ Implemented

**File:** `src/public/css/style.css`

Previously: 3 inset box-shadows on matting. **Implemented:** Removed from matting background.

---

### 1.4 `transition` on `background-image` ✓ Implemented

**File:** `src/public/css/style.css`

Previously: transition on `background-image`. **Implemented:** Matting now transitions only `opacity` and `background-color`.

---

### 1.5 `backdrop-filter: blur()`

**File:** `src/public/css/style.css` (lines 293, 404, 470)

```css
.info-overlay { backdrop-filter: blur(10px); }
.control-btn { backdrop-filter: blur(10px); }
.settings-panel { backdrop-filter: blur(20px); }
```

**Impact:** `backdrop-filter` is GPU-intensive and often falls back to software rendering on Pi, causing visible lag when overlays appear.

**Recommendation:** Replace with solid/semi-opaque backgrounds (e.g. `background: rgba(0,0,0,0.85)`) for Pi.

---

### 1.6 Image Layer Filters

**File:** `src/public/css/style.css` (lines 209, 214, 219)

```css
.main-image.current { filter: brightness(1); }
.main-image.next { filter: brightness(0.7); }
.main-image.next.loading { filter: brightness(0.3) blur(2px); }
```

**Impact:** `blur(2px)` on the loading state adds extra compositing cost during transitions.

**Recommendation:** Use `opacity` instead of `brightness`/`blur` for loading state.

---

## 2. Frontend: JavaScript (High Impact)

### 2.1 Canvas Color Extraction (Dominant Colors)

**File:** `src/public/js/app.js` (lines 855–1001)

```javascript
// Runs on every image change
async function extractDominantColors(imageElement, colorCount = 3) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    // ...
    ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    for (let i = 0; i < data.length; i += 4 * sampleRate) {
        const hsl = rgbToHsl(r, g, b);  // Called thousands of times
        // ...
    }
    const dominantColors = findDominantColors(colors, colorCount);
}
```

**Impact:**
- `drawImage` + `getImageData` on a 200×200 canvas is CPU-heavy on Pi
- `rgbToHsl` called for thousands of pixels
- `findDominantColors` does sorting and clustering

**Recommendation:**
- Reduce `maxSize` from 200 to 80–100
- Increase `sampleRate` from 5 to 10–15
- Consider caching colors per image ID and skipping extraction when cached
- Option to disable matting on Pi via config

---

### 2.2 Dynamic Matting Background Construction

**File:** `src/public/js/app.js` (lines 1217–1236)

```javascript
const textureLayers = `
    repeating-linear-gradient(0deg, ...),
    repeating-linear-gradient(90deg, ...),
    repeating-linear-gradient(45deg, ...),
    repeating-linear-gradient(-45deg, ...),
    repeating-linear-gradient(12deg, ...),
    repeating-linear-gradient(78deg, ...),
    linear-gradient(135deg, ...),
    linear-gradient(45deg, ...)`;
elements.mattingBackground.style.backgroundImage = 
    `${colorGradient1}, ${colorGradient2}${textureLayers}`;
```

**Impact:** Building and applying a 10-layer `backgroundImage` string on every image change forces a full style recalc and repaint.

**Recommendation:** Use a simpler 1–2 layer gradient; avoid re-applying texture layers if they are static.

---

### 2.3 Preload Count

**File:** `config.json`, `src/slideshow/engine.js` (line 23)

```json
"numberOfImagesToPreload": 15
```

**Impact:** Preloading 15 full-resolution images consumes significant memory and bandwidth. On a Pi with 1–2GB RAM, this can cause swapping and slowdowns.

**Recommendation:** Reduce to 3–5 for Pi. Consider serving thumbnails for preload instead of full images.

---

### 2.4 `mousemove` Handler

**File:** `src/public/js/app.js` (lines 1313–1335)

```javascript
function handleMouseMove() {
    if (!state.controlsVisible) showControls();
    if (state.mouseMoveTimer) clearTimeout(state.mouseMoveTimer);
    state.mouseMoveTimer = setTimeout(() => {
        if (state.controlsTimer) clearTimeout(state.controlsTimer);
        state.controlsTimer = setTimeout(() => hideControls(), 5000);
    }, 500);
}
```

**Impact:** `mousemove` fires very frequently. Each event runs `showControls()` and timer logic. On Pi, this can cause jank when the mouse is moving.

**Recommendation:** Throttle `mousemove` to ~100–200ms (e.g. with `requestAnimationFrame` or a simple throttle).

---

## 3. Backend: Indexing & Metadata (Medium Impact)

### 3.1 Synchronous File I/O in Metadata Extraction

**File:** `src/indexer/metadata.js` (lines 10–18)

```javascript
async extractMetadata(filePath) {
    const buffer = fs.readFileSync(filePath);  // BLOCKING
    const tags = ExifReader.load(buffer, { expanded: true });
    // ...
    fileModified: fs.statSync(filePath).mtimeMs,  // BLOCKING
}
```

**Impact:** `readFileSync` and `statSync` block the event loop. With batch size 100, this can cause noticeable stalls during indexing.

**Recommendation:** Use `fs.promises.readFile` and `fs.promises.stat` for async I/O.

---

### 3.2 Per-File `statSync` in Scanner

**File:** `src/indexer/scanner.js` (lines 113–121)

```javascript
if (!forceReindex) {
    const existing = this.db.getImageByPath(filePath);
    if (existing) {
        const currentMtime = fs.statSync(filePath).mtimeMs;  // One stat per file
        if (existing.file_modified === currentMtime) {
            this.stats.skipped++;
            continue;
        }
    }
}
```

**Impact:** `statSync` for every file in a batch blocks the event loop. With thousands of files, this adds up.

**Recommendation:** Use `fs.promises.stat` and process with `Promise.all` for batch stat checks.

---

### 3.3 Orphan Cleanup – Full Table Scan

**File:** `src/database/db.js` (lines 204–218)

```javascript
cleanupOrphanedEntries(checkFileExists) {
    const stmt = this.db.prepare('SELECT id, filepath FROM images WHERE is_deleted = 0');
    const images = stmt.all();
    for (const image of images) {
        if (!checkFileExists(image.filepath)) {  // fs.existsSync per image
            this.deleteImageByPath(image.filepath);
        }
    }
}
```

**Impact:** Loads all image paths into memory and calls `fs.existsSync` (blocking) for each. With 10,000+ images, this is slow.

**Recommendation:** Process in batches with async `fs.promises.access` and yield between batches.

---

## 4. Backend: Image Serving (Medium Impact)

### 4.1 HEIF Conversion via `heif-convert` Subprocess

**File:** `src/routes/images.js` (lines 23–76)

```javascript
async function convertHeifToJpeg(heifPath, outputStream, quality = 90) {
    const tempFile = path.join(os.tmpdir(), `heif_${Date.now()}_${...}.jpg`);
    const heifConvert = spawn('heif-convert', ['-q', quality.toString(), heifPath, tempFile], ...);
    // Waits for process, reads temp file, streams to response
}
```

**Impact:** Spawns a subprocess, writes to temp file, then streams. On Pi, HEIF decode is CPU-intensive and can block other requests.

**Recommendation:** Consider a queue for HEIF conversions or lower JPEG quality (e.g. 75) for Pi.

---

### 4.2 Image Rotation (Sharp)

**File:** `src/services/imageRotation.js` (lines 36–45)

```javascript
const image = sharp(fullPath);
const metadata = await image.metadata();
await image.rotate(degrees).toFile(fullPath + '.tmp');
await fs.promises.rename(fullPath + '.tmp', fullPath);
```

**Impact:** Sharp is fast but still CPU-heavy for large images. On Pi, rotating a 20MP photo can take several seconds.

**Recommendation:** Run rotation in a worker or queue; show a loading state. Consider max dimension limit for Pi.

---

## 5. Backend: Database (Lower Impact)

### 5.1 `ORDER BY RANDOM()`

**File:** `src/database/db.js` (line 111)

```javascript
} else if (options.orderBy === 'random') {
    query += ' ORDER BY RANDOM()';
}
```

**Impact:** `ORDER BY RANDOM()` forces a full table scan and sort. With 10,000+ images, this can take 100–500ms.

**Recommendation:** Use a pre-shuffled list or random offset: `ORDER BY id LIMIT 1 OFFSET (abs(random()) % (SELECT count(*)))` (still not ideal) or maintain a shuffled in-memory list.

---

### 5.2 Smart Mode Weight Calculation

**File:** `src/slideshow/engine.js` (lines 231–288)

```javascript
selectSmartImage() {
    this.smartWeights = this.imageList.map((img) => {
        let weight = 1;
        if (img.is_favorite) weight *= 3;
        if (img.date_taken) {
            const photoDate = new Date(img.date_taken);
            if (photoDate > oneMonthAgo) weight *= 2;
            if (photoDate.getMonth() === todayMonth && photoDate.getDate() === todayDate) weight *= 10;
        }
        return weight;
    });
    const totalWeight = this.smartWeights.reduce((sum, w) => sum + w, 0);
    // ... weighted random selection
}
```

**Impact:** Iterates over the full image list and creates a weights array. With 10,000+ images, this is O(n) per advance in smart mode. Cached for 5 seconds, so impact is limited but still present on mode switch.

**Recommendation:** Cache longer or precompute weights during `refreshImageList`.

---

## 6. Backend: Geolocation (Lower Impact)

### 6.1 Sequential Batch Lookup

**File:** `src/services/geolocation.js` (lines 129–145)

```javascript
async batchLookup(images, updateCallback) {
    for (const image of images) {
        const { city, country } = await this.reverseGeocode(image.latitude, image.longitude);
        if (city || country) {
            await updateCallback(image.id, { locationCity: city, locationCountry: country });
        }
    }
}
```

**Impact:** Fully sequential with 1 req/sec rate limit. Processing 100 images takes ~100 seconds. Not a Pi-specific issue but contributes to startup load.

**Recommendation:** Already rate-limited; consider reducing batch size on Pi to free CPU for slideshow.

---

## 7. Summary: Priority Optimizations for Raspberry Pi

| Priority | Area | Change | Est. Impact |
|----------|------|--------|-------------|
| P0 | CSS | Remove/reduce `backdrop-filter` | High – overlay lag |
| P0 | CSS | Simplify matting to 2–3 layers, remove `filter` | High – repaint cost |
| P0 | JS | Reduce preload count to 3–5 | High – memory |
| P1 | JS | Smaller canvas + higher sample rate for color extraction | Medium |
| P1 | JS | Throttle `mousemove` | Medium |
| P1 | CSS | Don’t transition `background-image` | Medium |
| P2 | Backend | Use async `fs` in metadata/scanner | Medium |
| P2 | Backend | Batch async orphan cleanup | Low–Medium |
| P2 | DB | Avoid `ORDER BY RANDOM()` on large sets | Low |

---

## 8. Config Additions for Pi Mode

Consider a `raspberryPi: true` (or `lowPower: true`) flag in `config.json` that:

- Sets `numberOfImagesToPreload: 3`
- Disables or simplifies matting (no color extraction, solid background)
- Serves a “low effects” CSS bundle (no `backdrop-filter`, fewer gradients)
- Reduces HEIF conversion quality

This allows one codebase to adapt automatically when running on Pi.

---

## 9. Running the Benchmark

A benchmark script measures key operations:

```bash
npm run benchmark
```

Or with a custom photo directory:

```bash
node scripts/benchmark.js --photo-dir /path/to/photos
```

The script benchmarks:
- Color extraction CPU (rgbToHsl, findDominantColors)
- Smart mode weight calculation
- Database queries (indexed vs ORDER BY RANDOM)
- Orphan cleanup simulation
- Metadata extraction (sync I/O)

Run on a Pi to establish baselines before and after optimizations.

---

## 10. Slow Code Snippets (Reference)

These are the exact code portions identified as potentially slow on Raspberry Pi.

### 10.1 Canvas color extraction (app.js:876–946)

```javascript
ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
const data = imageData.data;
for (let i = 0; i < data.length; i += 4 * sampleRate) {
    const hsl = rgbToHsl(r, g, b);  // Thousands of calls
    // ...
}
const dominantColors = findDominantColors(colors, colorCount);
```

### 10.2 Blocking metadata extraction (metadata.js:11–18)

```javascript
const buffer = fs.readFileSync(filePath);   // Blocks event loop
const tags = ExifReader.load(buffer, { expanded: true });
// ...
fileModified: fs.statSync(filePath).mtimeMs,  // Blocks again
```

### 10.3 Blocking stat in scanner (scanner.js:116)

```javascript
const currentMtime = fs.statSync(filePath).mtimeMs;
```

### 10.4 Orphan cleanup (db.js:204–218)

```javascript
const images = stmt.all();  // Loads all paths
for (const image of images) {
    if (!checkFileExists(image.filepath)) {  // fs.existsSync per image
        this.deleteImageByPath(image.filepath);
    }
}
```

### 10.5 Matting CSS (style.css:43, 162, 165)

```css
transition: opacity 0.6s, background-color 0.6s, background-image 0.6s;
filter: contrast(1.2) brightness(0.96);
box-shadow: inset 0 0 300px ..., inset 0 0 150px ..., inset 0 0 50px ...;
```

### 10.6 ORDER BY RANDOM (db.js:111)

```javascript
query += ' ORDER BY RANDOM()';
```
