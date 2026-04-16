/**
 * Shared frontend utilities used by both the main display (js/app.js)
 * and the remote control (remote/remote.js).
 *
 * Loaded as a classic <script> (no modules) and exposes helpers on
 * window.PictureFrame so both pages can reuse them without bundling.
 */
(function () {
    'use strict';

    /**
     * Fetch wrapper that prefixes /api and throws detailed errors.
     * @param {string} endpoint - Path segment after /api (e.g. '/image/current').
     * @param {RequestInit} [options]
     * @returns {Promise<any>} Parsed JSON response.
     */
    async function apiCall(endpoint, options = {}) {
        const response = await fetch(`/api${endpoint}`, options);
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`API ${endpoint} failed: ${response.status} ${response.statusText} ${body}`);
        }
        return response.json();
    }

    /**
     * Build a cache-busting image URL. Use when an image's bytes may have
     * changed (e.g. after physical rotation) and the browser should refetch.
     * @param {number|string} imageId
     * @param {{nocache?: boolean, cacheBuster?: string|number}} [opts]
     */
    function imageServeUrl(imageId, opts = {}) {
        const { nocache = false, cacheBuster } = opts;
        if (!nocache && cacheBuster === undefined) {
            return `/api/image/${imageId}/serve`;
        }
        const t = cacheBuster !== undefined ? cacheBuster : (Date.now() + Math.random());
        return `/api/image/${imageId}/serve?t=${t}&nocache=1`;
    }

    /**
     * Generate a new cache-buster token. Extracted so callers don't
     * re-implement `Date.now() + Math.random()` inline.
     */
    function newCacheBuster() {
        return Date.now() + Math.random();
    }

    /**
     * Open an SSE connection with standard reconnect behavior.
     * Returns the EventSource so callers can close it.
     *
     * @param {string} url
     * @param {object} handlers
     * @param {(msg: object) => void} handlers.onMessage - Called with parsed JSON.
     * @param {(status: 'connecting'|'open'|'error') => void} [handlers.onStatusChange]
     */
    function connectSSE(url, handlers) {
        const { onMessage, onStatusChange } = handlers;
        if (onStatusChange) onStatusChange('connecting');

        const es = new EventSource(url);

        es.onopen = () => {
            if (onStatusChange) onStatusChange('open');
        };

        es.onmessage = (event) => {
            try {
                onMessage(JSON.parse(event.data));
            } catch (err) {
                console.error('Bad SSE message:', err);
            }
        };

        es.onerror = () => {
            if (onStatusChange) onStatusChange('error');
            // EventSource auto-reconnects; callers can decide if they want
            // to manually close() and reopen based on readyState.
        };

        return es;
    }

    window.PictureFrame = {
        apiCall,
        imageServeUrl,
        newCacheBuster,
        connectSSE
    };
})();
