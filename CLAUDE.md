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

**Entry point**: `src/server.js` — boots Express, initializes all subsystems, manages SSE clients, runs the server-side slideshow timer, and coordinates background tasks (geolocation lookup, 4K resize on startup, artistic scoring on startup).

**Config loading** (`src/config.js`): Merges `~/picframe-config.json` (user overrides) over `config.json` (project defaults). Partial overrides work via deep merge.

**Logging** (`src/logger.js`): Structured debug logger, active when `debug.enabled` is true in config. Writes to `data/debug.log`; logs server events, watcher activity, indexing, settings changes, and errors. No-op (and no file created) when disabled.

**Database** (`src/database/db.js`): `better-sqlite3` with WAL mode. Schema lives in `src/database/schema.sql`. All queries are synchronous (better-sqlite3 is sync). Settings are stored in the same DB as a key-value `settings` table. The `images` table also carries `artistic_score`/`artistic_score_details` columns (added via migration) and a geocode-attempted marker so geolocation doesn't keep retrying photos with no GPS/no match. `DatabaseManager.reset()` closes the connection, deletes the DB files (including WAL/SHM), and recreates an empty schema in place, preserving the instance identity so existing references (routes, engine, scanner) stay valid — backs the settings panel's "reset database" action.

**Shared utilities** (`src/lib/`): `paths.js`, `messages.js`, `heif.js`, and `shared.js` hold logic used by more than one module (path resolution, SSE/broadcast message shaping, HEIF conversion helpers, misc formatting) — pulled out during the refactor so scanner/routes/engine stay focused on their own concerns.

**Indexer pipeline** — the scanner and resize pipeline work together:
- `src/indexer/scanner.js` — Walks the photo directory, extracts EXIF metadata, and resizes images during indexing. Originals are **deleted after successful resize**. Already-resized files are indexed as-is during reindex.
- `src/indexer/resizePipeline.js` — Resizes to 4K (3840x2160 `fit:inside`), outputs to `{photoDir}/resized/{year}/`, handles HEIF via `heif-convert` fallback. Files are named `{basename}_{hash}{ext}` to avoid collisions.
- `src/indexer/metadata.js` — EXIF extraction via `exifreader`.
- `src/indexer/watcher.js` — `chokidar` file watcher with debounce queue. Ignores `resized/` and dotfiles.

**Slideshow engine** (`src/slideshow/engine.js`): Four modes — sequential, random, smart (weighted by favorites 3x, recency 2x, "this day" 10x), and artistic (sorted by AI artistic score, best first). Maintains back/forward navigation stacks. Preloads configurable number of images (default 15). Supports an optional `filterSql` setting — a user-supplied SQL filter clause, validated before use to guard against injection. Settings persisted to DB with 500ms debounce on writes.

**Routes**:
- `src/routes/images.js` — Image CRUD, serving (with HEIF-to-JPEG conversion, on-disk cache keyed by image id + mtime), rotation, download, favorites, delete (moves the file to `data/deleted/` for recovery, then removes the row from the DB — the client shows a 5-second undo window before this fires)
- `src/routes/settings.js` — Slideshow settings CRUD; also exposes a restart action that exits the process (relies on a supervisor — systemd, pm2, or Electron — to bring it back up; logs a warning if none is detected)

**Auth** (`src/middleware/auth.js`, `src/routes/login.js`): Optional shared-secret gate. Loopback (the physical frame) is always allowed when `auth.trustLoopback` is set; all other clients must present `config.auth.secret` via the `pf_auth` cookie (set by `/login`), `Authorization: Bearer`, or `X-Auth-Token`. Fails open when disabled or unconfigured. Configured under `auth` in config.

**Services**:
- `src/services/geolocation.js` — Background reverse geocoding via OpenStreetMap Nominatim (rate-limited 1 req/sec); marks photos as geocode-attempted so failed/no-match lookups aren't retried on every startup.
- `src/services/imageRotation.js` — Physical image rotation via Sharp
- `src/services/artisticScoring.js` — Sends resized photos to the Claude API for artistic quality scoring (1 to 1,000,000 scale, across composition/lighting/color/subject/creativity); backs the "Artistic (Best First)" slideshow mode. Disabled by default; requires an API key.

**Frontend**: Two UIs served as static files from `src/public/`:
- Main display (`src/public/index.html`, `src/public/js/app.js`) — fullscreen slideshow for the frame itself
- Remote control (`src/public/remote/`) — mobile-friendly control panel at `/remote`

Both UIs receive real-time updates via SSE (`/api/events`). The slideshow timer is server-authoritative — all clients stay in sync.

**Electron** (`electron/main.js`): Optional wrapper that spawns the Node server as a child process, waits for `/api/health`, then opens a fullscreen BrowserWindow. Env vars: `ELECTRON_USE_EXTERNAL_SERVER`, `ELECTRON_KIOSK`, `PICTUREFRAME_URL`.

## Key Design Decisions

- **Resize-on-ingest**: The scanner resizes originals to 4K and deletes the source file. The DB stores paths to resized copies under `{photoDir}/resized/{year}/`.
- **Server-authoritative slideshow**: Timer and navigation state live on the server. Multiple clients (display + remote) stay synced via SSE broadcasts.
- **Synchronous DB**: All database calls are synchronous (better-sqlite3). Async is only used for file I/O and image processing.
- **HEIF handling**: Sharp is tried first; if it fails, `heif-convert` CLI tool is used as fallback (requires `libheif` installed). Converted JPEGs used for inline serving are cached on disk (keyed by id + mtime) so repeat requests don't reconvert.
- **Artistic scoring is opt-in**: Disabled unless `artisticScore.enabled` is true and an API key is set — the key belongs in `~/picframe-config.json`, never in the tracked `config.json`.
- **Debounced writes**: Database writes for current image position are debounced (500ms) to reduce I/O during rapid navigation.
- The `data/` directory (SQLite database, debug log, deleted files) is gitignored and created automatically.

## Refactoring Rules
- Preserve all existing behavior — no silent logic changes
- Keep commits small and atomic
- Prefer composition over inheritance
- Flag anything that changes a public API contract for review
- Do not refactor tests unless explicitly asked
