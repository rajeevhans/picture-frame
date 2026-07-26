const express = require('express');
const { safeEqual } = require('../middleware/auth');

/**
 * Login routes for the shared-secret scheme. GET /login renders a minimal
 * self-contained form (no external assets, so it works even while the rest
 * of the site is gated). POST /login validates the secret, sets an HttpOnly
 * cookie, and redirects. A small in-memory limiter throttles brute force.
 */
function createLoginRoutes(config) {
    const router = express.Router();
    const auth = (config && config.auth) || {};
    const cookieName = auth.cookieName || 'pf_auth';
    const secret = auth.secret;

    // ip -> { count, first } within a rolling window
    const attempts = new Map();
    const MAX_ATTEMPTS = 10;
    const WINDOW_MS = 5 * 60 * 1000;

    function tooManyAttempts(ip) {
        const now = Date.now();
        const rec = attempts.get(ip);
        if (!rec || now - rec.first > WINDOW_MS) return false;
        return rec.count >= MAX_ATTEMPTS;
    }

    function recordFailure(ip) {
        const now = Date.now();
        const rec = attempts.get(ip);
        if (!rec || now - rec.first > WINDOW_MS) {
            attempts.set(ip, { count: 1, first: now });
        } else {
            rec.count++;
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function loginPage(nextUrl, error) {
        const safeNext = String(nextUrl || '/').replace(/"/g, '&quot;');
        const errHtml = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
        return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Picture Frame — Sign in</title>
<style>
  body{font-family:system-ui,sans-serif;background:#1a1a1a;color:#eee;display:flex;
    min-height:100vh;align-items:center;justify-content:center;margin:0}
  form{background:#262626;padding:2rem;border-radius:12px;width:min(90vw,320px)}
  h1{font-size:1.1rem;margin:0 0 1rem}
  input{width:100%;box-sizing:border-box;padding:.7rem;margin:.3rem 0 1rem;
    border-radius:8px;border:1px solid #444;background:#1a1a1a;color:#eee;font-size:1rem}
  button{width:100%;padding:.7rem;border:0;border-radius:8px;background:#4a7dff;
    color:#fff;font-size:1rem;cursor:pointer}
  .err{color:#ff7676;font-size:.9rem;margin:.2rem 0 .6rem}
</style></head><body>
<form method="POST" action="/login">
  <h1>Picture Frame</h1>
  ${errHtml}
  <input type="password" name="secret" placeholder="Access code" autofocus autocomplete="current-password">
  <input type="hidden" name="next" value="${safeNext}">
  <button type="submit">Sign in</button>
</form></body></html>`;
    }

    router.get('/login', (req, res) => {
        res.set('Content-Type', 'text/html').send(loginPage(req.query.next, null));
    });

    router.post('/login', (req, res) => {
        const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
        const nextUrl = (req.body && req.body.next) || '/';

        if (tooManyAttempts(ip)) {
            return res.status(429).set('Content-Type', 'text/html')
                .send(loginPage(nextUrl, 'Too many attempts. Wait a few minutes.'));
        }

        const provided = (req.body && req.body.secret) || '';
        if (secret && safeEqual(provided, secret)) {
            res.cookie(cookieName, secret, {
                httpOnly: true,
                sameSite: 'lax',
                maxAge: 365 * 24 * 60 * 60 * 1000 // 1 year
            });
            // Only allow same-site relative redirects. Reject protocol-relative
            // ("//evil.com") and backslash ("/\evil.com") forms, both of which
            // browsers will treat as off-site even though they start with "/".
            const dest = (nextUrl.startsWith('/') && !nextUrl.startsWith('//') && !nextUrl.startsWith('/\\')) ? nextUrl : '/';
            return res.redirect(302, dest);
        }

        recordFailure(ip);
        return res.status(401).set('Content-Type', 'text/html')
            .send(loginPage(nextUrl, 'Incorrect access code.'));
    });

    return router;
}

module.exports = createLoginRoutes;
