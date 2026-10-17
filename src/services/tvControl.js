const http = require('http');
const dgram = require('dgram');
const WebSocket = require('ws');
const logger = require('../logger');

// DB settings keys (the token is earned at runtime via the TV's "Allow"
// prompt, so it lives in the settings table rather than in config).
const TOKEN_KEY = 'tv_token';
const MAC_KEY = 'tv_mac';

const ON_STATES = new Set(['on']);
const POLL_INTERVAL_MS = 1000;
// Opening the remote channel takes 0.6-1.6s on the Frame, so key presses
// reuse one connection and close it after this much idle time.
const REMOTE_IDLE_MS = 60000;

// Keys the remote-control UI may send (POST /api/tv/key). Samsung Tizen
// key codes; anything else is rejected rather than forwarded to the TV.
const TV_KEYS = new Set([
    'KEY_POWER', 'KEY_SOURCE', 'KEY_HDMI', 'KEY_HDMI1', 'KEY_HDMI2', 'KEY_HDMI3', 'KEY_HDMI4',
    'KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER',
    'KEY_RETURN', 'KEY_HOME', 'KEY_MENU', 'KEY_EXIT', 'KEY_INFO', 'KEY_TOOLS', 'KEY_GUIDE',
    'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE',
    'KEY_CHUP', 'KEY_CHDOWN', 'KEY_PRECH', 'KEY_CH_LIST',
    'KEY_REWIND', 'KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP', 'KEY_FF',
    'KEY_0', 'KEY_1', 'KEY_2', 'KEY_3', 'KEY_4', 'KEY_5', 'KEY_6', 'KEY_7', 'KEY_8', 'KEY_9'
]);

class TvControlError extends Error {
    constructor(message, status = 500) {
        super(message);
        this.name = 'TvControlError';
        this.status = status;
    }
}

/**
 * Turns a Samsung (Tizen) TV on/off over its local network remote API.
 *
 * Macs can't send HDMI-CEC to the TV (macOS reserves the CEC controller for
 * Apple's corercd daemon), so this drives the TV the way Samsung's phone
 * remote does:
 *   - status: GET http://<host>:8001/api/v2/  -> device.PowerState
 *   - keys:   WebSocket wss://<host>:8002/api/v2/channels/samsung.remote.control
 *             (first connection shows an "Allow" prompt on the TV; the token
 *             it returns is stored and sent on later connections)
 *   - wake:   Wake-on-LAN magic packet to the TV's MAC (needs "Power On with
 *             Mobile" enabled on the TV)
 *
 * Commands are serialized so overlapping requests can't interleave.
 */
class TvControlService {
    /**
     * @param {object} db - DatabaseManager (getSetting/setSetting)
     * @param {object} tvConfig - config.tv
     */
    constructor(db, tvConfig = {}) {
        this.db = db;
        this.config = {
            enabled: false,
            host: null,
            mac: null,
            clientName: 'PictureFrame',
            offMode: 'standby',
            commandTimeoutMs: 15000,
            pairTimeoutMs: 30000,
            ...tvConfig
        };
        this.queue = Promise.resolve();
        this.remote = null;      // { ws, ready: Promise<WebSocket> } while connected
        this.remoteIdleTimer = null;
    }

    isEnabled() {
        return !!(this.config.enabled && this.config.host);
    }

    isPaired() {
        return !!this.db.getSetting(TOKEN_KEY);
    }

    /**
     * Current power state. Never throws for an unreachable TV.
     * @returns {Promise<{reachable: boolean, powerState: string, paired: boolean, name?: string, model?: string}>}
     */
    async getStatus() {
        this._assertEnabled();
        const info = await this._fetchDeviceInfo();
        if (!info) {
            return { reachable: false, powerState: 'unreachable', paired: this.isPaired() };
        }
        return {
            reachable: true,
            powerState: info.PowerState || 'unknown',
            paired: this.isPaired(),
            name: info.name,
            model: info.modelName
        };
    }

