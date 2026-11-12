const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { PROJECT_ROOT, DATA_DIR } = require('../lib/paths');

const SOURCE = path.join(PROJECT_ROOT, 'macos', 'face-detect.swift');
const BINARY = path.join(DATA_DIR, 'bin', 'face-detect');
const BATCH_SIZE = 50;
// With nothing left to check, look again this often (new photos also wake it).
const IDLE_RECHECK_MS = 5 * 60 * 1000;
// One photo takes ~30 ms; this long without an answer means the helper hung on it.
const HANG_MS = 60 * 1000;
// Exits without a single answer in a row before giving up (e.g. a broken build).
const MAX_FUTILE_EXITS = 5;
const PROGRESS_EVERY = 1000;
// Signals that mean the helper crashed, most likely on the photo it was reading
const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGABRT', 'SIGTRAP', 'SIGFPE']);

/**
 * Finds faces in photos in the background so the fill-screen crop can keep
 * people in view. macOS only: the Vision-based helper in
 * macos/face-detect.swift is compiled into data/bin/ on first start. Each
 * photo is checked once (images.faces / images.faces_checked); new photos are
 * picked up when wake() is called or within IDLE_RECHECK_MS.
 *
 * Elsewhere, or if the helper can't be built, every photo simply has no face
 * data and the crop falls back to slightly above center.
 */
class FaceDetectionService {
    /**
     * @param {object} db - DatabaseManager
     * @param {object} config - app config; uses config.faceDetection.enabled (default true)
     */
    constructor(db, config = {}, deps = {}) {
        this.db = db;
        const opts = config.faceDetection || {};
        this.offReason = opts.enabled === false ? 'config' : process.platform !== 'darwin' ? 'platform' : null;
        this.enabled = !this.offReason;
        this.source = deps.source || SOURCE;
        this.binary = deps.binary || BINARY;
        this.batchSize = deps.batchSize || BATCH_SIZE;
        this.hangMs = deps.hangMs || HANG_MS;
        this.child = null;
        this.inFlight = [];        // [{ id, filepath }] in the order sent to the helper
        this.available = false;    // helper built and usable
        this.building = false;
        this.stopped = false;
        this.idleTimer = null;
        this.restartTimer = null;
        this.hangTimer = null;
        this.restarts = 0;
        this.futileExits = 0;      // exits in a row without any answer
        this.answeredSinceSpawn = 0;
        this.checked = 0;          // photos checked since start
        this.lastError = null;
    }

    async start() {
        if (!this.enabled || this.stopped) return;
        try {
            this.building = true;
            await this._ensureBinary();
            this.available = true;
        } catch (error) {
            this.lastError = `Could not build the face detector: ${error.message}`;
            console.warn(`Face detection unavailable. ${this.lastError}`);
            logger.error('Face detector build failed', { error: error.message });
            return;
        } finally {
            this.building = false;
        }
        const pending = this.db.countFacesPending();
        if (pending) console.log(`Face detection: ${pending.toLocaleString()} photo(s) to check`);
        this._next();
    }

