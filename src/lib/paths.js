/**
 * Centralized path resolution.
 *
 * Before this module, path math was scattered across callers — some relative
 * to __dirname, some to cwd, some absolute. That's fragile when files move.
 * Prefer these helpers so the project root is the single source of truth.
 */
const path = require('path');

// This file lives at <project-root>/src/lib/paths.js
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DELETED_DIR = path.join(DATA_DIR, 'deleted');

/**
 * Resolve the database path from config. Relative paths in config are
 * interpreted relative to the project root (matching historical behavior
 * in server.js: `path.resolve(__dirname, '..', config.databasePath)`).
 */
function resolveDbPath(config) {
    const dbPath = config.databasePath || './data/pictureframe.db';
    return path.isAbsolute(dbPath) ? dbPath : path.resolve(PROJECT_ROOT, dbPath);
}

/**
 * Resolve the photo directory from config. Absolute paths pass through;
 * relative paths are resolved against the project root.
 */
function resolvePhotoDir(config) {
    const photoDir = config.photoDirectory || '';
    return path.isAbsolute(photoDir) ? photoDir : path.resolve(PROJECT_ROOT, photoDir);
}

module.exports = {
    PROJECT_ROOT,
    DATA_DIR,
    DELETED_DIR,
    resolveDbPath,
    resolvePhotoDir
};
