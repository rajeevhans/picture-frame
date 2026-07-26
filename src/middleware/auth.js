const crypto = require('crypto');

/**
 * Loopback addresses that identify the physical frame talking to its own
 * server. IPv4, IPv6, and IPv4-mapped-IPv6 forms.
 */
function isLoopback(address) {
    if (!address) return false;
    return address === '127.0.0.1'
        || address === '::1'
        || address === '::ffff:127.0.0.1'
        || address.startsWith('127.');
}

/**
 * Parse a Cookie header into a plain object. Avoids adding cookie-parser as
 * a dependency (Express's res.cookie() is built in for the write side).
 */
function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) {
            try { out[k] = decodeURIComponent(v); }
            catch (_) { out[k] = v; }
        }
    }
    return out;
}

/**
 * Constant-time string comparison that tolerates differing lengths by
 * comparing SHA-256 digests (always equal length).
 */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/**
 * Extract a presented secret from the request: Authorization: Bearer,
 * X-Auth-Token header, or the auth cookie.
 */
function presentedSecret(req, cookieName) {
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const hdr = req.headers['x-auth-token'];
    if (hdr) return String(hdr);
    const cookies = parseCookies(req.headers['cookie']);
    if (cookies[cookieName]) return cookies[cookieName];
    return null;
}

/**
 * Build the auth middleware. The physical frame (loopback) is always allowed
 * when trustLoopback is set; every other client must present the shared
 * secret. Fails OPEN when disabled or no secret is configured.
 */
function createAuthMiddleware(config) {
    const auth = (config && config.auth) || {};
    const { enabled, secret, trustLoopback = true, cookieName = 'pf_auth' } = auth;

    return function authMiddleware(req, res, next) {
        // Disabled or misconfigured → fail open.
        if (!enabled || !secret) return next();

        // The login page/handler must always be reachable.
        if (req.path === '/login') return next();

        // The physical frame talking to its own server.
        const remote = req.socket && req.socket.remoteAddress;
        if (trustLoopback && isLoopback(remote)) return next();

        // Everyone else must present the secret.
        const provided = presentedSecret(req, cookieName);
        if (provided && safeEqual(provided, secret)) return next();

        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const nextParam = encodeURIComponent(req.originalUrl || req.url || '/');
        return res.redirect(302, `/login?next=${nextParam}`);
    };
}

module.exports = { createAuthMiddleware, isLoopback, parseCookies, safeEqual };
