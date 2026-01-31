/**
 * Terminal Monitor
 * Processes shell commands and outputs captured by the shell hook
 */

const fs = require("fs");
const path = require("path");
const { extractContext } = require("./extractor");
const episodic = require("../memory/episodic");
const working = require("../memory/working");
const gitmonitor = require("./gitmonitor");
const config = require("../config");

// Log file where shell hook writes events
const TERMINAL_LOG = path.join(__dirname, "../../storage/terminal.log");

/**
 * Log a terminal event (called by shell hook via CLI)
 * @param {Object} event - { command, output, cwd, exitCode, timestamp }
 */
async function logEvent(event) {
    const entry = {
        type: "terminal",
        command: event.command,
        output: event.output || "",
        cwd: event.cwd || process.cwd(),
        exitCode: event.exitCode || 0,
        timestamp: event.timestamp || new Date().toISOString(),
        project: detectProject(event.cwd),
    };

    // 1. Store raw event in episodic memory (short-term)
    await episodic.add(entry);

    // 2. Special handling for git commits - capture the diff
    if (isGitCommit(entry.command) && entry.exitCode === 0) {
        await gitmonitor.captureCommit(entry.cwd, extractCommitMessage(entry.command));
    }

    // 3. If error or significant, extract context and store
    if (shouldProcess(entry)) {
        await processEvent(entry);
    }

    return entry;
}

/**
 * Check if command is a git commit
 */
function isGitCommit(command) {
    return command.match(/^git\s+commit/);
}

/**
 * Extract commit message from git commit command
 */
function extractCommitMessage(command) {
    // Match -m "message" or -m 'message'
    const match = command.match(/-m\s+["']([^"']+)["']/);
    return match ? match[1] : null;
}

/**
 * Detect project name from directory
 * Returns null for non-project directories (like /tmp)
 */
function detectProject(cwd) {
    if (!cwd) return null;

    const { getProjectName, isRealProject } = require("../context");
    
    // Use the centralized project detection
    const projectName = getProjectName(cwd);
    
    // Only return a project name if it's a real project
    if (projectName) {
        return projectName;
    }
    
    // Check if it's a real project even without git
    if (isRealProject(cwd)) {
        return path.basename(cwd);
    }
    
    // Not a real project - return null
    return null;
}

/**
 * Determine if event needs deeper processing
 */
function shouldProcess(entry) {
    // Always process errors
    if (entry.exitCode !== 0) return true;

    // Process commands that indicate work
    const significantCommands = [
        "npm", "node", "git", "docker", "cargo", "python",
        "go", "make", "yarn", "pnpm", "brew", "curl", "wget"
    ];

    const cmd = entry.command.split(" ")[0];
    return significantCommands.includes(cmd);
}

/**
 * Process significant events - extract context and sync
 */
async function processEvent(entry) {
    try {
        // Extract semantic meaning using LLM
        const context = await extractContext(entry);

        if (context) {
            // Update working memory for this project
            await working.update(entry.project, {
                lastActivity: entry.timestamp,
                lastCommand: entry.command,
                context: context.summary,
                tags: context.tags,
            });

            // If it's an error or important insight, sync to Supermemory
            if (context.importance === "high") {
                const supermemory = require("../memory/supermemory");
                const apiKey = config.get("supermemory.apiKey");
                if (apiKey) {
                    await supermemory.store(
                        entry.project,
                        context.summary,
                        apiKey
                    );
                }
            }
        }
    } catch (error) {
        // Don't crash on processing errors
        if (config.get("debug")) {
            console.warn("Event processing failed:", error.message);
        }
    }
}

/**
 * Get recent terminal history for a project
 * @param {string} project
 * @param {number} limit
 */
async function getRecentHistory(project, limit = 10) {
    const events = await episodic.getRecent(project, limit);
    return events;
}

/**
 * Format terminal history for prompt injection
 */
function formatForPrompt(events) {
    if (!events || events.length === 0) return "";

    return events
        .map((e) => {
            const status = e.exitCode === 0 ? "✓" : "✗";
            return `[${status}] ${e.command}`;
        })
        .join("\n");
}

/**
 * Check if monitoring is enabled
 */
function isEnabled() {
    return config.get("monitor.enabled") !== false;
}

module.exports = {
    logEvent,
    detectProject,
    getRecentHistory,
    formatForPrompt,
    isEnabled,
};
