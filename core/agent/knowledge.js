/**
 * Knowledge Base Module
 * Supermemory-powered personal knowledge management
 * - Error solutions
 * - Decision log
 * - Learning capture
 * - Code snippets
 */

const supermemory = require("../memory/supermemory");
const config = require("../config");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Local cache for offline access
const CACHE_PATH = path.join(os.homedir(), ".config", "ai-agent", "knowledge.json");

/**
 * Load local cache
 */
function loadCache() {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
        }
    } catch (e) {}
    return { errors: [], decisions: [], learnings: [], snippets: [] };
}

/**
 * Save to local cache
 */
function saveCache(cache) {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ==========================================
// ERROR SOLUTIONS DATABASE
// ==========================================

/**
 * Store an error and its solution
 */
async function storeError(error, solution, context = {}) {
    const apiKey = config.get("supermemory.apiKey");
    const timestamp = new Date().toISOString();
    const project = context.project || "unknown";

    const entry = {
        type: "error_solution",
        error: error.substring(0, 500),
        solution,
        project,
        timestamp,
        tags: context.tags || [],
    };

    // Store in Supermemory
    const content = `[ERROR SOLUTION]
Error: ${error}
Solution: ${solution}
Project: ${project}
Date: ${timestamp}
Tags: ${entry.tags.join(", ")}`;

    if (apiKey) {
        try {
            await supermemory.store("error-solutions", content, apiKey);
        } catch (e) {
            console.error("Failed to sync to Supermemory:", e.message);
        }
    }

    // Also store locally
    const cache = loadCache();
    cache.errors.push(entry);
    // Keep last 100
    if (cache.errors.length > 100) cache.errors.shift();
    saveCache(cache);

    return entry;
}

/**
 * Find similar errors you've solved before
 */
async function findErrorSolution(error) {
    const apiKey = config.get("supermemory.apiKey");
    const results = [];

    // Search Supermemory
    if (apiKey) {
        try {
            const smResults = await supermemory.search(
                `error solution ${error}`,
                apiKey,
                { limit: 5 }
            );
            for (const r of smResults) {
                if (r.content?.includes("[ERROR SOLUTION]")) {
                    results.push({
                        source: "supermemory",
                        content: r.content,
                        score: r.score,
                    });
                }
            }
        } catch (e) {}
    }

    // Also search local cache
    const cache = loadCache();
    const errorLower = error.toLowerCase();
    const localMatches = cache.errors.filter(e => 
        e.error.toLowerCase().includes(errorLower) ||
        errorLower.includes(e.error.toLowerCase().substring(0, 50))
    );

    for (const match of localMatches) {
        results.push({
            source: "local",
            error: match.error,
            solution: match.solution,
            project: match.project,
            date: match.timestamp,
        });
    }

    return results;
}

// ==========================================
// DECISION LOG
// ==========================================

/**
 * Log an architectural/technical decision
 */
async function logDecision(decision, reasoning, context = {}) {
    const apiKey = config.get("supermemory.apiKey");
    const timestamp = new Date().toISOString();
    const project = context.project || "unknown";

    const entry = {
        type: "decision",
        decision,
        reasoning,
        project,
        timestamp,
        alternatives: context.alternatives || [],
        tradeoffs: context.tradeoffs || [],
    };

    const content = `[ARCHITECTURAL DECISION]
Decision: ${decision}
Reasoning: ${reasoning}
Project: ${project}
Date: ${timestamp}
Alternatives Considered: ${entry.alternatives.join(", ") || "none listed"}
Tradeoffs: ${entry.tradeoffs.join(", ") || "none listed"}`;

    if (apiKey) {
        try {
            await supermemory.store("decisions", content, apiKey);
        } catch (e) {
            console.error("Failed to sync to Supermemory:", e.message);
        }
    }

    // Store locally
    const cache = loadCache();
    cache.decisions.push(entry);
    if (cache.decisions.length > 100) cache.decisions.shift();
    saveCache(cache);

    return entry;
}

/**
 * Search past decisions
 */
async function searchDecisions(query) {
    const apiKey = config.get("supermemory.apiKey");
    const results = [];

    if (apiKey) {
        try {
            const smResults = await supermemory.search(
                `decision ${query}`,
                apiKey,
                { limit: 10 }
            );
            for (const r of smResults) {
                if (r.content?.includes("[ARCHITECTURAL DECISION]")) {
                    results.push({
                        source: "supermemory",
                        content: r.content,
                        score: r.score,
                    });
                }
            }
        } catch (e) {}
    }

    // Local search
    const cache = loadCache();
    const queryLower = query.toLowerCase();
    const localMatches = cache.decisions.filter(d =>
        d.decision.toLowerCase().includes(queryLower) ||
        d.reasoning.toLowerCase().includes(queryLower)
    );

    for (const match of localMatches) {
        results.push({
            source: "local",
            ...match,
        });
    }

    return results;
}

// ==========================================
// LEARNING CAPTURE
// ==========================================

/**
 * Capture a learning/insight
 */
async function captureLearning(insight, context = {}) {
    const apiKey = config.get("supermemory.apiKey");
    const timestamp = new Date().toISOString();
    const project = context.project || "general";
    const category = context.category || "general";

    const entry = {
        type: "learning",
        insight,
        project,
        category,
        timestamp,
        source: context.source || "self",
    };

    const content = `[LEARNING]
Insight: ${insight}
Category: ${category}
Project: ${project}
Source: ${entry.source}
Date: ${timestamp}`;

    if (apiKey) {
        try {
            await supermemory.store("learnings", content, apiKey);
        } catch (e) {
            console.error("Failed to sync to Supermemory:", e.message);
        }
    }

    // Store locally
    const cache = loadCache();
    cache.learnings.push(entry);
    if (cache.learnings.length > 200) cache.learnings.shift();
    saveCache(cache);

    return entry;
}

/**
 * Search learnings
 */
async function searchLearnings(query) {
    const apiKey = config.get("supermemory.apiKey");
    const results = [];

    if (apiKey) {
        try {
            const smResults = await supermemory.search(
                `learning ${query}`,
                apiKey,
                { limit: 10 }
            );
            for (const r of smResults) {
                if (r.content?.includes("[LEARNING]")) {
                    results.push({
                        source: "supermemory",
                        content: r.content,
                        score: r.score,
                    });
                }
            }
        } catch (e) {}
    }

    // Local search
    const cache = loadCache();
    const queryLower = query.toLowerCase();
    const localMatches = cache.learnings.filter(l =>
        l.insight.toLowerCase().includes(queryLower)
    );

    for (const match of localMatches) {
        results.push({
            source: "local",
            ...match,
        });
    }

    return results;
}

// ==========================================
// CODE SNIPPETS
// ==========================================

/**
 * Save a code snippet
 */
async function saveSnippet(name, code, context = {}) {
    const apiKey = config.get("supermemory.apiKey");
    const timestamp = new Date().toISOString();
    const language = context.language || "javascript";
    const description = context.description || "";

    const entry = {
        type: "snippet",
        name,
        code,
        language,
        description,
        timestamp,
        tags: context.tags || [],
    };

    const content = `[CODE SNIPPET]
Name: ${name}
Language: ${language}
Description: ${description}
Tags: ${entry.tags.join(", ")}
Date: ${timestamp}

\`\`\`${language}
${code}
\`\`\``;

    if (apiKey) {
        try {
            await supermemory.store("snippets", content, apiKey);
        } catch (e) {
            console.error("Failed to sync to Supermemory:", e.message);
        }
    }

    // Store locally
    const cache = loadCache();
    cache.snippets.push(entry);
    if (cache.snippets.length > 100) cache.snippets.shift();
    saveCache(cache);

    return entry;
}

/**
 * Find code snippets
 */
async function findSnippets(query) {
    const apiKey = config.get("supermemory.apiKey");
    const results = [];

    if (apiKey) {
        try {
            const smResults = await supermemory.search(
                `code snippet ${query}`,
                apiKey,
                { limit: 10 }
            );
            for (const r of smResults) {
                if (r.content?.includes("[CODE SNIPPET]")) {
                    results.push({
                        source: "supermemory",
                        content: r.content,
                        score: r.score,
                    });
                }
            }
        } catch (e) {}
    }

    // Local search
    const cache = loadCache();
    const queryLower = query.toLowerCase();
    const localMatches = cache.snippets.filter(s =>
        s.name.toLowerCase().includes(queryLower) ||
        s.description.toLowerCase().includes(queryLower) ||
        s.tags.some(t => t.toLowerCase().includes(queryLower))
    );

    for (const match of localMatches) {
        results.push({
            source: "local",
            ...match,
        });
    }

    return results;
}

// ==========================================
// STATS
// ==========================================

/**
 * Get knowledge base statistics
 */
function getStats() {
    const cache = loadCache();
    return {
        errors: cache.errors.length,
        decisions: cache.decisions.length,
        learnings: cache.learnings.length,
        snippets: cache.snippets.length,
        total: cache.errors.length + cache.decisions.length + 
               cache.learnings.length + cache.snippets.length,
    };
}

module.exports = {
    // Error solutions
    storeError,
    findErrorSolution,
    
    // Decision log
    logDecision,
    searchDecisions,
    
    // Learnings
    captureLearning,
    searchLearnings,
    
    // Snippets
    saveSnippet,
    findSnippets,
    
    // Stats
    getStats,
    loadCache,
};
