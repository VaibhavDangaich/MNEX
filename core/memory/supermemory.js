/**
 * Supermemory Integration
 * Semantic memory retrieval using official SDK
 * 
 * Supermemory: https://supermemory.ai
 */

const Supermemory = require("supermemory").default;

// Lazy-loaded client instance
let client = null;

/**
 * Get or create the Supermemory client
 * @param {string} apiKey
 */
function getClient(apiKey) {
    if (!client && apiKey) {
        client = new Supermemory({ apiKey });
    }
    return client;
}

/**
 * Store a memory in Supermemory for semantic search
 * @param {string} projectName - Used as containerTag
 * @param {string} text - Memory content
 * @param {string} apiKey - Supermemory API key
 */
async function store(projectName, text, apiKey) {
    if (!apiKey) {
        return null;
    }

    try {
        const supermemory = getClient(apiKey);
        const result = await supermemory.add({
            content: text,
            containerTags: [projectName],
        });
        return result;
    } catch (error) {
        console.warn("Supermemory store failed:", error.message);
        return null;
    }
}

/**
 * Search Supermemory for relevant memories
 * @param {string|null} projectName - Filter by project (containerTag), null for global search
 * @param {string} query - Search query
 * @param {string} apiKey - Supermemory API key
 * @param {number} limit - Max results
 * @returns {Array} Array of relevant memories
 */
async function search(projectName, query, apiKey, limit = 5) {
    if (!apiKey) {
        return [];
    }

    try {
        const supermemory = getClient(apiKey);
        
        // Build search params - omit containerTag if null (global search)
        const searchParams = {
            q: query,
            limit,
        };
        
        // Only add containerTag if projectName is provided
        if (projectName) {
            searchParams.containerTag = projectName;
        }
        
        const results = await supermemory.search.memories(searchParams);
        return results.results || results || [];
    } catch (error) {
        console.warn("Supermemory search failed:", error.message);
        return [];
    }
}

/**
 * Get user/project profile from Supermemory
 * @param {string} projectName - containerTag
 * @param {string} apiKey
 */
async function getProfile(projectName, apiKey) {
    if (!apiKey) {
        return null;
    }

    try {
        const supermemory = getClient(apiKey);
        return await supermemory.profile({ containerTag: projectName });
    } catch (error) {
        console.warn("Supermemory profile failed:", error.message);
        return null;
    }
}

/**
 * Format search results for prompt injection
 * @param {Array} results - Search results from Supermemory
 * @returns {string} Formatted text
 */
function formatForPrompt(results) {
    if (!results || results.length === 0) return "";

    return results.map((r) => `• ${r.content || r.text || r}`).join("\n");
}

/**
 * Reset client (useful for testing)
 */
function reset() {
    client = null;
}

module.exports = {
    store,
    search,
    getProfile,
    formatForPrompt,
    reset,
};
