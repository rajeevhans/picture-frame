# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Digital picture frame application built for Raspberry Pi (also runs on macOS). Node.js/Express backend with vanilla JS frontend, SQLite database, and optional Electron wrapper. Designed to handle 200k+ photos with real-time file monitoring.

## Commands

```bash
npm start              # Start server (auto-indexes if DB is empty)
npm run dev            # Start with dev logging (allows missing photo dir)
npm run index          # Force full re-index, then exit
npm run resize         # Run 4K resize pipeline on all images
npm run benchmark      # Run benchmark script
npm run electron       # Launch Electron app (starts its own server)
npm run electron:external  # Electron connecting to already-running server
```

No test framework or linter is configured.

## Architecture

**Entry point**: `src/server.js` — boots Express, initializes all subsystems, manages SSE clients, and runs the server-side slideshow timer.

**Config loading** (`src/config.js`): Merges `~/picframe-config.json` (user overrides) over `config.json` (project defaults). Partial overrides work via deep merge.

**Database** (`src/database/db.js`): `better-sqlite3` with WAL mode. Schema lives in `src/database/schema.sql`. All queries are synchronous (better-sqlite3 is sync). Settings are stored in the same DB as a key-value `settings` table.

**Indexer pipeline** — the scanner and resize pipeline work together:
- `src/indexer/scanner.js` — Walks the photo directory, extracts EXIF metadata, and resizes images during indexing. Originals are **deleted after successful resize**. Already-resized files are indexed as-is during reindex.
- `src/indexer/resizePipeline.js` — Resizes to 4K (3840x2160 `fit:inside`), outputs to `{photoDir}/resized/{year}/`, handles HEIF via `heif-convert` fallback. Files are named `{basename}_{hash}{ext}` to avoid collisions.
- `src/indexer/metadata.js` — EXIF extraction via `exifreader`.
- `src/indexer/watcher.js` — `chokidar` file watcher with debounce queue. Ignores `resized/` and dotfiles.

**Slideshow engine** (`src/slideshow/engine.js`): Three modes — sequential, random, smart (weighted by favorites 3x, recency 2x, "this day" 10x). Maintains back/forward navigation stacks. Preloads configurable number of images (default 15). Settings persisted to DB.

**Routes**:
- `src/routes/images.js` — Image CRUD, serving (with HEIF-to-JPEG conversion), rotation, download, favorites, soft delete (moves to `data/deleted/`)
- `src/routes/settings.js` — Slideshow settings CRUD

**Services**:
- `src/services/geolocation.js` — Background reverse geocoding via OpenStreetMap Nominatim (rate-limited 1 req/sec)
- `src/services/imageRotation.js` — Physical image rotation via Sharp

**Frontend**: Two UIs served as static files from `src/public/`:
- Main display (`src/public/index.html`, `src/public/js/app.js`) — fullscreen slideshow for the frame itself
- Remote control (`src/public/remote/`) — mobile-friendly control panel at `/remote`

Both UIs receive real-time updates via SSE (`/api/events`). The slideshow timer is server-authoritative — all clients stay in sync.

**Electron** (`electron/main.js`): Optional wrapper that spawns the Node server as a child process, waits for `/api/health`, then opens a fullscreen BrowserWindow. Env vars: `ELECTRON_USE_EXTERNAL_SERVER`, `ELECTRON_KIOSK`, `PICTUREFRAME_URL`.

## Key Design Decisions

- **Resize-on-ingest**: The scanner resizes originals to 4K and deletes the source file. The DB stores paths to resized copies under `{photoDir}/resized/{year}/`.
- **Server-authoritative slideshow**: Timer and navigation state live on the server. Multiple clients (display + remote) stay synced via SSE broadcasts.
- **Synchronous DB**: All database calls are synchronous (better-sqlite3). Async is only used for file I/O and image processing.
- **HEIF handling**: Sharp is tried first; if it fails, `heif-convert` CLI tool is used as fallback (requires `libheif` installed).

## Refactoring Rules
- Preserve all existing behavior — no silent logic changes
- Keep commits small and atomic
- Prefer composition over inheritance
- Flag anything that changes a public API contract for review
- Do not refactor tests unless explicitly asked
