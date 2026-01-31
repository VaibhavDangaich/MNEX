/**
 * Working Memory
 * Current project context - active session state
 * Persists across commands but resets on project switch
 */

const fs = require("fs");
const path = require("path");

const WORKING_FILE = path.join(__dirname, "../../storage/working.json");

/**
 * Ensure storage file exists
 */
function ensureFile() {
    const dir = path.dirname(WORKING_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(WORKING_FILE)) {
        fs.writeFileSync(WORKING_FILE, JSON.stringify({}, null, 2));
    }
}

/**
 * Load working memory
 */
function load() {
    ensureFile();
    try {
        const raw = fs.readFileSync(WORKING_FILE, "utf-8");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

/**
 * Save working memory
 */
function save(data) {
    ensureFile();
    fs.writeFileSync(WORKING_FILE, JSON.stringify(data, null, 2));
}

/**
 * Get working memory for a project
 * @param {string} project
 */
function get(project) {
    const data = load();
    return data[project] || createDefault(project);
}

/**
 * Create default working memory for a new project
 */
function createDefault(project) {
    return {
        project,
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        context: "",
        currentTask: "",
        recentErrors: [],
        tags: [],
        decisions: [],
        blockers: [],
    };
}

/**
 * Update working memory for a project
 * @param {string} project
 * @param {Object} updates - Partial updates to merge
 */
async function update(project, updates) {
    const data = load();

    if (!data[project]) {
        data[project] = createDefault(project);
    }

    // Merge updates
    data[project] = {
        ...data[project],
        ...updates,
        lastActivity: new Date().toISOString(),
    };

    // Handle special fields
    if (updates.error) {
        data[project].recentErrors = data[project].recentErrors || [];
        data[project].recentErrors.unshift({
            error: updates.error,
            timestamp: new Date().toISOString(),
        });
        // Keep only last 5 errors
        data[project].recentErrors = data[project].recentErrors.slice(0, 5);
    }

    if (updates.tags && Array.isArray(updates.tags)) {
        // Merge tags without duplicates
        const existingTags = data[project].tags || [];
        data[project].tags = [...new Set([...existingTags, ...updates.tags])];
    }

    save(data);
    return data[project];
}

/**
 * Set the current task/goal for a project
 * @param {string} project
 * @param {string} task
 */
function setCurrentTask(project, task) {
    return update(project, { currentTask: task });
}

/**
 * Add a decision/note to working memory
 * @param {string} project
 * @param {string} decision
 */
function addDecision(project, decision) {
    const data = load();
    if (!data[project]) {
        data[project] = createDefault(project);
    }

    data[project].decisions = data[project].decisions || [];
    data[project].decisions.push({
        text: decision,
        timestamp: new Date().toISOString(),
    });

    // Keep only last 10 decisions
    data[project].decisions = data[project].decisions.slice(-10);

    save(data);
    return data[project];
}

/**
 * Add a blocker
 * @param {string} project
 * @param {string} blocker
 */
function addBlocker(project, blocker) {
    const data = load();
    if (!data[project]) {
        data[project] = createDefault(project);
    }

    data[project].blockers = data[project].blockers || [];
    data[project].blockers.push({
        text: blocker,
        timestamp: new Date().toISOString(),
        resolved: false,
    });

    save(data);
    return data[project];
}

/**
 * Clear working memory for a project
 * @param {string} project - If null, clears all
 */
function clear(project) {
    if (!project) {
        save({});
        return;
    }

    const data = load();
    delete data[project];
    save(data);
}

/**
 * Format working memory for prompt injection
 * @param {string} project
 */
function formatForPrompt(project) {
    const mem = get(project);
    const parts = [];

    if (mem.currentTask) {
        parts.push(`Current Task: ${mem.currentTask}`);
    }

    if (mem.context) {
        parts.push(`Context: ${mem.context}`);
    }

    if (mem.tags && mem.tags.length > 0) {
        parts.push(`Stack: ${mem.tags.join(", ")}`);
    }

    if (mem.recentErrors && mem.recentErrors.length > 0) {
        const lastError = mem.recentErrors[0];
        parts.push(`Recent Error: ${lastError.error}`);
    }

    if (mem.blockers && mem.blockers.filter((b) => !b.resolved).length > 0) {
        const activeBlockers = mem.blockers
            .filter((b) => !b.resolved)
            .map((b) => b.text);
        parts.push(`Blockers: ${activeBlockers.join("; ")}`);
    }

    if (mem.decisions && mem.decisions.length > 0) {
        const recent = mem.decisions.slice(-3).map((d) => d.text);
        parts.push(`Recent Decisions: ${recent.join("; ")}`);
    }

    return parts.join("\n");
}

/**
 * Get all active projects
 */
function getActiveProjects() {
    const data = load();
    return Object.keys(data);
}

module.exports = {
    get,
    update,
    setCurrentTask,
    addDecision,
    addBlocker,
    clear,
    formatForPrompt,
    getActiveProjects,
};
