/**
 * Conversation Memory
 * Stores recent Q&A exchanges for multi-turn conversations
 * Uses LangChain message types for proper formatting
 */

const fs = require("fs");
const path = require("path");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");

const CONVERSATION_FILE = path.join(__dirname, "../../storage/conversations.json");
const MAX_CONVERSATIONS = 50;  // Max stored conversations
const MAX_CONTEXT_TURNS = 5;   // How many recent turns to include in context

/**
 * Ensure storage file exists
 */
function ensureFile() {
    const dir = path.dirname(CONVERSATION_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(CONVERSATION_FILE)) {
        fs.writeFileSync(CONVERSATION_FILE, JSON.stringify({ conversations: [] }, null, 2));
    }
}

/**
 * Load conversations
 */
function load() {
    ensureFile();
    try {
        const raw = fs.readFileSync(CONVERSATION_FILE, "utf-8");
        return JSON.parse(raw);
    } catch {
        return { conversations: [] };
    }
}

/**
 * Save conversations
 */
function save(data) {
    ensureFile();
    fs.writeFileSync(CONVERSATION_FILE, JSON.stringify(data, null, 2));
}

/**
 * Add a conversation turn (question + answer)
 * @param {string} project - Project name for scoping
 * @param {string} question - User's question
 * @param {string} answer - AI's response
 */
function addTurn(project, question, answer) {
    const data = load();

    const turn = {
        id: Date.now().toString(),
        project,
        question,
        answer,
        timestamp: new Date().toISOString(),
    };

    data.conversations.unshift(turn);

    // Prune old conversations
    data.conversations = data.conversations.slice(0, MAX_CONVERSATIONS);

    save(data);
    return turn;
}

/**
 * Get recent conversation turns for a project
 * @param {string} project - Project name (null for all)
 * @param {number} limit - Max turns to return
 * @returns {Array} Recent conversation turns
 */
function getRecent(project, limit = MAX_CONTEXT_TURNS) {
    const data = load();
    
    let conversations = data.conversations;
    
    // Filter by project if specified, but also include recent global conversations
    if (project) {
        // Get project-specific + recent global (for cross-project context)
        const projectConvos = conversations.filter(c => c.project === project);
        const recentGlobal = conversations.slice(0, 3); // Always include last 3 regardless of project
        
        // Merge and dedupe
        const merged = [...projectConvos];
        for (const g of recentGlobal) {
            if (!merged.find(m => m.id === g.id)) {
                merged.push(g);
            }
        }
        
        // Sort by timestamp descending
        conversations = merged.sort((a, b) => 
            new Date(b.timestamp) - new Date(a.timestamp)
        );
    }

    return conversations.slice(0, limit);
}

/**
 * Get conversation history as LangChain messages
 * @param {string} project - Project name
 * @param {number} limit - Max turns
 * @returns {Array} Array of HumanMessage and AIMessage
 */
function getAsMessages(project, limit = MAX_CONTEXT_TURNS) {
    const turns = getRecent(project, limit);
    const messages = [];

    // Reverse to get chronological order (oldest first)
    const chronological = turns.reverse();

    for (const turn of chronological) {
        messages.push(new HumanMessage(turn.question));
        messages.push(new AIMessage(turn.answer));
    }

    return messages;
}

/**
 * Format conversation history for prompt injection
 * @param {string} project - Project name
 * @param {number} limit - Max turns
 * @returns {string} Formatted conversation history
 */
function formatForPrompt(project, limit = MAX_CONTEXT_TURNS) {
    const turns = getRecent(project, limit);
    
    if (turns.length === 0) return "";

    const lines = ["## Recent Conversation"];
    
    // Reverse for chronological display
    const chronological = turns.reverse();
    
    for (const turn of chronological) {
        const projectTag = turn.project !== project ? ` [${turn.project}]` : "";
        lines.push(`**You${projectTag}:** ${turn.question}`);
        // Truncate long answers
        const shortAnswer = turn.answer.length > 300 
            ? turn.answer.substring(0, 300) + "..." 
            : turn.answer;
        lines.push(`**AI:** ${shortAnswer}`);
        lines.push("");
    }

    return lines.join("\n");
}

/**
 * Clear conversation history
 * @param {string} project - Project to clear (null for all)
 */
function clear(project = null) {
    if (project) {
        const data = load();
        data.conversations = data.conversations.filter(c => c.project !== project);
        save(data);
    } else {
        save({ conversations: [] });
    }
}

module.exports = {
    addTurn,
    getRecent,
    getAsMessages,
    formatForPrompt,
    clear,
};
