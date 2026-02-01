/**
 * Cloud Sync Module
 * Handles seamless multi-device synchronization via Supermemory
 * 
 * Syncs:
 * - Conversations (Q&A pairs)
 * - Current tasks
 * - Important activity/events
 * - Working context
 */

const os = require("os");
const supermemory = require("./supermemory");
const config = require("../config");

// Device identifier for multi-device tracking
const DEVICE_ID = `${os.hostname()}-${os.platform()}`;

/**
 * Sync a conversation (question + answer) to Supermemory
 * @param {string} projectName - Current project
 * @param {string} question - User's question
 * @param {string} answer - AI's response
 */
async function syncConversation(projectName, question, answer) {
    const apiKey = config.get("supermemory.apiKey");
    if (!apiKey) return null;

    const content = `
## Conversation (${new Date().toISOString()})
**Device:** ${DEVICE_ID}
**Project:** ${projectName || "global"}

**Q:** ${question}

**A:** ${answer}
`.trim();

    try {
        // Use special tag for conversations
        const result = await supermemory.store(
            projectName || "_conversations",
            content,
            apiKey
        );
        return result;
    } catch (error) {
        // Silent fail - don't break the user experience
        return null;
    }
}

/**
 * Sync current task to Supermemory
 * @param {string} projectName
 * @param {string} task
 */
async function syncTask(projectName, task) {
    const apiKey = config.get("supermemory.apiKey");
    if (!apiKey) return null;

    const content = `
## Active Task
**Device:** ${DEVICE_ID}
**Project:** ${projectName}
**Started:** ${new Date().toISOString()}

**Task:** ${task}
`.trim();

    try {
        return await supermemory.store(projectName, content, apiKey);
    } catch (error) {
        return null;
    }
}

/**
 * Sync an important activity/event
 * @param {string} projectName
 * @param {string} type - Event type (file_edit, command, error, etc.)
 * @param {Object} details - Event details
 */
async function syncActivity(projectName, type, details) {
    const apiKey = config.get("supermemory.apiKey");
    if (!apiKey) return null;

    // Only sync important activities
    if (!isImportantActivity(type, details)) {
        return null;
    }

    const content = formatActivityContent(projectName, type, details);

    try {
        return await supermemory.store(projectName, content, apiKey);
    } catch (error) {
        return null;
    }
}

/**
 * Determine if an activity is important enough to sync
 */
function isImportantActivity(type, details) {
    // Always sync these
    const alwaysSync = ["git_commit", "error", "task_complete", "decision"];
    if (alwaysSync.includes(type)) return true;

    // Sync significant file edits (not just any save)
    if (type === "file_edit") {
        // Sync if it's a config file or entry point
        const importantFiles = [
            "package.json", "tsconfig.json", ".env", 
            "index.js", "main.js", "app.js", "server.js",
            "index.ts", "main.ts", "app.ts", "server.ts",
            "Dockerfile", "docker-compose.yml"
        ];
        return importantFiles.some(f => details.file?.includes(f));
    }

    // Sync commands with errors
    if (type === "command" && details.exitCode !== 0) {
        return true;
    }

    return false;
}

/**
 * Format activity content for storage
 */
