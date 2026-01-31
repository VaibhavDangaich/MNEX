/**
 * Context Extractor
 * Uses LangChain to convert raw terminal events → semantic summaries
 */

const { ChatPromptTemplate } = require("@langchain/core/prompts");
const { StructuredOutputParser } = require("@langchain/core/output_parsers");
const { z } = require("zod");
const config = require("../config");

// Schema for extracted context
const contextSchema = z.object({
    summary: z.string().describe("Brief semantic summary of what the user is doing"),
    intent: z.string().describe("User's likely intent or goal"),
    tags: z.array(z.string()).describe("Relevant tags: tech, tools, actions"),
    importance: z.enum(["low", "medium", "high"]).describe("How important this is to remember"),
    error: z.string().optional().describe("Error description if command failed"),
});

const outputParser = StructuredOutputParser.fromZodSchema(contextSchema);

// Prompt template for context extraction
const extractionPrompt = ChatPromptTemplate.fromMessages([
    [
        "system",
        `You are a context extraction agent. Analyze terminal activity and extract semantic meaning.

Your job:
1. Summarize what the user is DOING (not just what command ran)
2. Infer their INTENT
3. Tag with relevant technologies/tools
4. Rate importance (high = errors, deployments, major actions)

Be concise. Focus on intent, not syntax.

{format_instructions}`,
    ],
    [
        "human",
        `Terminal Event:
- Command: {command}
- Directory: {cwd}
- Project: {project}
- Exit Code: {exitCode}
- Output (truncated): {output}

Extract the semantic context.`,
    ],
]);

/**
 * Extract semantic context from a terminal event
 * @param {Object} event - Terminal event
 * @returns {Object} Extracted context
 */
async function extractContext(event) {
    try {
        const llm = await getLLM();

        const chain = extractionPrompt.pipe(llm).pipe(outputParser);

        const result = await chain.invoke({
            command: event.command,
            cwd: event.cwd,
            project: event.project,
            exitCode: event.exitCode,
            output: truncateOutput(event.output),
            format_instructions: outputParser.getFormatInstructions(),
        });

        return result;
    } catch (error) {
        // Fallback to basic extraction if LLM fails
        return basicExtract(event);
    }
}

/**
 * Get LLM instance for extraction (uses smaller/faster model)
 */
async function getLLM() {
    const provider = config.getLLMProvider();
    const apiKey = config.getLLMApiKey();

    if (!apiKey) {
        throw new Error("No LLM API key configured");
    }

    if (provider === "openai") {
        const { ChatOpenAI } = require("@langchain/openai");
        return new ChatOpenAI({
            openAIApiKey: apiKey,
            modelName: "gpt-4o-mini", // Fast & cheap for extraction
            temperature: 0,
        });
    } else if (provider === "gemini" || provider === "google") {
        const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
        return new ChatGoogleGenerativeAI({
            apiKey,
            modelName: "gemini-1.5-flash",
            temperature: 0,
        });
    }

    throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Truncate output to avoid token overflow
 */
function truncateOutput(output, maxLength = 500) {
    if (!output) return "(no output)";
    if (output.length <= maxLength) return output;
    return output.substring(0, maxLength) + "... (truncated)";
}

/**
 * Basic extraction without LLM (fallback)
 */
function basicExtract(event) {
    const cmd = event.command.split(" ")[0];
    const isError = event.exitCode !== 0;

    const tags = [];
    if (event.command.includes("npm") || event.command.includes("node")) tags.push("nodejs");
    if (event.command.includes("git")) tags.push("git");
    if (event.command.includes("docker")) tags.push("docker");
    if (event.command.includes("python")) tags.push("python");

    return {
        summary: isError
            ? `Command "${cmd}" failed in ${event.project}`
            : `Ran "${cmd}" in ${event.project}`,
        intent: "development",
        tags,
        importance: isError ? "high" : "low",
        error: isError ? `Exit code ${event.exitCode}` : undefined,
    };
}

/**
 * Batch extract context from multiple events
 * Used for summarizing a session
 */
async function extractSessionSummary(events) {
    if (!events || events.length === 0) return null;

    const prompt = ChatPromptTemplate.fromMessages([
        [
            "system",
            `Summarize this terminal session into a brief context paragraph.
Focus on: what was accomplished, current state, any blockers.
Be concise (2-3 sentences max).`,
        ],
        [
            "human",
            `Session events:
{events}

Summarize the session.`,
        ],
    ]);

    try {
        const llm = await getLLM();
        const chain = prompt.pipe(llm);

        const eventText = events
            .map((e) => `[${e.exitCode === 0 ? "OK" : "FAIL"}] ${e.command}`)
            .join("\n");

        const result = await chain.invoke({ events: eventText });
        return result.content;
    } catch {
        return `Session with ${events.length} commands in ${events[0]?.project || "unknown"}`;
    }
}

module.exports = {
    extractContext,
    extractSessionSummary,
    basicExtract,
};
