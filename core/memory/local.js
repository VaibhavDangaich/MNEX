/**
 * Local JSON Memory Store
 * Source of truth for project-scoped memories
 */

const fs = require("fs");
const path = require("path");

const MEMORY_FILE = path.join(__dirname, "../../storage/memory.json");

// Ensure storage directory and file exist
function ensureMemoryFile() {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(MEMORY_FILE)) {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify({}, null, 2));
    }
}

// Load all memory from disk
function loadMemory() {
    ensureMemoryFile();
    const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
    return JSON.parse(raw);
}

// Save memory to disk
function saveMemory(memory) {
    ensureMemoryFile();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

/**
 * Add a memory for a specific project
 * @param {string} projectName - Git repo name or folder name
 * @param {string} text - The memory content
 */
function add(projectName, text) {
    const memory = loadMemory();

    if (!memory[projectName]) {
        memory[projectName] = [];
    }

    memory[projectName].push({
        id: Date.now().toString(),
        text,
        createdAt: new Date().toISOString(),
    });

    saveMemory(memory);
    return true;
}

/**
 * Get all memories for a project
 * @param {string} projectName
 * @returns {Array} Array of memory objects
 */
function get(projectName) {
    const memory = loadMemory();
    return memory[projectName] || [];
}

/**
 * Get all memories across all projects (for display)
 * @returns {Object} All memories keyed by project
 */
function getAll() {
    return loadMemory();
}

/**
 * Clear memories for a project or all
 * @param {string|null} projectName - If null, clears everything
 */
function clear(projectName) {
    if (!projectName) {
        saveMemory({});
        return true;
    }

    const memory = loadMemory();
    delete memory[projectName];
    saveMemory(memory);
    return true;
}

/**
 * Format memories as text for prompt injection
 * @param {string} projectName
 * @returns {string} Formatted memory text
 */
function formatForPrompt(projectName) {
    const memories = get(projectName);
    if (memories.length === 0) return "";

    return memories.map((m) => `• ${m.text}`).join("\n");
}

module.exports = {
    add,
    get,
    getAll,
    clear,
    formatForPrompt,
};
