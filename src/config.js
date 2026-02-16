/**
 * Load configuration: first checks ~/picframe-config.json,
 * falls back to project config.json if user config is missing.
 * User config is merged over defaults so partial overrides work.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function loadConfig() {
    const userConfigPath = path.join(os.homedir(), 'picframe-config.json');
    const defaultConfigPath = path.join(__dirname, '../config.json');

    const defaultContent = fs.readFileSync(defaultConfigPath, 'utf8');
    const defaults = JSON.parse(defaultContent);

    if (fs.existsSync(userConfigPath)) {
        console.log(`Using config: ${userConfigPath}`);
        const userContent = fs.readFileSync(userConfigPath, 'utf8');
        const userConfig = JSON.parse(userContent);
        return deepMerge(defaults, userConfig);
    }

    return defaults;
}

function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] != null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(result[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

module.exports = { loadConfig };
