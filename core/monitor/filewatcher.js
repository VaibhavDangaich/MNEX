/**
 * File System Watcher
 * Monitors file changes across ANY editor
 * Uses chokidar for efficient cross-platform watching
 */

const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");
const episodic = require("../memory/episodic");
const working = require("../memory/working");
const config = require("../config");

let watcher = null;
let isRunning = false;

// Patterns to ignore
const IGNORE_PATTERNS = [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/*.log",
    "**/.DS_Store",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
];

// File extensions to track
const TRACKED_EXTENSIONS = [
    ".js", ".ts", ".jsx", ".tsx",
    ".py", ".rb", ".go", ".rs",
    ".java", ".c", ".cpp", ".h",
    ".html", ".css", ".scss", ".sass",
    ".json", ".yaml", ".yml", ".toml",
    ".md", ".txt",
    ".sh", ".bash", ".zsh",
    ".sql", ".graphql",
    ".vue", ".svelte",
];

/**
 * Detect project name from path
 */
function detectProject(filePath) {
    // Walk up to find .git or package.json
    let dir = path.dirname(filePath);
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, ".git")) ||
            fs.existsSync(path.join(dir, "package.json"))) {
            return path.basename(dir);
        }
        dir = path.dirname(dir);
    }
    return path.basename(path.dirname(filePath));
}

/**
 * Check if file should be tracked
 */
function shouldTrack(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return TRACKED_EXTENSIONS.includes(ext);
}

/**
 * Log a file event
 */
async function logFileEvent(action, filePath) {
    if (!shouldTrack(filePath)) return;

    const project = detectProject(filePath);
    const relativePath = path.basename(filePath);
    const ext = path.extname(filePath);

    const event = {
        type: "editor",
        action,
        file: relativePath,
        fullPath: filePath,
        extension: ext,
        project,
        timestamp: new Date().toISOString(),
    };

    await episodic.add(event);

    // Update working memory with recent file
    await working.update(project, {
        lastFile: relativePath,
        lastFileAction: action,
    });

    // Sync important file edits to cloud
    syncToCloud(project, action, event).catch(() => {});

    if (config.get("debug")) {
        console.log(`[watch] ${action}: ${relativePath}`);
    }
}

/**
 * Sync important file edits to Supermemory
 */
async function syncToCloud(project, action, event) {
    const cloudsync = require("../memory/cloudsync");
    return cloudsync.syncActivity(project, "file_edit", {
        file: event.file,
        action: action,
        fullPath: event.fullPath,
    });
}

/**
 * Start watching a directory
 * @param {string} watchPath - Directory to watch
 * @param {Object} options - Watch options
 */
function start(watchPath, options = {}) {
    if (isRunning) {
        console.log("Watcher already running");
        return;
    }

    const resolvedPath = path.resolve(watchPath);

    if (!fs.existsSync(resolvedPath)) {
        console.error(`Path does not exist: ${resolvedPath}`);
        return;
    }

    console.log(`🔍 Watching: ${resolvedPath}`);

    watcher = chokidar.watch(resolvedPath, {
        ignored: IGNORE_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 300,
            pollInterval: 100,
        },
        ...options,
    });

    // File events
    watcher
        .on("add", (filePath) => logFileEvent("create", filePath))
        .on("change", (filePath) => logFileEvent("save", filePath))
        .on("unlink", (filePath) => logFileEvent("delete", filePath))
        .on("error", (error) => console.error("Watcher error:", error));

    isRunning = true;

    return watcher;
}

/**
 * Stop watching
 */
async function stop() {
    if (watcher) {
        await watcher.close();
        watcher = null;
        isRunning = false;
        console.log("🛑 Watcher stopped");
    }
}

/**
 * Check if watcher is running
 */
function isWatching() {
    return isRunning;
}

/**
 * Get watched paths
 */
function getWatched() {
    if (!watcher) return {};
    return watcher.getWatched();
}

module.exports = {
    start,
    stop,
    isWatching,
    getWatched,
    detectProject,
};
