const { imageMessage, slideshowStateMessage } = require('../lib/messages');

// Allow-lists for settings. Exposed (via static on the class) so callers
// can inspect them for UI/validation purposes without duplicating strings.
const VALID_MODES = Object.freeze(['sequential', 'random', 'smart']);
const VALID_ORDERS = Object.freeze(['date', 'filename', 'thisday']);

/**
 * Error type thrown by SlideshowEngine.updateSettings when input fails
 * validation. Routes map this to HTTP 400.
 */
class SettingsValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SettingsValidationError';
    }
}

class SlideshowEngine {
    /**
     * @param {object} db - DatabaseManager
     * @param {object} config - App config
     * @param {object} [deps]
     * @param {(msg: object) => void} [deps.broadcast] - Broadcast a pre-built
     *   SSE message. If omitted, broadcasts are silently dropped (useful for
     *   tests and one-shot scripts like indexing).
     */
    constructor(db, config = {}, deps = {}) {
        this.db = db;
        this.currentIndex = 0;
        this.currentImageId = null;
        this.imageList = [];
        this.settings = {
            mode: 'sequential',
            order: 'date',
            interval: 10,
            favoritesOnly: false
        };
        // Reliable navigation history
        this.backStack = [];
        this.forwardStack = [];
        this.maxHistorySize = 50;
        // Debounce database writes for performance
        this.dbWriteTimer = null;
        this.pendingImageId = null;
        // Cache for smart mode weights
        this.smartWeights = null;
        this.smartWeightsTimestamp = 0;
        // Number of images to preload (from config, default 15)
        this.preloadCount = (config.slideshow && config.slideshow.numberOfImagesToPreload) || 15;

        // Timer state (previously lived in server.js) -------------------
        this.broadcast = deps.broadcast || (() => {});
        this.isPlaying = false;
        this.tickTimer = null;
        // Monotonic token to invalidate already-queued setTimeout callbacks
        // when the schedule changes (interval update, manual nav, pause).
        this.tickToken = 0;
        this.advanceInProgress = false;
    }

    initialize() {
        // Load settings from database
        const savedSettings = this.db.getAllSettings();
        if (savedSettings.slideshow_mode) {
            this.settings.mode = savedSettings.slideshow_mode;
        }
        if (savedSettings.slideshow_interval) {
            this.settings.interval = parseInt(savedSettings.slideshow_interval);
        }
        if (savedSettings.slideshow_order) {
            this.settings.order = savedSettings.slideshow_order;
        }
        if (savedSettings.filter_favorites_only) {
            this.settings.favoritesOnly = savedSettings.filter_favorites_only === '1';
        }
        if (savedSettings.current_image_id) {
            this.currentImageId = parseInt(savedSettings.current_image_id);
        }

        // Load image list
        this.refreshImageList();

        console.log('Slideshow engine initialized:', this.settings);
    }

    refreshImageList() {
        const options = {
            favoritesOnly: this.settings.favoritesOnly
        };

        // Special handling for "this day" order
        if (this.settings.order === 'thisday') {
            options.thisDay = true;
            options.orderBy = 'thisday';
        } else if (this.settings.mode === 'sequential') {
            options.orderBy = this.settings.order;
        } else if (this.settings.mode === 'random') {
            options.orderBy = 'random';
        } else if (this.settings.mode === 'smart') {
            // For smart mode, we'll get all images and apply weighting
            options.orderBy = this.settings.order;
        }

        this.imageList = this.db.getAllImages(options);
        console.log(`Loaded ${this.imageList.length} images for slideshow`);

        // Find current index if we have a current image
        if (this.currentImageId && this.imageList.length > 0) {
            // Optimize: check if current index still points to same image
            if (this.currentIndex >= 0 && 
                this.currentIndex < this.imageList.length && 
                this.imageList[this.currentIndex].id === this.currentImageId) {
                // Index is still valid, no need to search
            } else {
                // Need to find the image
                this.currentIndex = this.imageList.findIndex(img => img.id === this.currentImageId);
                if (this.currentIndex === -1) {
                    this.currentIndex = 0;
                }
            }
        } else if (this.imageList.length > 0) {
            this.currentIndex = 0;
        }

        // Prune history stacks to only include images that still exist in the list
        const validIds = new Set(this.imageList.map(img => img.id));
        this.backStack = this.backStack.filter(id => validIds.has(id));
        this.forwardStack = this.forwardStack.filter(id => validIds.has(id));
    }