    turnOn() {
        return this._serialize(() => this._turnOn());
    }

    turnOff() {
        return this._serialize(() => this._turnOff());
    }

    async toggle() {
        this._assertEnabled();
        const { powerState } = await this.getStatus();
        return ON_STATES.has(powerState) ? this.turnOff() : this.turnOn();
    }

    /**
     * Press one remote-control key (Click). Only keys in TV_KEYS are sent.
     * @param {string} key - e.g. 'KEY_VOLUP'
     */
    sendKey(key) {
        return this._serialize(async () => {
            this._assertEnabled();
            if (!TV_KEYS.has(key)) throw new TvControlError(`Unknown TV key: ${key}`, 400);
            this._assertPaired();
            await this._sendKey(key);
            return { key };
        });
    }

    /**
     * Connect without a token so the TV shows its "Allow" prompt, then store
     * the token it returns. The TV must be on for the prompt to be visible.
     */
    pair() {
        return this._serialize(async () => {
            this._assertEnabled();
            const { powerState } = await this.getStatus();
            if (!ON_STATES.has(powerState)) {
                throw new TvControlError('TV must be on to show the pairing prompt', 409);
            }
            const token = await this._withRemote({ useToken: false, timeoutMs: this.config.pairTimeoutMs }, async () => {});
            if (!token) {
                throw new TvControlError('TV accepted the connection but returned no token', 502);
            }
            return { paired: true };
        });
    }

    // ---- commands -------------------------------------------------------

    async _turnOn() {
        this._assertEnabled();
        const before = await this.getStatus();
        if (ON_STATES.has(before.powerState)) {
            return { changed: false, powerState: before.powerState };
        }

        // Wake-on-LAN first: the power key toggles, so only fall back to it
        // if the TV is reachable but still not on after the magic packet.
        const mac = this._getMac();
        if (mac) {
            await this._sendWakeOnLan(mac);
            logger.info('TV: sent Wake-on-LAN', { mac });
            const woke = await this._waitForState(state => ON_STATES.has(state), 8000);
            if (woke) return { changed: true, powerState: woke, method: 'wol' };
        }

        const now = await this.getStatus();
        if (ON_STATES.has(now.powerState)) {
            return { changed: true, powerState: now.powerState, method: 'wol' };
        }
        if (!now.reachable) {
            throw new TvControlError(mac
                ? 'TV did not wake (is "Power On with Mobile" enabled on the TV?)'
                : 'TV is unreachable and its MAC address is unknown for Wake-on-LAN', 504);
        }

        this._assertPaired();
        await this._sendKey('KEY_POWER');
        const state = await this._waitForState(s => ON_STATES.has(s), 10000);
        if (!state) throw new TvControlError('TV did not report on after the power key', 504);
        return { changed: true, powerState: state, method: 'key' };
    }

    async _turnOff() {
        this._assertEnabled();
        const before = await this.getStatus();
        if (!ON_STATES.has(before.powerState)) {
            return { changed: false, powerState: before.powerState };
        }
        this._assertPaired();

        if (this.config.offMode === 'art') {
            // The Frame's short press switches to Art Mode rather than off.
            await this._sendKey('KEY_POWER');
            return { changed: true, powerState: 'art', method: 'key' };
        }

        // A long press powers a Frame fully off regardless of Art Mode.
        await this._remoteSend(async (send) => {
            send('Press', 'KEY_POWER');
            await sleep(3500);
            send('Release', 'KEY_POWER');
        });
        const state = await this._waitForState(s => !ON_STATES.has(s), 10000);
        if (!state) throw new TvControlError('TV still reports on after the power key', 504);
        return { changed: true, powerState: state, method: 'key' };
    }

    // ---- transport ------------------------------------------------------

    _sendKey(key) {
        return this._remoteSend(async (send) => send('Click', key));
    }

