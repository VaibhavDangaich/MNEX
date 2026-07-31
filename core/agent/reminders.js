/**
 * Smart Reminders Module
 * Context-aware reminders that trigger based on what you're working on
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const supermemory = require("../memory/supermemory");
const config = require("../config");

const REMINDERS_PATH = require("../paths").configFile("reminders.json");

/**
 * Load reminders
 */
function loadReminders() {
    try {
        if (fs.existsSync(REMINDERS_PATH)) {
            return JSON.parse(fs.readFileSync(REMINDERS_PATH, "utf-8"));
        }
    } catch (e) {}
    return { reminders: [] };
}

/**
 * Save reminders
 */
function saveReminders(data) {
    const dir = path.dirname(REMINDERS_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REMINDERS_PATH, JSON.stringify(data, null, 2));
}

/**
 * Create a context-aware reminder
 * @param {string} message - What to remind
 * @param {Object} trigger - When to trigger
 * @param {string} trigger.type - "context" | "file" | "project" | "time"
 * @param {string} trigger.value - The trigger value
 */
function createReminder(message, trigger) {
    const data = loadReminders();
    
    const reminder = {
        id: Date.now().toString(36),
        message,
        trigger,
        created: new Date().toISOString(),
        triggered: false,
        triggerCount: 0,
    };

    data.reminders.push(reminder);
    saveReminders(data);

    // Also sync to Supermemory for cross-device
    const apiKey = config.get("supermemory.apiKey");
    if (apiKey) {
        const content = `[REMINDER]
Message: ${message}
Trigger Type: ${trigger.type}
Trigger Value: ${trigger.value}
Created: ${reminder.created}`;

        supermemory.store("reminders", content, apiKey).catch(() => {});
    }

    return reminder;
}

/**
 * Check if any reminders should trigger based on current context
 * @param {Object} context - Current context
 * @param {string} context.file - Current file path
 * @param {string} context.project - Current project name
 * @param {string} context.content - File content or command
 */
function checkReminders(context) {
    const data = loadReminders();
    const triggered = [];

    for (const reminder of data.reminders) {
        if (reminder.triggered && reminder.triggerCount > 3) {
            continue; // Don't keep triggering same reminder
        }

        let shouldTrigger = false;

        switch (reminder.trigger.type) {
            case "file":
                // Trigger when working on specific file/pattern
                if (context.file) {
                    const pattern = reminder.trigger.value.toLowerCase();
                    const file = context.file.toLowerCase();
                    shouldTrigger = file.includes(pattern);
                }
                break;

            case "project":
                // Trigger when in specific project
                if (context.project) {
                    shouldTrigger = context.project.toLowerCase()
                        .includes(reminder.trigger.value.toLowerCase());
                }
                break;

            case "context":
                // Trigger based on content/activity matching
                const searchTerms = reminder.trigger.value.toLowerCase().split(" ");
                const content = (context.content || "").toLowerCase();
                const file = (context.file || "").toLowerCase();
                shouldTrigger = searchTerms.some(term => 
                    content.includes(term) || file.includes(term)
                );
                break;

            case "keyword":
                // Trigger on specific keywords in code
                if (context.content) {
                    shouldTrigger = context.content.toLowerCase()
                        .includes(reminder.trigger.value.toLowerCase());
                }
                break;
        }

        if (shouldTrigger) {
            reminder.triggered = true;
            reminder.triggerCount = (reminder.triggerCount || 0) + 1;
            reminder.lastTriggered = new Date().toISOString();
            triggered.push(reminder);
        }
    }

    if (triggered.length > 0) {
        saveReminders(data);
    }

    return triggered;
}

/**
 * List all reminders
 */
function listReminders(options = {}) {
    const data = loadReminders();
    let reminders = data.reminders;

    if (options.active) {
        reminders = reminders.filter(r => !r.triggered || r.triggerCount < 3);
    }

    if (options.triggered) {
        reminders = reminders.filter(r => r.triggered);
    }

    return reminders;
}

/**
 * Delete a reminder
 */
function deleteReminder(id) {
    const data = loadReminders();
    data.reminders = data.reminders.filter(r => r.id !== id);
    saveReminders(data);
}

/**
 * Clear all reminders
 */
function clearReminders() {
    saveReminders({ reminders: [] });
}

/**
 * Format reminder for display
 */
function formatReminder(reminder) {
    const triggerInfo = `${reminder.trigger.type}: "${reminder.trigger.value}"`;
    const status = reminder.triggered ? "✅ Triggered" : "⏳ Pending";
    
    return `📌 ${reminder.message}
   When: ${triggerInfo}
   Status: ${status}
   Created: ${reminder.created.split("T")[0]}`;
}

module.exports = {
    createReminder,
    checkReminders,
    listReminders,
    deleteReminder,
    clearReminders,
    formatReminder,
};