    /** New or changed photos: check them now instead of at the next idle recheck. */
    wake() {
        if (!this.available || this.stopped || this.inFlight.length || this.restartTimer) return;
        this._next();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.idleTimer);
        clearTimeout(this.restartTimer);
        clearTimeout(this.hangTimer);
        if (this.child) {
            this.child.removeAllListeners('close');
            this.child.kill();
            this.child = null;
        }
        this.inFlight = [];
    }

    status() {
        return {
            enabled: this.enabled,
            offReason: this.offReason,     // 'config' | 'platform' | null
            available: this.available,
            building: this.building,
            pending: this.enabled ? this.db.countFacesPending() : null,
            error: this.lastError
        };
    }

    /** Compile the helper unless an up-to-date build is already there. */
    async _ensureBinary() {
        const srcTime = fs.statSync(this.source).mtimeMs;
        try {
            if (fs.statSync(this.binary).mtimeMs >= srcTime) return;
        } catch (_) { /* not built yet */ }
        fs.mkdirSync(path.dirname(this.binary), { recursive: true });
        const tmp = `${this.binary}.tmp-${process.pid}`;
        console.log('Face detection: building the detector (one time)...');
        await new Promise((resolve, reject) => {
            execFile('/usr/bin/xcrun', ['swiftc', '-O', this.source, '-o', tmp], { timeout: 5 * 60 * 1000 },
                (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim().split('\n').pop())) : resolve());
        });
        fs.renameSync(tmp, this.binary);
    }

    _spawn() {
        const child = spawn('/usr/bin/nice', ['-n', '10', this.binary], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        this.answeredSinceSpawn = 0;
        child.killReason = null;
        // Split on '\n' only (readline also splits on U+2028/U+2029, which
        // can appear in a path and would knock answers out of step).
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            buffer += chunk;
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (this.child === child) this._onLine(line);
            }
        });
        child.stderr.on('data', d => logger.debug('face-detect stderr', { text: d.toString().slice(0, 500) }));
        child.stdin.on('error', () => { /* close handler deals with it */ });
        child.on('error', error => {
            this.lastError = `Face detector failed to start: ${error.message}`;
            console.error(this.lastError);
        });
        // 'close' (not 'exit'): stdout is fully read by then, so an answer
        // written just before a crash is never mistaken for a missing one.
        child.on('close', (code, signal) => this._onClose(child, code, signal));
    }

    _armHangTimer() {
        clearTimeout(this.hangTimer);
        if (!this.inFlight.length || !this.child) return;
        const child = this.child;
        this.hangTimer = setTimeout(() => {
            if (this.child !== child) return;
            child.killReason = 'hang';
            child.kill('SIGKILL');
        }, this.hangMs);
    }

    _next() {
        clearTimeout(this.idleTimer);
        if (this.stopped || this.inFlight.length) return;
        const rows = this.db.getImagesNeedingFaces(this.batchSize);
        if (!rows.length) {
            this.idleTimer = setTimeout(() => this._next(), IDLE_RECHECK_MS);
            return;
        }
        if (!this.child) this._spawn();
        for (const row of rows) {
            // One path per line: a path containing a newline can't be sent
            if (/[\r\n]/.test(row.filepath)) {
                this.db.setFaces(row.id, null);
                continue;
            }
            this.inFlight.push(row);
            this.child.stdin.write(row.filepath + '\n');
        }
        if (!this.inFlight.length) setImmediate(() => this._next());
        else this._armHangTimer();
    }

    _onLine(line) {
        if (!this.inFlight.length) return;
        let result = null;
        try { result = JSON.parse(line); } catch (_) { /* checked below */ }
        const item = this.inFlight[0];
        if (!result || result.path !== item.filepath) {
            // Out of step with the helper: restart it and leave the rest of
            // the batch unchecked, so nothing gets someone else's answer.
            logger.error('face-detect answer out of step', { expected: item.filepath, got: result && result.path });
            this.child.killReason = 'desync';
            this.child.kill();
            return;
        }
        this.inFlight.shift();
        this.db.setFaces(item.id, Array.isArray(result.faces) ? result.faces : null);
        this.answeredSinceSpawn++;
        this.restarts = 0;
        this.futileExits = 0;
        if (++this.checked % PROGRESS_EVERY === 0) {
            console.log(`Face detection: ${this.checked.toLocaleString()} checked, ${this.db.countFacesPending().toLocaleString()} left`);
        }
        if (!this.inFlight.length) {
            clearTimeout(this.hangTimer);
            setImmediate(() => this._next());
        } else {
            this._armHangTimer();
        }
    }

    _onClose(child, code, signal) {
        if (this.child !== child) return;
        this.child = null;
        clearTimeout(this.hangTimer);
        if (this.stopped) return;
        // Only a crash or a hang points at the photo being read: mark that
        // one done (no faces) so it can't stop the helper forever. Any other
        // exit leaves every photo unchecked, to be tried again.
        const culprit = this.inFlight[0];
        const blame = culprit && (child.killReason === 'hang' || (!child.killReason && CRASH_SIGNALS.has(signal)));
        if (blame) {
            this.db.setFaces(culprit.id, null);
            logger.error('face-detect stopped on a photo', { code, signal, reason: child.killReason || 'crash', photo: culprit.filepath });
        }
        this.inFlight = [];
        if (!blame && this.answeredSinceSpawn === 0 && ++this.futileExits >= MAX_FUTILE_EXITS) {
            this.available = false;
            this.lastError = `Face detector keeps ${child.killReason === 'desync' ? 'answering out of step' : `exiting (${signal || `code ${code}`})`}; stopped. Restart the frame to try again.`;
            console.error(this.lastError);
            return;
        }
        if (child.killReason === 'desync') {
            this.restartTimer = setTimeout(() => { this.restartTimer = null; this._next(); }, 1000);
            return;
        }
        const delay = Math.min(5 * 60 * 1000, 1000 * 2 ** Math.min(this.restarts++, 8));
        console.warn(`Face detector exited (${signal || code}); restarting in ${Math.round(delay / 1000)} s`);
        this.restartTimer = setTimeout(() => { this.restartTimer = null; this._next(); }, delay);
    }
}

module.exports = FaceDetectionService;
