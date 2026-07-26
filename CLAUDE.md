# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A digital picture frame application for Raspberry Pi (also runs on macOS via Electron). It serves a web-based slideshow UI, indexes photos from a configurable directory, and supports real-time control via a remote interface.

## Commands

- `npm start` — Start the server (production)
- `npm run dev` — Start in dev mode (allows missing photo directory)
- `npm run index` — Force re-index all photos then exit
- `npm run resize` — Batch resize images to 4K max
- `npm run electron` — Run as Electron desktop app
- `npm run electron:external` — Electron app connecting to external server
- `npm run benchmark` — Run performance benchmarks

No test framework or linter is configured.

## Architecture

**Server (`src/server.js`)** — Express app that wires everything together. Manages SSE connections for real-time client updates, controls the server-side slideshow timer, and coordinates background tasks (geolocation lookup, 4K resize on startup).

**Config (`src/config.js`)** — Loads `~/picframe-config.json` if it exists, deep-merged over the project's `config.json` defaults. User config supports partial overrides.

**Database (`src/database/db.js`, `schema.sql`)** — SQLite via `better-sqlite3` with WAL mode. Two tables: `images` (photo metadata, EXIF, location, favorites/tags) and `settings` (key-value for slideshow state). Schema auto-creates on startup.

**Indexer** — `scanner.js` walks the photo directory and extracts EXIF via `exifreader`. `metadata.js` handles EXIF parsing. `watcher.js` uses `chokidar` for live filesystem monitoring. `resizePipeline.js` handles 4K downscaling via `sharp`.

**Slideshow Engine (`src/slideshow/engine.js`)** — Core navigation logic. Supports sequential, random, smart (weighted random favoring favorites, recent photos, "this day in history"), and artistic (sorted by AI artistic score) modes. Maintains back/forward navigation stacks. Preloads configurable number of upcoming images.

**Routes** — `routes/images.js` serves image files (with HEIF-to-JPEG conversion fallback), handles navigation (next/prev/goto), favorites, rotation, deletion. `routes/settings.js` handles slideshow settings CRUD.

**Services** — `geolocation.js` does reverse geocoding from GPS EXIF data. `imageRotation.js` handles lossless JPEG rotation. `artisticScoring.js` sends photos to Claude Vision API for artistic quality scoring (1–1,000,000 scale).

**Frontend (`src/public/`)** — Single-page app with `index.html`, `css/style.css`, and `js/app.js`. Connects to server via SSE for real-time image updates. Includes a `/remote` control interface.

**Electron (`electron/`)** — Wraps the web UI in a desktop window. Can run its own server or connect to an external one.

## Key Design Decisions

- Slideshow timing is **server-authoritative** — the server drives image advancement via `setTimeout` and broadcasts to all SSE clients simultaneously.
- Image serving pipes files through `sharp` for on-the-fly resizing/format conversion rather than pre-generating thumbnails.
- HEIF/HEIC support falls back to `heif-convert` CLI tool when Sharp can't handle certain compression formats.
- Database writes for current image position are debounced (500ms) to reduce I/O during rapid navigation.
- The `data/` directory (SQLite database) is gitignored and created automatically.
