/**
 * LLM Module
 * AI calls via LangChain (provider-agnostic)
 */

const config = require("./config");
const { getMessages, getChatPrompt, buildPromptValues } = require("./prompt");
const obs = require("./obs/tracker");

// Lazy-loaded LLM instance
let llmInstance = null;

/**
 * Get or create the LLM instance
 * Supports OpenAI and Google Gemini
 */
async function getLLM() {
    if (llmInstance) return llmInstance;

    const provider = config.getLLMProvider();
    const apiKey = config.getLLMApiKey();

    if (!apiKey) {
        throw new Error(
            `No API key configured for ${provider}. ` +
            `Set ${provider.toUpperCase()}_API_KEY environment variable or update config/default.json`
        );
    }

    const model = config.get("llm.model");
    const temperature = config.get("llm.temperature") || 0.7;

    if (provider === "openai") {
        const { ChatOpenAI } = require("@langchain/openai");
        llmInstance = new ChatOpenAI({
            openAIApiKey: apiKey,
            modelName: model || "gpt-4o-mini",
            temperature,
        });
    } else if (provider === "gemini" || provider === "google") {
        const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
        llmInstance = new ChatGoogleGenerativeAI({
            apiKey,
            modelName: model || "gemini-pro",
            temperature,
        });
    } else {
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    return llmInstance;
}

/**
 * Send a question to the LLM using LangChain prompt templates
 * @param {string} question - User's question
 * @param {Object} context - Git context from context.js
 * @param {Object} memory - Memory from memory/index.js
 * @returns {string} The AI response
 */
async function chat(question, context, memory) {
    const llm = await getLLM();
    const messages = await getMessages(question, context, memory);
    const provider = config.getLLMProvider();
    const model = config.get("llm.model") || (provider === "openai" ? "gpt-4o-mini" : "gemini-pro");
    const response = await obs.trace(
        { provider, model, route: "cloud-direct", project: context?.repoName, question, node: "chat" },
        () => llm.invoke(messages)
    );
    return response.content;
}

/**
 * Stream a response from the LLM using LangChain prompt templates
 * @param {string} question - User's question
 * @param {Object} context - Git context
 * @param {Object} memory - Memory object
 * @param {Function} onChunk - Callback for each chunk
 */
async function streamChat(question, context, memory, onChunk) {
    const llm = await getLLM();
    const messages = await getMessages(question, context, memory);
    const provider = config.getLLMProvider();
    const model = config.get("llm.model") || (provider === "openai" ? "gpt-4o-mini" : "gemini-pro");

    const t0 = Date.now();
    let fullResponse = "";
    try {
        const stream = await llm.stream(messages);
        for await (const chunk of stream) {
            const text = chunk.content;
            fullResponse += text;
            if (onChunk) onChunk(text);
        }
        // Rough token estimate for streaming (LangChain doesn't always expose usage on stream)
        const approxPromptTokens = Math.ceil(
            messages.reduce((acc, m) => acc + (m.content?.length || 0), 0) / 4
        );
        const approxCompletion = Math.ceil(fullResponse.length / 4);
        obs.record({
            provider,
            model,
            route: "cloud-stream",
            project: context?.repoName,
            question,
            prompt_tokens: approxPromptTokens,
            completion_tokens: approxCompletion,
            latency_ms: Date.now() - t0,
            success: true,
            node: "streamChat",
        });
    } catch (error) {
        obs.record({
            provider, model, route: "cloud-stream", project: context?.repoName,
            question, latency_ms: Date.now() - t0, success: false, error: error.message,
            node: "streamChat",
        });
        throw error;
    }
    return fullResponse;
}

/**
 * Create a LangChain chain with the prompt template
 * Useful for more advanced use cases
 */
async function createChain() {
    const llm = await getLLM();
    const prompt = getChatPrompt();
    return prompt.pipe(llm);
}

/**
 * Simple ask function for direct prompts (no context/memory)
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Optional settings
 * @returns {string} The AI response
 */
async function ask(prompt, options = {}) {
    const llm = await getLLM();
    const { HumanMessage } = require("@langchain/core/messages");
    const provider = config.getLLMProvider();
    const model = config.get("llm.model") || (provider === "openai" ? "gpt-4o-mini" : "gemini-pro");
    const response = await obs.trace(
        { provider, model, route: "cloud-ask", question: prompt, node: options.node || "ask" },
        () => llm.invoke([new HumanMessage(prompt)])
    );
    return response.content;
}

/**
 * Reset the LLM instance (useful for switching providers)
 */
function reset() {
    llmInstance = null;
}

module.exports = {
    chat,
    streamChat,
    ask,
    reset,
    getLLM,
};
