# Fix Rough Edges — Design Spec

**Date:** 2026-07-25
**Status:** Approved, ready for planning
**Scope:** Cleanup pass fixing the rough edges identified in the feature inventory, plus adding shared-secret authentication.

## Goal

Fix the set of rough edges in the picture-frame codebase. Behavior is preserved everywhere except the explicit changes called out below. Work proceeds as small atomic commits (per CLAUDE.md), grouped: bug fixes → reworks → auth (last, because it touches routing globally).

There is no test framework in this repo. Verification is by driving the real app end-to-end (the `verify` skill) plus targeted throwaway checks for auth.

## Decisions locked during brainstorming

| Item | Decision |
|---|---|
| Soft-delete dead code | **Remove** the dead code; embrace hard-delete |
| Destructive ingest (delete originals after resize) | **Leave as-is** — no change |
| Authentication | **Add** — shared secret (token/PIN), guard everything except the local display |
| DB reset / self-restart fragility | **Rework** both |
| HEIF cache | On-disk |
| Restart mechanism | Exit-and-let-supervisor-respawn |
| Config `slideshow.default*` disconnect | Wire up as first-run seed values |

---

## Section 1 — Authentication (shared secret, localhost-open)

### Model
The physical frame runs on the device and reaches the server over loopback, so **loopback requests bypass auth entirely**. Every non-loopback request (LAN browsers, the phone remote, Stream Deck) must present the secret. This satisfies "guard everything except the local display."

### Config
Add an `auth` block to `config.json` defaults (overridable via `~/picframe-config.json`):

```
auth: {
  enabled: true,
  secret: null,          // the PIN/token
  trustLoopback: true,   // the frame bypass
  cookieName: "pf_auth"
}
```

**Fail-open-with-warning:** when `enabled: true` but `secret` is null/empty, log a loud startup warning and treat auth as disabled. A picture frame must never lock itself into an unrecoverable state because a PIN was not set.

### Middleware — `src/middleware/auth.js`
Mounted before all routes. Logic, in order:

1. If `!enabled` or no secret configured → pass through.
2. If request is loopback (`127.0.0.1` / `::1`) and `trustLoopback` → pass through.
3. Otherwise accept the secret via any of: cookie (`pf_auth`), `Authorization: Bearer <token>`, or `X-Auth-Token` header. Compare using `crypto.timingSafeEqual` (constant-time).
4. Match → `next()`. No match → `/api/*` returns `401` JSON; HTML page requests redirect to `/login`.

### Login flow
- `GET /login` — small login form, reusing existing CSS.
- `POST /login` — validates the secret, sets an **HttpOnly** `pf_auth` cookie, redirects to `/` (or the `next` target, e.g. `/remote`).
- **Brute-force limiter:** simple in-memory limiter (e.g. 10 attempts / 5 min per IP) because a PIN is guessable.
- **SSE:** `EventSource` cannot send custom headers but does send cookies, so guarded SSE relies on the `pf_auth` cookie.

### Docs
Add an auth section to `README.md` and `CLAUDE.md`.

### What stays open regardless
Loopback (the frame). Everything else is guarded when auth is active.

---

## Section 2 — Rework the two fragile patterns

### 2a. DB reset
**Current:** `POST /api/database/reset` swaps the DB instance via `Object.assign(db, newDb)`.
**Change:** add a real `DatabaseManager.reset()` method that, on the same manager instance:
1. Closes the current connection.
2. Deletes the DB files (db + WAL/SHM).
3. Recreates the schema.
4. Reopens the connection.

Because the manager instance identity is preserved, all existing references stay valid. No object-swapping.

### 2b. Self-restart — **behavior change (approved)**
**Current:** `POST /api/settings/restart` spawns a detached replacement process, which double-runs under Electron and fights systemd.
**Change:** the endpoint responds, then exits cleanly (`process.exit(0)`) and lets the supervisor respawn — matching the real deployments (systemd `Restart=always`, Electron's child-death handler). If no supervisor is detected (bare `npm start`), log a clear warning instead of silently spawning a copy, so the operator understands the process will not come back on its own.

---

## Section 3 — Bucket A bug fixes

1. **Watcher → slideshow refresh.** Inject a debounced `refreshImageList()` callback into the watcher; call it after add/change/unlink so watcher-added photos enter the live slideshow. Debounced so a bulk import refreshes once, not per-file.

2. **HEIF conversion cache (on-disk).** Cache converted JPEG bytes under `data/heif-cache/`, keyed by `{id}-{file_modified}.jpg`. Serve from cache when present; the mtime bump on rotate invalidates automatically. Persists across restarts and is kind to Pi RAM.

3. **Geolocation failed-marker.** Add a `geocode_attempted` column (idempotent `ALTER TABLE ... ADD COLUMN`). Set it after every attempt — success *or* null result. `getImagesNeedingLocation` filters `geocode_attempted = 0`. Stops the forever-requery of un-geocodable photos on every restart.

4. **Frontend color extraction.**
   - Fix the bad index at `app.js:1187-1188` (`colors[colors[0]]` used as an array index).
   - Do color extraction on a dedicated `new Image()` so the display element's own `onload` handlers are never clobbered.

5. **Smart-weight cache mismatch.** Version the smart-mode weight cache on the image-list identity (bump the version in `refreshImageList`), not just the 5s timer, so a mid-window delete cannot index-mismatch the weights against the new list.

6. **Preload divide-by-zero.** Guard an empty `imageList` in `getPreloadImages` (return `[]`).

7. **Graceful shutdown.** Register `SIGINT`/`SIGTERM` handlers **unconditionally** (currently only registered when the photo dir exists and not force-indexing), so dev mode also closes the DB cleanly.

8. **Config `slideshow.default*` disconnect.** These keys are ignored once the DB exists. Apply them as the seed values on first-run DB initialization so they actually take effect, and document that the DB is authoritative thereafter.

---

## Section 4 — Remove soft-delete dead code

Deletion is always a hard delete (row removed, file moved to `data/deleted/`), so the soft-delete scaffolding is dead:

- Drop the `is_deleted` column from `schema.sql`.
- Remove all `WHERE is_deleted = 0` filters in `db.js`.
- Remove the always-0 `deleted` count from `getStats()`.
- Remove the `deleted` stat from the frontend stats display.

Confirm no remaining reader depends on the column before dropping it.

---

## Sequencing & commits

1. Bucket A fixes (each its own commit, low-risk, isolated): watcher refresh, HEIF cache, geocode marker, frontend color fixes, smart-weight versioning, preload guard, shutdown handlers, config seed.
2. Remove soft-delete dead code.
3. DB reset rework.
4. Self-restart rework.
5. Auth (config → middleware → login flow → wire into routing → docs).

## Verification

- Drive the real app for each behavioral change (`verify` skill): watcher adds a photo and it appears; HEIF serves from cache on second request; delete flow; DB reset; restart under a supervised run.
- Auth: throwaway checks confirming loopback bypass, cookie/header/bearer acceptance, 401 vs redirect, and the brute-force limiter.
- Confirm no regression in the display/remote SSE sync.

## Out of scope

- Multi-user accounts / sessions (only a shared secret).
- Keep-originals ingest option (destructive ingest stays).
- Any refactoring unrelated to the rough edges above.