    setCurrentImageById(imageId) {
        if (!imageId || this.imageList.length === 0) return false;
        let index = this.imageList.findIndex(img => img.id === imageId);
        if (index === -1) {
            // List might be stale (filters changed / deleted); refresh once and retry
            this.refreshImageList();
            index = this.imageList.findIndex(img => img.id === imageId);
        }
        if (index === -1) return false;

        this.currentIndex = index;
        this.currentImageId = imageId;
        this.db.setSetting('current_image_id', imageId);
        return true;
    }

    pushBack(id) {
        if (!id) return;
        const last = this.backStack[this.backStack.length - 1];
        if (last === id) return;
        this.backStack.push(id);
        if (this.backStack.length > this.maxHistorySize) {
            this.backStack.shift();
        }
    }

    pushForward(id) {
        if (!id) return;
        const last = this.forwardStack[this.forwardStack.length - 1];
        if (last === id) return;
        this.forwardStack.push(id);
        if (this.forwardStack.length > this.maxHistorySize) {
            this.forwardStack.shift();
        }
    }

    getCurrentImage() {
        if (this.imageList.length === 0) {
            return null;
        }

        if (this.currentIndex < 0 || this.currentIndex >= this.imageList.length) {
            this.currentIndex = 0;
        }

        const image = this.imageList[this.currentIndex];
        this.currentImageId = image.id;
        
        // Debounce database writes to reduce I/O (write after 500ms of no changes)
        this.pendingImageId = image.id;
        if (this.dbWriteTimer) {
            clearTimeout(this.dbWriteTimer);
        }
        this.dbWriteTimer = setTimeout(() => {
            if (this.pendingImageId) {
                this.db.setSetting('current_image_id', this.pendingImageId);
                this.pendingImageId = null;
            }
        }, 500);

        return this.formatImage(image);
    }

    getNextImage() {
        if (this.imageList.length === 0) {
            return null;
        }

        const prevId = this.currentImageId || (this.imageList[this.currentIndex] && this.imageList[this.currentIndex].id);

        // If user went back previously, allow "next" to go forward again
        if (this.forwardStack.length > 0) {
            const nextId = this.forwardStack.pop();
            if (prevId) this.pushBack(prevId);
            if (nextId && this.setCurrentImageById(nextId)) {
                return this.getCurrentImage();
            }
            // If invalid, fall through to normal selection
        }

        if (this.settings.mode === 'random') {
            // True random
            this.currentIndex = Math.floor(Math.random() * this.imageList.length);
        } else if (this.settings.mode === 'smart') {
            // Weighted random
            this.currentIndex = this.selectSmartImage();
        } else {
            // Sequential
            this.currentIndex++;
            if (this.currentIndex >= this.imageList.length) {
                this.currentIndex = 0;
            }
        }

        const image = this.getCurrentImage();
        if (image && prevId && image.id !== prevId) {
            this.pushBack(prevId);
            // New branch: clear forward stack
            this.forwardStack = [];
        }

        return image;
    }

    getPreviousImage() {
        if (this.imageList.length === 0) {
            return null;
        }

        const currentId = this.currentImageId || (this.imageList[this.currentIndex] && this.imageList[this.currentIndex].id);

        // Prefer reliable back stack
        if (this.backStack.length > 0) {
            const previousId = this.backStack.pop();
            if (currentId) this.pushForward(currentId);
            if (previousId && this.setCurrentImageById(previousId)) {
                return this.getCurrentImage();
            }
        }

        // Fallback to simple previous
        if (this.settings.mode === 'sequential') {
            if (currentId) this.pushForward(currentId);
            this.currentIndex--;
            if (this.currentIndex < 0) {
                this.currentIndex = this.imageList.length - 1;
            }
        } else {
            // For random modes, just go to a random previous image
            this.currentIndex = Math.floor(Math.random() * this.imageList.length);
        }

        return this.getCurrentImage();
    }

