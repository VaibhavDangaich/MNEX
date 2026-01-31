/**
 * LLM Module
 * AI calls via LangChain (provider-agnostic)
 */

const config = require("./config");
const { getMessages, getChatPrompt, buildPromptValues } = require("./prompt");

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
    const response = await llm.invoke(messages);
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

    const stream = await llm.stream(messages);

    let fullResponse = "";
    for await (const chunk of stream) {
        const text = chunk.content;
        fullResponse += text;
        if (onChunk) onChunk(text);
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
 * Reset the LLM instance (useful for switching providers)
 */
function reset() {
    llmInstance = null;
}

module.exports = {
    chat,
    streamChat,
    reset,
};
