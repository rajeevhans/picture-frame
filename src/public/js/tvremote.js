/* TV remote control tab. Talks to /api/tv/* (see src/routes/tv.js). */
(function () {
    const STATUS_POLL_MS = 5000;
    const REPEAT_DELAY_MS = 400;     // hold this long before a key starts repeating
    const REPEAT_INTERVAL_MS = 180;

    let initialized = false;
    let pollTimer = null;
    let lastStatus = null;

    function el(id) { return document.getElementById(id); }

    async function api(path, opts) {
        const res = await fetch('/api/tv' + path, opts);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
        return body;
    }

    function post(path, data) {
        return api(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: data ? JSON.stringify(data) : undefined
        });
    }

    function notify(message) {
        if (typeof showToast === 'function') showToast(message);
    }

    // ---- status ---------------------------------------------------------

    async function refreshStatus() {
        try {
            renderStatus(await api('/status'));
        } catch (e) {
            renderStatus({ error: e.message });
        }
    }

    function renderStatus(s) {
        lastStatus = s;
        const dot = el('tvStatusDot');
        const title = el('tvStatusTitle');
        const sub = el('tvStatusSub');
        const pairBtn = el('tvPairBtn');
        const remote = el('tvRemote');

        let state = 'off';
        if (s.error) {
            title.textContent = 'TV control unavailable';
            sub.textContent = s.error;
            state = 'error';
        } else if (!s.reachable) {
            title.textContent = 'TV unreachable';
            sub.textContent = 'Check that the TV is on the network.';
            state = 'error';
        } else {
            const on = s.powerState === 'on';
            title.textContent = on ? 'TV is on' : 'TV is in ' + s.powerState;
            sub.textContent = [s.name, s.model].filter(Boolean).join(' · ')
                + (s.paired ? '' : ' · not paired');
            state = on ? 'on' : 'standby';
        }
        dot.dataset.state = state;
        pairBtn.classList.toggle('hidden', !!(s.error || s.paired || !s.reachable));

        // Keys only reach a paired TV that's on; "On" also works from standby.
        const canKey = !s.error && s.paired && s.powerState === 'on';
        const canWake = !s.error && s.paired && s.reachable;
        remote.querySelectorAll('[data-tv-key], [data-tv-action="off"]').forEach(b => { b.disabled = !canKey; });
        remote.querySelectorAll('[data-tv-action="on"]').forEach(b => { b.disabled = !canWake; });
        remote.classList.toggle('tv-remote-disabled', !canKey);
    }

    // ---- actions --------------------------------------------------------

    async function sendKey(key) {
        try {
            await post('/key', { key });
        } catch (e) {
            stopRepeat();
            notify('TV: ' + e.message);
            refreshStatus();
        }
    }

    async function power(action, btn) {
        btn.classList.add('busy');
        notify(action === 'on' ? 'Turning TV on…' : 'Turning TV off…');
        try {
            const r = await post('/' + action);
            notify(r.changed ? `TV ${action === 'on' ? 'on' : 'off'}` : `TV already ${r.powerState}`);
        } catch (e) {
            notify('TV: ' + e.message);
        } finally {
            btn.classList.remove('busy');
            refreshStatus();
        }
    }

    async function pair() {
        notify('Accept "Allow" on the TV within 30 seconds');
        try {
            await post('/pair');
            notify('Paired with the TV');
        } catch (e) {
            notify('Pairing failed: ' + e.message);
        }
        refreshStatus();
    }

    // ---- press-and-hold repeat -----------------------------------------

    let repeatTimer = null;

    function stopRepeat() {
        clearTimeout(repeatTimer);
        clearInterval(repeatTimer);
        repeatTimer = null;
    }

    function onPointerDown(e) {
        const btn = e.target.closest('[data-tv-key]');
        if (!btn || btn.disabled) return;
        e.preventDefault();
        const key = btn.dataset.tvKey;
        sendKey(key);
        if (btn.hasAttribute('data-repeat')) {
            stopRepeat();
            repeatTimer = setTimeout(() => {
                repeatTimer = setInterval(() => sendKey(key), REPEAT_INTERVAL_MS);
            }, REPEAT_DELAY_MS);
        }
    }

    // ---- lifecycle ------------------------------------------------------

    function init() {
        if (initialized) return;
        initialized = true;
        const remote = el('tvRemote');
        remote.addEventListener('pointerdown', onPointerDown);
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => remote.addEventListener(t, stopRepeat));
        remote.querySelectorAll('[data-tv-action]').forEach(btn => {
            btn.addEventListener('click', () => power(btn.dataset.tvAction, btn));
        });
        el('tvPairBtn').addEventListener('click', pair);
    }

    /** Called when the TV Remote tab is shown. */
    function show() {
        init();
        refreshStatus();
        clearInterval(pollTimer);
        pollTimer = setInterval(refreshStatus, STATUS_POLL_MS);
    }

    /** Called when the tab is hidden or settings close. */
    function hide() {
        clearInterval(pollTimer);
        pollTimer = null;
        stopRepeat();
    }

    window.PictureFrameTvRemote = { show, hide, getStatus: () => lastStatus };
})();
