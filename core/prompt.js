/**
 * Prompt Builder
 * Constructs prompts using LangChain PromptTemplates
 * Injects all memory layers: Episodic, Working, Semantic + Global + Git
 */

const { ChatPromptTemplate, SystemMessagePromptTemplate, HumanMessagePromptTemplate } = require("@langchain/core/prompts");

// System prompt template with all context layers including GLOBAL
const SYSTEM_TEMPLATE = `You are a context-aware AI assistant with full knowledge of the user's current work across ALL their projects.

## Current Location
- Directory: {projectName}
- Branch: {branch}

{gitSection}

{globalSection}

{workingSection}

{episodicSection}

{memorySection}

{semanticSection}

## Instructions
- You have access to the user's recent activity across ALL projects on their machine
- Even if the user is in a random directory, you know what they were working on
- You can see EXACT CODE CHANGES from git diffs - use this to answer "what changed" questions
- Answer questions using ALL the context above
- Be concise but thorough
- Reference specific commands, files, or errors when relevant
- If asked "what was I working on?", summarize recent activity across projects
- If asked "what changed in the code?", refer to the git diff section for exact changes`;

// Create the chat prompt template
const chatPrompt = ChatPromptTemplate.fromMessages([
    SystemMessagePromptTemplate.fromTemplate(SYSTEM_TEMPLATE),
    HumanMessagePromptTemplate.fromTemplate("{question}"),
]);

// Import git monitor for code diff info
const gitmonitor = require("./monitor/gitmonitor");

/**
 * Build git diff section (uncommitted changes + recent commits)
 * @param {Object} context - Git context with cwd
 * @returns {string} Formatted git section with code diffs
 */
function buildGitSection(context) {
    if (!context || !context.isGitRepo) {
        return "";
    }
    
    try {
        const gitInfo = gitmonitor.formatForPrompt(context.cwd || process.cwd());
        if (!gitInfo) return "";
        return `## Git Changes (Code Diffs)\n${gitInfo}`;
    } catch (error) {
        return "";
    }
}

/**
 * Build global activity section (recent work across ALL projects)
 */
function buildGlobalSection(memory) {
    if (!memory || !memory.globalText) {
        return "";
    }

    let section = "## Recent Activity (All Projects)\n";
    
    if (memory.recentProjects && memory.recentProjects.length > 0) {
        section += `Recently active: ${memory.recentProjects.join(", ")}\n\n`;
    }
    
    section += memory.globalText;
    return section;
}

/**
 * Build working memory section (current task, blockers, decisions)
 * @param {Object} memory - Memory from memory/index.js recall()
 * @returns {string} Formatted working section
 */
function buildWorkingSection(memory) {
    if (!memory || !memory.workingText) {
        return "";
    }
    return `## Current Session Context\n${memory.workingText}`;
}

/**
 * Build episodic memory section (recent terminal activity)
 * @param {Object} memory - Memory from memory/index.js recall()
 * @returns {string} Formatted episodic section
 */
function buildEpisodicSection(memory) {
    if (!memory || !memory.episodicText) {
        return "";
    }
    return `## Recent Terminal Activity\n${memory.episodicText}`;
}

/**
 * Build semantic memory section (long-term facts)
 * @param {Object} memory - Memory from memory/index.js recall()
 * @returns {string} Formatted memory section
 */
function buildMemorySection(memory) {
    if (!memory || !memory.localText) {
        return "";
    }
    return `## Project Memory (Important Facts)\n${memory.localText}`;
}

/**
 * Build Supermemory semantic search section
 * @param {Object} memory - Memory from memory/index.js recall()
 * @returns {string} Formatted semantic section
 */
function buildSemanticSection(memory) {
    if (!memory || !memory.semanticText) {
        return "";
    }
    return `## Related Context (Semantic Recall)\n${memory.semanticText}`;
}

/**
 * Build the complete prompt using LangChain templates
 * @param {string} question - User's question
 * @param {Object} context - Git context
 * @param {Object} memory - Retrieved memory (all 3 layers)
 * @returns {Object} Formatted prompt values for LangChain
 */
function buildPromptValues(question, context, memory) {
    return {
        projectName: context.isGitRepo ? context.repoName : "Unknown",
        branch: context.isGitRepo ? context.branch : "N/A",
        gitSection: buildGitSection(context),
        globalSection: buildGlobalSection(memory),
        workingSection: buildWorkingSection(memory),
        episodicSection: buildEpisodicSection(memory),
        memorySection: buildMemorySection(memory),
        semanticSection: buildSemanticSection(memory),
        question,
    };
}

/**
 * Get formatted messages for the LLM
 * @param {string} question - User's question
 * @param {Object} context - Git context
 * @param {Object} memory - Retrieved memory
 * @returns {Promise<Array>} Array of LangChain messages
 */
async function getMessages(question, context, memory) {
    const values = buildPromptValues(question, context, memory);
    return await chatPrompt.formatMessages(values);
}

/**
 * Get the chat prompt template (for direct use with chains)
 */
function getChatPrompt() {
    return chatPrompt;
}

/**
 * Format prompt for display/debugging
 */
async function formatForDisplay(question, context, memory) {
    const messages = await getMessages(question, context, memory);
    return messages.map((m) => `[${m._getType()}]\n${m.content}`).join("\n\n");
}

module.exports = {
    chatPrompt,
    getChatPrompt,
    getMessages,
    buildPromptValues,
    formatForDisplay,
};