    selectSmartImage() {
        // Cache weights for 5 seconds to avoid recalculating on every call
        const now = Date.now();
        const cacheValid = (now - this.smartWeightsTimestamp) < 5000;
        
        if (!this.smartWeights || !cacheValid) {
            // Smart selection: weight by favorites, recency, and "this day"
            const today = new Date();
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            const todayMonth = today.getMonth();
            const todayDate = today.getDate();
            
            this.smartWeights = this.imageList.map((img) => {
                let weight = 1;

                // Favorites get 3x weight
                if (img.is_favorite) {
                    weight *= 3;
                }

                // Recent photos (within last month) get 2x weight
                if (img.date_taken) {
                    const photoDate = new Date(img.date_taken);
                    
                    if (photoDate > oneMonthAgo) {
                        weight *= 2;
                    }
                    
                    // Photos from "this day in history" get 10x weight
                    if (photoDate.getMonth() === todayMonth && 
                        photoDate.getDate() === todayDate) {
                        weight *= 10;
                    }
                }

                return weight;
            });
            
            this.smartWeightsTimestamp = now;
        }

        // Calculate total weight
        const totalWeight = this.smartWeights.reduce((sum, w) => sum + w, 0);

        // Select random weighted index
        let random = Math.random() * totalWeight;
        
        for (let i = 0; i < this.smartWeights.length; i++) {
            random -= this.smartWeights[i];
            if (random <= 0) {
                return i;
            }
        }

        return 0;
    }

    /**
     * Delegates to the canonical db.formatImage so the DB layer is the
     * single source of truth for camelCase field shape. Kept on the
     * engine because many call sites (routes, tests) already hold an
     * engine reference rather than a db reference.
     */
    formatImage(image) {
        return this.db.formatImage(image);
    }

    getSettings() {
        return {
            mode: this.settings.mode,
            order: this.settings.order,
            interval: this.settings.interval,
            favoritesOnly: this.settings.favoritesOnly,
            totalImages: this.imageList.length
        };
    }

    /**
     * Validate a settings patch and return a normalized update object
     * (with parsed integers and coerced booleans). Throws
     * SettingsValidationError with a human-readable message on failure.
     *
     * Accepts the same shape as updateSettings — fields are optional.
     */
    static validateSettings(input) {
        const normalized = {};

        if (input.mode !== undefined) {
            if (!VALID_MODES.includes(input.mode)) {
                throw new SettingsValidationError(
                    `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}`
                );
            }
            normalized.mode = input.mode;
        }

        if (input.order !== undefined) {
            if (!VALID_ORDERS.includes(input.order)) {
                throw new SettingsValidationError(
                    `Invalid order. Must be one of: ${VALID_ORDERS.join(', ')}`
                );
            }
            normalized.order = input.order;
        }

        if (input.interval !== undefined) {
            const interval = parseInt(input.interval);
            if (isNaN(interval) || interval < 1) {
                throw new SettingsValidationError(
                    'Invalid interval. Must be a positive number'
                );
            }
            normalized.interval = interval;
        }

        if (input.favoritesOnly !== undefined) {
            normalized.favoritesOnly = input.favoritesOnly === true || input.favoritesOnly === 'true';
        }

        return normalized;
    }

    updateSettings(newSettings) {
        // Validation is part of the engine's contract so callers (routes,
        // future CLI, tests) all see the same rules.
        const updates = SlideshowEngine.validateSettings(newSettings);

        let needsRefresh = false;

        if (updates.mode !== undefined && updates.mode !== this.settings.mode) {
            this.settings.mode = updates.mode;
            this.db.setSetting('slideshow_mode', updates.mode);
            needsRefresh = true;
        }

        if (updates.order !== undefined && updates.order !== this.settings.order) {
            this.settings.order = updates.order;
            this.db.setSetting('slideshow_order', updates.order);
            needsRefresh = true;
        }

        if (updates.interval !== undefined) {
            this.settings.interval = updates.interval;
            this.db.setSetting('slideshow_interval', updates.interval);
        }

        if (updates.favoritesOnly !== undefined && updates.favoritesOnly !== this.settings.favoritesOnly) {
            this.settings.favoritesOnly = updates.favoritesOnly;
            this.db.setSetting('filter_favorites_only', updates.favoritesOnly ? '1' : '0');
            needsRefresh = true;
        }

        if (needsRefresh) {
            this.refreshImageList();
            // Clear smart mode cache when settings change
            this.smartWeights = null;
            this.smartWeightsTimestamp = 0;
            console.log('Slideshow settings updated and image list refreshed');
        }

        return this.getSettings();
    }

