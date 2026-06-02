/**
 * File System Watcher
 * Monitors file changes across ANY editor
 * Uses chokidar for efficient cross-platform watching
 */

const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");
const os = require("os");
const episodic = require("../memory/episodic");
const working = require("../memory/working");
const config = require("../config");

let watcher = null;
let isRunning = false;
let currentFocus = null; // Track the currently focused file/project

const HOME = os.homedir();
const FOCUS_FILE = path.join(HOME, ".config", "ai-agent", "focus.json");

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
    "**/venv/**",
    "**/.venv/**",
    "**/env/**",
    "**/__pycache__/**",
    "**/.cache/**",
    "**/Library/**",
    "**/Applications/**",
    "**/.Trash/**",
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

    // Auto-update focus when a file is edited
    if (action === "save") {
        setFocus(filePath, project);
    }

    // Check if this file is in the focused project (for notifications)
    const isFocused = isInFocusedProject(filePath);

    const event = {
        type: "editor",
        action,
        file: relativePath,
        fullPath: filePath,
        extension: ext,
        project,
        isFocused,
        timestamp: new Date().toISOString(),
    };

    await episodic.add(event);

    // Mirror to causal graph (best-effort, non-blocking)
    try {
        const causal = require("../memory/causal");
        causal.recordEdit({ project, file: relativePath, action });
    } catch (e) { /* ignore */ }

    // Update working memory with recent file
    await working.update(project, {
        lastFile: relativePath,
        lastFileAction: action,
    });

    // Sync important file edits to cloud
    syncToCloud(project, action, event).catch(() => {});

    if (config.get("debug")) {
        console.log(`[watch] ${action}: ${relativePath}${isFocused ? " (focused)" : ""}`);
    }

    // Call external change handler if set
    if (module.exports.onFileChange) {
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            await module.exports.onFileChange(filePath, content, action, { isFocused, project });
        } catch (e) {
            // Ignore read errors
        }
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

    // Smart options for watching large directories
    const watchOptions = {
        ignored: IGNORE_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 300,
            pollInterval: 100,
        },
        // Limit depth to prevent EMFILE errors on large directories
        depth: options.depth !== undefined ? options.depth : 10,
        // Use polling for very large directories (slower but safer)
        usePolling: options.usePolling || false,
        interval: 1000,
        // Ignore permission errors
        ignorePermissionErrors: true,
        ...options,
    };

    watcher = chokidar.watch(resolvedPath, watchOptions);

    // File events
    watcher
        .on("add", (filePath) => logFileEvent("create", filePath))
        .on("change", (filePath) => logFileEvent("save", filePath))
        .on("unlink", (filePath) => logFileEvent("delete", filePath))
        .on("error", (error) => {
            // Handle EMFILE gracefully
            if (error.code === "EMFILE") {
                console.error("Too many files being watched. Switching to polling mode...");
                // Restart with polling
                stop().then(() => {
                    setTimeout(() => {
                        start(watchPath, { ...options, usePolling: true, depth: 5 });
                    }, 1000);
                });
            } else {
                console.error("Watcher error:", error);
            }
        });

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

/**
 * Set the currently focused file/project
 * This is called when user opens a file or terminal changes directory
 */
function setFocus(filePath, project = null) {
    currentFocus = {
        file: filePath,
        project: project || detectProject(filePath),
        timestamp: new Date().toISOString(),
    };

    // Persist focus to file for cross-process access
    try {
        const dir = path.dirname(FOCUS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(FOCUS_FILE, JSON.stringify(currentFocus, null, 2));
    } catch (e) {
        // Ignore write errors
    }

    return currentFocus;
}

/**
 * Get the currently focused file/project
 */
function getFocus() {
    // Try to read from file first (for cross-process)
    try {
        if (fs.existsSync(FOCUS_FILE)) {
            const data = JSON.parse(fs.readFileSync(FOCUS_FILE, "utf-8"));
            // Check if focus is recent (within 1 hour)
            const focusTime = new Date(data.timestamp).getTime();
            if (Date.now() - focusTime < 3600000) {
                return data;
            }
        }
    } catch (e) {
        // Ignore read errors
    }
    return currentFocus;
}

/**
 * Check if a file is in the currently focused project
 */
function isInFocusedProject(filePath) {
    const focus = getFocus();
    if (!focus || !focus.project) return true; // If no focus, consider everything focused
    
    const fileProject = detectProject(filePath);
    return fileProject === focus.project;
}

module.exports = {
    start,
    stop,
    isWatching,
    getWatched,
    detectProject,
    setFocus,
    getFocus,
    isInFocusedProject,
};
