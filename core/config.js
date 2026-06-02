/**
 * Configuration Manager
 * Loads config from file and environment variables
 */

const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "../config/default.json");

let configCache = null;

/**
 * Load configuration from file
 */
function loadConfig() {
    if (configCache) return configCache;

    try {
        const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
        configCache = JSON.parse(raw);
    } catch (error) {
        console.warn("Could not load config file, using defaults");
        configCache = {};
    }

    return configCache;
}

/**
 * Get a config value by dot-notation path
 * Environment variables override file config
 * 
 * @param {string} key - e.g., "openai.apiKey" or "llm.model"
 * @returns {any} The config value
 */
function get(key) {
    // Check environment variables first (e.g., OPENAI_API_KEY)
    const envKey = key.toUpperCase().replace(/\./g, "_");
    if (process.env[envKey]) {
        return process.env[envKey];
    }

    // Special mappings for common env vars
    const envMappings = {
        "openai.apiKey": "OPENAI_API_KEY",
        "gemini.apiKey": "GEMINI_API_KEY",
        "supermemory.apiKey": "SUPERMEMORY_API_KEY",
        "github.token": "GITHUB_TOKEN",
    };

    if (envMappings[key] && process.env[envMappings[key]]) {
        return process.env[envMappings[key]];
    }

    // Fall back to config file
    const config = loadConfig();
    const parts = key.split(".");
    let value = config;

    for (const part of parts) {
        if (value === undefined || value === null) return undefined;
        value = value[part];
    }

    return value;
}

/**
 * Get the current LLM provider
 * Priority: explicit LLM_PROVIDER > auto-detect from available API keys > default to openai
 */
function getLLMProvider() {
    // Check explicit provider setting
    const explicit = get("llm.provider");
    if (explicit) return explicit;
    
    // Auto-detect based on which API key is available
    if (process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
        return "gemini";
    }
    
    // Default to openai
    return "openai";
}

/**
 * Get the API key for the current LLM provider
 */
function getLLMApiKey() {
    const provider = getLLMProvider();
    return get(`${provider}.apiKey`);
}

/**
 * Check if Supermemory is enabled and configured
 */
function isSupermemoryEnabled() {
    return get("supermemory.enabled") && get("supermemory.apiKey");
}

module.exports = {
    get,
    getLLMProvider,
    getLLMApiKey,
    isSupermemoryEnabled,
    loadConfig,
};
