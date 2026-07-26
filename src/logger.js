/**
 * Debug logger - writes to data/debug.log when debug is enabled in config.
 */
const fs = require('fs');
const path = require('path');

let logStream = null;
let enabled = false;

function formatTimestamp() {
    return new Date().toISOString();
}

function write(level, ...args) {
    if (!enabled || !logStream) return;
    try {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        const line = `[${formatTimestamp()}] [${level}] ${message}\n`;
        logStream.write(line);
    } catch (err) {
        console.error('Logger write error:', err.message);
    }
}

/**
 * Initialize the logger with config. Call once at startup from server.js.
 * @param {object} config - App config (must include databasePath and debug.enabled)
 */
function init(config) {
    if (logStream) {
        logStream.end();
        logStream = null;
    }

    enabled = config?.debug?.enabled === true;

    if (!enabled) return;

    try {
        const dbPath = path.resolve(__dirname, '..', config.databasePath || './data/pictureframe.db');
        const dataDir = path.dirname(dbPath);

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        const logPath = path.join(dataDir, 'debug.log');
        logStream = fs.createWriteStream(logPath, { flags: 'a' });

        debug('Debug logging enabled', { logPath });
    } catch (err) {
        console.error('Failed to initialize debug logger:', err.message);
        enabled = false;
    }
}

/**
 * Write a debug message to the log file (only when debug is enabled).
 */
function debug(...args) {
    write('DEBUG', ...args);
}

/**
 * Write an info message to the log file (only when debug is enabled).
 */
function info(...args) {
    write('INFO', ...args);
}

/**
 * Write a warn message to the log file (only when debug is enabled).
 */
function warn(...args) {
    write('WARN', ...args);
}

/**
 * Write an error message to the log file (only when debug is enabled).
 */
function error(...args) {
    write('ERROR', ...args);
}

/**
 * Close the log stream. Call on shutdown.
 */
function close() {
    if (logStream) {
        logStream.end();
        logStream = null;
    }
    enabled = false;
}

module.exports = {
    init,
    debug,
    info,
    warn,
    error,
    close,
    get enabled() {
        return enabled;
    }
};
