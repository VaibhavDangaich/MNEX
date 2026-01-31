/**
 * Memory Interface
 * Three-Layer Memory System:
 * 1. Episodic - Recent activity (last 1-3 hours), volatile
 * 2. Working - Current project context, session-scoped
 * 3. Semantic - Long-term facts (local + Supermemory)
 */

const local = require("./local");
const supermemory = require("./supermemory");
const episodic = require("./episodic");
const working = require("./working");
const config = require("../config");

/**
 * Add a memory (stores in both local and Supermemory)
 * @param {string} projectName
 * @param {string} text
 */
async function remember(projectName, text) {
    // Always store locally (source of truth)
    local.add(projectName, text);

    // Also store in Supermemory for semantic search
    const apiKey = config.get("supermemory.apiKey");
    if (apiKey) {
        await supermemory.store(projectName, text, apiKey);
    }

    return true;
}

/**
 * Full context recall - combines all three memory layers
 * Now includes GLOBAL context (all recent activity across all projects)
 * @param {string} projectName
 * @param {string} query - User's question (for semantic search)
 * @param {boolean} includeGlobal - Include activity from all projects
 */
async function recall(projectName, query, includeGlobal = true) {
    // Layer 1: Episodic - recent activity
    // Get project-specific AND global recent activity
    const recentActivity = await episodic.getRecent(projectName, 5);
    const episodicText = await episodic.formatForPrompt(projectName, 5);

    // Global activity (all projects, last 30 minutes)
    let globalActivity = [];
    let globalText = "";
    if (includeGlobal) {
        globalActivity = await episodic.getLastMinutes(60); // Last hour
        globalText = await formatGlobalActivity(globalActivity, projectName);
    }

    // Layer 2: Working - current project state
    const workingMem = working.get(projectName);
    const workingText = working.formatForPrompt(projectName);

    // Also get working context from recently active projects
    let recentProjects = [];
    if (includeGlobal) {
        recentProjects = getRecentlyActiveProjects(globalActivity, projectName);
    }

    // Layer 3: Semantic - long-term memories
    const localMemories = local.get(projectName);
    const localText = local.formatForPrompt(projectName);

    // Layer 3b: Supermemory semantic search (search globally)
    let semanticText = "";
    const apiKey = config.get("supermemory.apiKey");
    if (apiKey && query) {
        // Search current project first
        const results = await supermemory.search(projectName, query, apiKey);
        semanticText = supermemory.formatForPrompt(results);

        // Also search globally if we have recent projects
        for (const proj of recentProjects.slice(0, 2)) {
            const projResults = await supermemory.search(proj, query, apiKey);
            if (projResults.length > 0) {
                semanticText += `\n[from ${proj}] ` + supermemory.formatForPrompt(projResults);
            }
        }
    }

    return {
        // Episodic layer
        episodic: recentActivity,
        episodicText,

        // Global layer (NEW)
        globalActivity,
        globalText,
        recentProjects,

        // Working layer
        working: workingMem,
        workingText,

        // Semantic layer
        local: localMemories,
        localText,
        semanticText,

        // Convenience flags
        hasMemory: localMemories.length > 0 || semanticText.length > 0,
        hasActivity: recentActivity.length > 0 || globalActivity.length > 0,
        hasWorkingContext: !!workingMem.currentTask || !!workingMem.context,
        hasGlobalContext: globalActivity.length > 0,
    };
}

/**
 * Format global activity for prompt (shows recent work across ALL projects)
 */
async function formatGlobalActivity(events, currentProject) {
    if (!events || events.length === 0) return "";

    // Group by project, show what user was doing
    // Filter out non-project entries (null, unknown, system paths)
    const byProject = {};
    for (const e of events) {
        // Skip non-project entries
        if (!e.project || e.project === "unknown" || e.project === null || isSystemPath(e.project)) {
            continue;
        }
        if (!byProject[e.project]) {
            byProject[e.project] = [];
        }
        byProject[e.project].push(e);
    }

    const lines = [];
    for (const [project, projEvents] of Object.entries(byProject)) {
        if (project === currentProject) continue; // Skip current, already shown
        const summary = projEvents.slice(0, 3).map((e) => {
            if (e.type === "terminal") return e.command;
            if (e.type === "editor") return `${e.action} ${e.file}`;
            return e.action || "activity";
        });
        lines.push(`• ${project}: ${summary.join(", ")}`);
    }

    return lines.join("\n");
}

/**
 * Get list of recently active projects (excluding current and non-projects)
 */
function getRecentlyActiveProjects(events, currentProject) {
    const projects = new Set();
    for (const e of events) {
        // Only include real projects - filter out null, undefined, "unknown", and system paths
        if (e.project && 
            e.project !== currentProject && 
            e.project !== "unknown" &&
            e.project !== null &&
            !isSystemPath(e.project)) {
            projects.add(e.project);
        }
    }
    return [...projects];
}

/**
 * Check if a path looks like a system directory (not a real project)
 */
function isSystemPath(name) {
    const systemPaths = ["tmp", "var", "etc", "usr", "bin", "home", "Users", "root"];
    return systemPaths.includes(name);
}

/**
 * Quick recall - just semantic memory (for simple queries)
 */
async function quickRecall(projectName, query) {
    const localMemories = local.get(projectName);
    const localText = local.formatForPrompt(projectName);

    let semanticText = "";
    const apiKey = config.get("supermemory.apiKey");
    if (apiKey && query) {
        const results = await supermemory.search(projectName, query, apiKey);
        semanticText = supermemory.formatForPrompt(results);
    }

    return {
        local: localMemories,
        localText,
        semanticText,
        hasMemory: localMemories.length > 0 || semanticText.length > 0,
    };
}

/**
 * Show all memories (for display purposes)
 * @param {string|null} projectName - If null, shows all projects
 */
function show(projectName) {
    if (projectName) {
        return local.get(projectName);
    }
    return local.getAll();
}

/**
 * Clear memories
 * @param {string|null} projectName - If null, clears everything
 */
function forget(projectName) {
    return local.clear(projectName);
}

/**
 * Clear all memory layers for a project
 */
function forgetAll(projectName) {
    local.clear(projectName);
    episodic.clear(projectName);
    working.clear(projectName);
}

/**
 * Get memory stats across all layers
 */
function getStats(projectName) {
    const episodicStats = episodic.getStats();
    const workingMem = projectName ? working.get(projectName) : null;
    const localMem = projectName ? local.get(projectName) : local.getAll();

    return {
        episodic: episodicStats,
        working: workingMem,
        semantic: {
            count: projectName
                ? localMem.length
                : Object.values(localMem).flat().length,
        },
    };
}

module.exports = {
    // Core
    remember,
    recall,
    quickRecall,
    show,
    forget,
    forgetAll,
    getStats,

    // Direct access to layers
    episodic,
    working,
    local,
    supermemory,
};