    /**
     * Run `action(send)` on the shared, token-authenticated remote channel,
     * opening it if needed. A stale socket is replaced once.
     */
    async _remoteSend(action) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const ws = await this._openRemote();
            if (ws.readyState !== WebSocket.OPEN) {
                this._dropRemote(ws);
                continue;
            }
            const send = (cmd, key) => ws.send(JSON.stringify({
                method: 'ms.remote.control',
                params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
            }));
            await action(send);
            this._touchRemote(ws);
            return;
        }
        throw new TvControlError('TV connection dropped', 502);
    }

    _openRemote() {
        if (this.remote) return this.remote.ready;
        const name = Buffer.from(this.config.clientName).toString('base64');
        const token = this.db.getSetting(TOKEN_KEY);
        const url = `wss://${this.config.host}:8002/api/v2/channels/samsung.remote.control?name=${name}`
            + `&token=${encodeURIComponent(token)}`;
        const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
        const ready = new Promise((resolve, reject) => {
            let connected = false;
            const fail = (err) => {
                clearTimeout(timer);
                this._dropRemote(ws);
                if (!connected) reject(err);
            };
            const timer = setTimeout(() => fail(new TvControlError(
                'Timed out waiting for the TV (pairing may have been revoked; POST /api/tv/pair)', 504)),
            this.config.commandTimeoutMs);

            ws.on('message', (raw) => {
                let msg;
                try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
                const refusal = remoteRefusal(msg.event);
                if (refusal) return fail(refusal);
                if (msg.event === 'ms.channel.connect' && !connected) {
                    connected = true;
                    clearTimeout(timer);
                    const newToken = msg.data && msg.data.token;
                    if (newToken && newToken !== token) this.db.setSetting(TOKEN_KEY, newToken);
                    resolve(ws);
                }
            });
            ws.on('error', (err) => fail(new TvControlError(`TV connection failed: ${err.message}`, 502)));
            ws.on('close', () => fail(new TvControlError('TV closed the connection', 502)));
        });
        ready.catch(() => {}); // rejection is surfaced to the awaiting caller
        this.remote = { ws, ready };
        return ready;
    }

    _touchRemote(ws) {
        clearTimeout(this.remoteIdleTimer);
        this.remoteIdleTimer = setTimeout(() => this._dropRemote(ws), REMOTE_IDLE_MS);
    }

    _dropRemote(ws) {
        if (this.remote && this.remote.ws === ws) {
            this.remote = null;
            clearTimeout(this.remoteIdleTimer);
        }
        try { ws.close(); } catch (_) { /* already closed */ }
    }

    /**
     * One-shot remote channel for pairing: connect (without a token when
     * pairing), wait for ms.channel.connect, run `action(send)`, then close.
     * Resolves with the token the TV returned (stored when it changes).
     */
    _withRemote({ useToken, timeoutMs = this.config.commandTimeoutMs }, action) {
        const name = Buffer.from(this.config.clientName).toString('base64');
        const token = useToken ? this.db.getSetting(TOKEN_KEY) : null;
        const url = `wss://${this.config.host}:8002/api/v2/channels/samsung.remote.control?name=${name}`
            + (token ? `&token=${encodeURIComponent(token)}` : '');

        return new Promise((resolve, reject) => {
            // The TV serves a self-signed certificate on 8002.
            const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
            let settled = false;
            const finish = (err, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ws.close(); } catch (_) { /* already closed */ }
                err ? reject(err) : resolve(value);
            };
            const timer = setTimeout(() => finish(new TvControlError(useToken
                ? 'Timed out waiting for the TV (pairing may have been revoked; POST /api/tv/pair)'
                : 'Timed out waiting for the "Allow" prompt to be accepted on the TV', 504)), timeoutMs);

            const send = (cmd, key) => ws.send(JSON.stringify({
                method: 'ms.remote.control',
                params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
            }));

            ws.on('message', async (raw) => {
                let msg;
                try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
                const refusal = remoteRefusal(msg.event);
                if (refusal) {
                    finish(refusal);
                } else if (msg.event === 'ms.channel.connect') {
                    const newToken = msg.data && msg.data.token;
                    if (newToken && newToken !== token) {
                        this.db.setSetting(TOKEN_KEY, newToken);
                        logger.info('TV: stored pairing token');
                    }
                    try {
                        await action(send);
                        finish(null, newToken || token);
                    } catch (err) {
                        finish(err);
                    }
                }
            });
            ws.on('error', (err) => finish(new TvControlError(`TV connection failed: ${err.message}`, 502)));
            ws.on('close', () => finish(new TvControlError('TV closed the connection', 502)));
        });
    }

    _fetchDeviceInfo() {
        return new Promise((resolve) => {
            // agent:false = a fresh connection per request. The TV closes its
            // end after each response, so a reused keep-alive socket fails
            // instantly with ECONNRESET on back-to-back requests.
            const req = http.get({ host: this.config.host, port: 8001, path: '/api/v2/', timeout: 2500, agent: false }, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    try {
                        const device = JSON.parse(body).device || {};
                        // Remember the MAC so Wake-on-LAN works once the TV
                        // is fully off and this endpoint is unreachable.
                        if (device.wifiMac && device.wifiMac !== this.db.getSetting(MAC_KEY)) {
                            this.db.setSetting(MAC_KEY, device.wifiMac);
                        }
                        resolve(device);
                    } catch (_) {
                        resolve(null);
                    }
                });
            });
            req.on('timeout', () => req.destroy(new Error('timed out')));
            req.on('error', (err) => {
                logger.debug('TV status request failed', { host: this.config.host, code: err.code, error: err.message });
                resolve(null);
            });
        });
    }

    _sendWakeOnLan(mac) {
        const bytes = mac.split(/[:-]/).map(h => parseInt(h, 16));
        const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(bytes))]);
        // Unicast to the TV plus its /24 directed broadcast (the TV may be
        // on a different subnet from the frame).
        const broadcast = this.config.host.replace(/\.\d+$/, '.255');
        const socket = dgram.createSocket('udp4');
        return new Promise((resolve) => {
            socket.bind(() => {
                socket.setBroadcast(true);
                const sends = [this.config.host, broadcast].map(host =>
                    new Promise(done => socket.send(packet, 9, host, () => done())));
                Promise.all(sends).then(() => { socket.close(); resolve(); });
            });
        });
    }

    async _waitForState(predicate, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const info = await this._fetchDeviceInfo();
            const state = info ? (info.PowerState || 'unknown') : 'unreachable';
            if (predicate(state)) return state;
            await sleep(POLL_INTERVAL_MS);
        }
        return null;
    }

    // ---- helpers --------------------------------------------------------

    _getMac() {
        return this.config.mac || this.db.getSetting(MAC_KEY) || null;
    }

    _assertEnabled() {
        if (!this.isEnabled()) {
            throw new TvControlError('TV control is disabled (set tv.enabled and tv.host in config)', 503);
        }
    }

    _assertPaired() {
        if (!this.isPaired()) {
            throw new TvControlError('Not paired with the TV yet; turn the TV on and POST /api/tv/pair', 409);
        }
    }

    _serialize(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => {});
        return run;
    }
}

/** Map the TV's refusal events to errors (null for any other event). */
function remoteRefusal(event) {
    if (event === 'ms.channel.unauthorized') {
        return new TvControlError('TV rejected the connection; accept the prompt on the TV (POST /api/tv/pair)', 403);
    }
    if (event === 'ms.channel.timeOut') {
        // Sent immediately when the TV won't accept this client at all: the
        // frame is on a different subnet from the TV (even with a valid
        // token), IP Remote or Device Connection Manager notifications are
        // off, or Art Mode is on screen.
        return new TvControlError('TV refused remote connections (the frame must be on the same subnet '
            + 'as the TV; enable IP Remote and Device Connection Manager access notifications; leave Art Mode)', 403);
    }
    return null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = TvControlService;
module.exports.TvControlError = TvControlError;
module.exports.TV_KEYS = TV_KEYS;
