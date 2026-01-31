/**
 * Episodic Memory
 * Short-term memory for recent activity (last 1-3 hours)
 * Highly volatile, frequently updated
 */

const fs = require("fs");
const path = require("path");

const EPISODIC_FILE = path.join(__dirname, "../../storage/episodic.json");
const MAX_EVENTS = 100; // Max events to keep
const MAX_AGE_HOURS = 3; // Auto-expire after 3 hours

/**
 * Ensure storage file exists
 */
function ensureFile() {
    const dir = path.dirname(EPISODIC_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(EPISODIC_FILE)) {
        fs.writeFileSync(EPISODIC_FILE, JSON.stringify({ events: [] }, null, 2));
    }
}

/**
 * Load episodic memory
 */
function load() {
    ensureFile();
    try {
        const raw = fs.readFileSync(EPISODIC_FILE, "utf-8");
        return JSON.parse(raw);
    } catch {
        return { events: [] };
    }
}

/**
 * Save episodic memory
 */
function save(data) {
    ensureFile();
    fs.writeFileSync(EPISODIC_FILE, JSON.stringify(data, null, 2));
}

/**
 * Add an event to episodic memory
 * @param {Object} event - Terminal event or other activity
 */
async function add(event) {
    const data = load();

    // Add with ID
    const entry = {
        id: Date.now().toString(),
        ...event,
        timestamp: event.timestamp || new Date().toISOString(),
    };

    data.events.unshift(entry); // Most recent first

    // Prune old events
    data.events = prune(data.events);

    save(data);
    return entry;
}

/**
 * Prune old/excess events
 */
function prune(events) {
    const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;

    return events
        .filter((e) => new Date(e.timestamp).getTime() > cutoff)
        .slice(0, MAX_EVENTS);
}

/**
 * Get recent events for a project
 * @param {string} project - Project name (optional, null for all)
 * @param {number} limit - Max events to return
 */
async function getRecent(project, limit = 10) {
    const data = load();

    let events = data.events;

    if (project) {
        events = events.filter((e) => e.project === project);
    }

    return events.slice(0, limit);
}

/**
 * Get all events from last N minutes
 * @param {number} minutes
 */
async function getLastMinutes(minutes = 30) {
    const data = load();
    const cutoff = Date.now() - minutes * 60 * 1000;

    return data.events.filter((e) => new Date(e.timestamp).getTime() > cutoff);
}

/**
 * Get events by type
 * @param {string} type - Event type (e.g., "terminal", "editor")
 */
async function getByType(type, limit = 20) {
    const data = load();
    return data.events.filter((e) => e.type === type).slice(0, limit);
}

/**
 * Clear episodic memory
 * @param {string} project - If provided, only clear for this project
 */
function clear(project) {
    if (!project) {
        save({ events: [] });
        return;
    }

    const data = load();
    data.events = data.events.filter((e) => e.project !== project);
    save(data);
}

/**
 * Format episodic memory for prompt injection
 * @param {string} project
 * @param {number} limit
 */
async function formatForPrompt(project, limit = 10) {
    const events = await getRecent(project, limit);

    if (events.length === 0) return "";

    const lines = events.map((e) => {
        if (e.type === "terminal") {
            const status = e.exitCode === 0 ? "✓" : "✗";
            return `[terminal ${status}] ${e.command}`;
        }
        if (e.type === "editor") {
            return formatEditorEvent(e);
        }
        return `[${e.type}] ${e.summary || e.command || "activity"}`;
    });

    return lines.filter(Boolean).join("\n");
}

/**
 * Format editor events for prompt
 */
function formatEditorEvent(event) {
    switch (event.action) {
        case "focus":
            return `[editor] Viewing ${event.file}`;
        case "save":
            return `[editor] Saved ${event.file}`;
        case "create":
            return `[editor] Created ${event.file}`;
        case "delete":
            return `[editor] Deleted ${event.file}`;
        case "open":
            return `[editor] Opened ${event.file}`;
        case "error":
            const errMsgs = event.errors?.map(e => e.message).join("; ") || "";
            return `[editor ✗] ${event.file}: ${event.errorCount} error(s) - ${errMsgs}`;
        case "select":
            return `[editor] Selected lines ${event.startLine}-${event.endLine} in ${event.file}`;
        default:
            return `[editor] ${event.action} ${event.file || ""}`;
    }
}

/**
 * Get summary stats
 */
function getStats() {
    const data = load();
    const projects = [...new Set(data.events.map((e) => e.project))];
    const errors = data.events.filter((e) => e.exitCode !== 0).length;

    return {
        totalEvents: data.events.length,
        projects,
        errors,
        oldestEvent: data.events[data.events.length - 1]?.timestamp,
        newestEvent: data.events[0]?.timestamp,
    };
}

module.exports = {
    add,
    getRecent,
    getLastMinutes,
    getByType,
    clear,
    formatForPrompt,
    getStats,
};