    getPreloadImages(count = null) {
        // Use configured preload count if not specified
        const preloadCount = count !== null ? count : this.preloadCount;
        // Get next N images for preloading
        const preload = [];

        for (let i = 1; i <= preloadCount; i++) {
            const nextIndex = (this.currentIndex + i) % this.imageList.length;
            if (nextIndex < this.imageList.length && this.imageList[nextIndex]) {
                preload.push(this.formatImage(this.imageList[nextIndex]));
            }
        }

        return preload;
    }

    // ---- Timer / playback control (moved from server.js) -------------

    /**
     * Broadcast the current image bundle (image + preload + settings + isPlaying).
     * Internal helper — used after advancing, on delete, on SSE open, etc.
     */
    broadcastCurrentImage(image) {
        if (!image) return;
        this.broadcast(imageMessage({
            image,
            preload: this.getPreloadImages(),
            settings: this.getSettings(),
            isPlaying: this.isPlaying
        }));
    }

    _clearTickTimer() {
        if (this.tickTimer) {
            clearTimeout(this.tickTimer);
            this.tickTimer = null;
        }
    }

    _scheduleNextTick() {
        if (!this.isPlaying) return;
        this._clearTickTimer();
        const myToken = ++this.tickToken;
        const intervalSec = this.settings.interval || 10;
        this.tickTimer = setTimeout(async () => {
            // Stale tick (interval changed, paused, manual nav)? No-op.
            if (myToken !== this.tickToken) return;
            await this.advance('next', 'timer');
            this._scheduleNextTick();
        }, intervalSec * 1000);
    }

    /**
     * Advance the slideshow (next/previous). Handles reentry guard,
     * broadcasts the resulting image, and reschedules the auto-advance
     * timer if we're playing and this advance came from a manual action.
     *
     * @param {'next'|'previous'} direction
     * @param {string} [source] - For logging only.
     * @returns {Promise<object|null>} Formatted current image, or null.
     */
    async advance(direction, source = 'unknown') {
        if (this.advanceInProgress) return null;
        this.advanceInProgress = true;
        try {
            let image = null;
            if (direction === 'next') image = this.getNextImage();
            else if (direction === 'previous') image = this.getPreviousImage();
            if (image) this.broadcastCurrentImage(image);

            // Manual navigation resets the auto-advance timer.
            if (this.isPlaying && source !== 'timer') {
                this._scheduleNextTick();
            }
            return image;
        } catch (error) {
            console.error(`Error advancing slideshow (${direction}, ${source}):`, error);
            return null;
        } finally {
            this.advanceInProgress = false;
        }
    }

    /**
     * Start the auto-advance timer and broadcast the new play state.
     * No-op if already playing.
     */
    play() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        this._scheduleNextTick();
        this.broadcast(slideshowStateMessage(true));
        console.log(`Server-side slideshow started (${this.settings.interval || 10}s interval)`);
    }

    /**
     * Stop the auto-advance timer and broadcast the new play state.
     */
    pause() {
        this._clearTickTimer();
        // Bump token so any in-flight tick callbacks become no-ops.
        this.tickToken++;
        this.isPlaying = false;
        this.broadcast(slideshowStateMessage(false));
        console.log('Server-side slideshow stopped');
    }

    /**
     * If the interval was changed while playing, reschedule immediately
     * so the new interval takes effect on the next tick (not after the
     * old one finishes).
     */
    updateIntervalIfPlaying() {
        if (this.isPlaying) this._scheduleNextTick();
    }

    /**
     * Stop the timer during shutdown. Does not broadcast (clients are
     * disconnecting anyway).
     */
    stopForShutdown() {
        this._clearTickTimer();
        this.tickToken++;
        this.isPlaying = false;
    }
}

module.exports = SlideshowEngine;
module.exports.SettingsValidationError = SettingsValidationError;
module.exports.VALID_MODES = VALID_MODES;
module.exports.VALID_ORDERS = VALID_ORDERS;


