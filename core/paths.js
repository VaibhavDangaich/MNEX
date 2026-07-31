/**
 * Canonical filesystem paths — single source of truth.
 *
 * Before this module, config locations were duplicated as string literals across
 * bin/ai.js, core/service/manager.js, scripts/postinstall.js and several agent
 * modules. The 1.5.0 rename (ai-agent -> mnex) only updated some of them, which
 * split the install in half: `mnex init` wrote the API key to ~/.config/mnex/.env
 * while the launchd daemon read ~/.config/ai-agent/.env and found nothing.
 *
 * Everything that needs a path imports it from here. Legacy locations are still
 * read (and migrated on demand) so existing installs keep their state.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();

// --- Canonical (current) locations ------------------------------------------
const CONFIG_DIR = path.join(HOME, ".config", "mnex");
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const HOME_ENV_FILE = path.join(HOME, ".mnex.env");
const DATA_DIR = path.join(HOME, ".mnex");
const PLUGIN_DIR = path.join(DATA_DIR, "plugins");

const PLIST_LABEL = "com.mnex.watcher";
const PLIST_NAME = `${PLIST_LABEL}.plist`;

// --- Legacy locations (pre-rename), read-only ------------------------------
const LEGACY_CONFIG_DIR = path.join(HOME, ".config", "ai-agent");
const LEGACY_ENV_FILE = path.join(LEGACY_CONFIG_DIR, ".env");
const LEGACY_HOME_ENV_FILE = path.join(HOME, ".ai-agent.env");
const LEGACY_DATA_DIR = path.join(HOME, ".ai-agent");
const LEGACY_PLUGIN_DIR = path.join(LEGACY_DATA_DIR, "plugins");
const LEGACY_PLIST_LABEL = "com.ai-agent.watcher";
const LEGACY_PLIST_NAME = `${LEGACY_PLIST_LABEL}.plist`;

/**
 * Env files in priority order. The canonical locations win, but legacy paths
 * remain readable so a user who upgrades without re-running `mnex init` keeps
 * working.
 */
function envCandidates(cwd = process.cwd()) {
    return [
        path.join(cwd, ".env"),
        HOME_ENV_FILE,
        ENV_FILE,
        LEGACY_HOME_ENV_FILE,
        LEGACY_ENV_FILE,
    ];
}

/** First existing env file, or null. */
function findEnvFile(cwd = process.cwd()) {
    return envCandidates(cwd).find((p) => fs.existsSync(p)) || null;
}

/** True when the resolved env file is a pre-rename location. */
function isLegacyEnvFile(p) {
    return p === LEGACY_ENV_FILE || p === LEGACY_HOME_ENV_FILE;
}

/**
 * Plugin directories, canonical first. Legacy is still scanned so existing
 * plugins keep loading after upgrade.
 */
function pluginDirs(cwd = process.cwd()) {
    return [PLUGIN_DIR, LEGACY_PLUGIN_DIR, path.join(cwd, "plugins")];
}

/**
 * Resolve a file that lives in the config dir (focus.json, reminders.json, ...).
 * Returns the canonical path, but if only a legacy copy exists it is moved into
 * place first so there is exactly one live copy afterwards.
 */
function configFile(name) {
    const target = path.join(CONFIG_DIR, name);
    if (fs.existsSync(target)) return target;

    const legacy = path.join(LEGACY_CONFIG_DIR, name);
    if (fs.existsSync(legacy)) {
        try {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
            fs.copyFileSync(legacy, target);
            fs.rmSync(legacy, { force: true });
            return target;
        } catch {
            // Migration is best-effort; fall back to reading the legacy copy.
            return legacy;
        }
    }
    return target;
}

/** Create the canonical config dir if absent. */
function ensureConfigDir() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    return CONFIG_DIR;
}

/** Create the canonical plugin dir if absent. */
function ensurePluginDir() {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    return PLUGIN_DIR;
}

module.exports = {
    HOME,
    CONFIG_DIR,
    ENV_FILE,
    HOME_ENV_FILE,
    DATA_DIR,
    PLUGIN_DIR,
    PLIST_LABEL,
    PLIST_NAME,
    LEGACY_CONFIG_DIR,
    LEGACY_ENV_FILE,
    LEGACY_HOME_ENV_FILE,
    LEGACY_DATA_DIR,
    LEGACY_PLUGIN_DIR,
    LEGACY_PLIST_LABEL,
    LEGACY_PLIST_NAME,
    envCandidates,
    findEnvFile,
    isLegacyEnvFile,
    pluginDirs,
    configFile,
    ensureConfigDir,
    ensurePluginDir,
};
