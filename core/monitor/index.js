/**
 * Monitor Index
 * Unified interface for all monitoring sources
 */

const terminal = require("./terminal");
const config = require("../config");

/**
 * Check if monitoring is enabled
 */
function isEnabled() {
    return config.get("monitor.enabled") !== false;
}

/**
 * Get current monitoring status
 */
function getStatus() {
    return {
        enabled: isEnabled(),
        sources: {
            terminal: true, // Always available via shell hook
            editor: true,   // Available via VS Code extension
        },
    };
}

module.exports = {
    terminal,
    isEnabled,
    getStatus,
};