function formatActivityContent(projectName, type, details) {
    const timestamp = new Date().toISOString();

    switch (type) {
        case "git_commit":
            return `
## Git Commit
**Device:** ${DEVICE_ID}
**Project:** ${projectName}
**Time:** ${timestamp}
**Message:** ${details.message}
**Files:** ${details.files || "N/A"}

${details.diff ? `**Changes:**\n\`\`\`diff\n${details.diff.substring(0, 1000)}\n\`\`\`` : ""}
`.trim();

        case "error":
            return `
## Error Encountered
**Device:** ${DEVICE_ID}
**Project:** ${projectName}
**Time:** ${timestamp}
**Command:** ${details.command || "N/A"}
**Error:** ${details.error}
`.trim();

        case "file_edit":
            return `
## File Modified
**Device:** ${DEVICE_ID}
**Project:** ${projectName}
**Time:** ${timestamp}
**File:** ${details.file}
**Action:** ${details.action || "edit"}
`.trim();

        case "decision":
            return `
## Decision Made
**Device:** ${DEVICE_ID}
**Project:** ${projectName}
**Time:** ${timestamp}
**Decision:** ${details.text}
`.trim();

        case "task_complete":
            return `
## Task Completed
**Device:** ${DEVICE_ID}
**Project:** ${projectName}
**Time:** ${timestamp}
**Task:** ${details.task}
`.trim();

        default:
            return `
## Activity: ${type}
**Device:** ${DEVICE_ID}
**Project:** ${projectName}
**Time:** ${timestamp}
**Details:** ${JSON.stringify(details)}
`.trim();
    }
}

/**
 * Sync working context (current session state)
 * Call this periodically or on significant events
 * @param {string} projectName
 * @param {Object} workingMemory
 */
async function syncWorkingContext(projectName, workingMemory) {
    const apiKey = config.get("supermemory.apiKey");
    if (!apiKey) return null;

    const content = `
## Working Context Snapshot
**Device:** ${DEVICE_ID}
**Project:** ${projectName}
**Synced:** ${new Date().toISOString()}

**Current Task:** ${workingMemory.currentTask || "None"}
**Recent Context:** ${workingMemory.context || "None"}
**Tags:** ${(workingMemory.tags || []).join(", ") || "None"}
**Blockers:** ${(workingMemory.blockers || []).map(b => b.text || b).join("; ") || "None"}

**Recent Decisions:**
${(workingMemory.decisions || []).slice(-3).map(d => `- ${d.text || d}`).join("\n") || "None"}
`.trim();

    try {
        return await supermemory.store(projectName, content, apiKey);
    } catch (error) {
        return null;
    }
}

/**
 * Retrieve recent conversations from Supermemory
 * @param {string} projectName
 * @param {string} query - Optional query to filter
 * @param {number} limit
 */
async function getRecentConversations(projectName, query = "conversation", limit = 5) {
    const apiKey = config.get("supermemory.apiKey");
    if (!apiKey) return [];

    try {
        // Search for recent conversations
        const results = await supermemory.search(
            projectName || "_conversations",
            query,
            apiKey,
            limit
        );

        // Parse and return conversation pairs
        return results.filter(r => 
            r.content?.includes("## Conversation") || 
            r.content?.includes("**Q:**")
        );
    } catch (error) {
        return [];
    }
}

/**
 * Get the current device ID
 */
function getDeviceId() {
    return DEVICE_ID;
}

/**
 * Handoff - sync all current context for device switch
 * @param {string} projectName
 * @param {Object} context - Full context object
 */
async function handoff(projectName, context) {
    const apiKey = config.get("supermemory.apiKey");
    if (!apiKey) {
        return { success: false, error: "No Supermemory API key configured" };
    }

    const content = `
## Device Handoff
**From Device:** ${DEVICE_ID}
**Project:** ${projectName}
**Time:** ${new Date().toISOString()}

### Current State
**Task:** ${context.currentTask || "None"}
**Branch:** ${context.branch || "N/A"}
**Recent Files:**
${(context.recentFiles || []).slice(0, 5).map(f => `- ${f}`).join("\n") || "None"}

### Context
${context.summary || "No additional context"}

### Recent Activity
${(context.recentActivity || []).slice(0, 5).map(a => `- ${a}`).join("\n") || "None"}
`.trim();

    try {
        await supermemory.store(projectName, content, apiKey);
        return { success: true, deviceId: DEVICE_ID };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = {
    syncConversation,
    syncTask,
    syncActivity,
    syncWorkingContext,
    getRecentConversations,
    getDeviceId,
    handoff,
    isImportantActivity,
};
