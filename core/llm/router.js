/**
 * Local-First LLM Router
 *
 * Decides whether a query should:
 *   1. Be answered without an LLM (pure memory/file lookup)
 *   2. Use a local Ollama model (free, fast, private)
 *   3. Use the cloud LLM (OpenAI / Gemini)
 *
 * Routing signals (cheap, heuristic — no LLM call to classify):
 *   - Length of the question
 *   - Keywords indicating code generation / deep reasoning
 *   - Whether the question can be resolved from episodic/working memory alone
 */

const config = require("../config");
const obs = require("../obs/tracker");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";

// Words that indicate we probably need the heavy model
const COMPLEX_KEYWORDS = [
    "implement", "design", "architecture", "refactor", "algorithm",
    "optimise", "optimize", "explain", "why", "debug", "fix",
    "generate", "write", "create a", "build a", "code review",
];

// Words that are pure memory lookups
const TRIVIAL_KEYWORDS = [
    "what did i", "what was i", "list", "show me", "recent",
    "last command", "yesterday", "today", "this morning",
    "what files", "which files", "when did i",
];

/**
 * Cheap rule-based classifier.
 * Returns: "trivial" | "simple" | "complex"
 */
function classify(question) {
    const q = (question || "").toLowerCase().trim();
    if (!q) return "simple";

    const len = q.length;
    const wordCount = q.split(/\s+/).length;

    if (TRIVIAL_KEYWORDS.some((k) => q.includes(k))) return "trivial";
    if (COMPLEX_KEYWORDS.some((k) => q.includes(k))) return "complex";
    if (len < 60 && wordCount < 12) return "simple";
    return "complex";
}

/**
 * Check whether Ollama is available locally.
 * Cached for the process lifetime.
 */
let ollamaCache = null;
async function ollamaAvailable() {
    if (ollamaCache !== null) return ollamaCache;
    try {
        const res = await fetch(`${OLLAMA_URL}/api/tags`, {
            signal: AbortSignal.timeout(500),
        });
        ollamaCache = res.ok;
    } catch {
        ollamaCache = false;
    }
    return ollamaCache;
}

/**
 * Call Ollama's chat endpoint.
 */
async function ollamaChat(messages, { model = OLLAMA_MODEL, temperature = 0.7 } = {}) {
    const t0 = Date.now();
    try {
        const res = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages: messages.map((m) => ({
                    role: m.role || m._getType?.() === "human" ? "user" : "assistant",
                    content: typeof m === "string" ? m : (m.content || String(m)),
                })),
                stream: false,
                options: { temperature },
            }),
        });
        if (!res.ok) throw new Error(`Ollama ${res.status}`);
        const json = await res.json();
        const out = json.message?.content || "";
        obs.record({
            provider: "ollama",
            model,
            route: "local",
            latency_ms: Date.now() - t0,
            prompt_tokens: json.prompt_eval_count || 0,
            completion_tokens: json.eval_count || 0,
            success: true,
        });
        return { content: out, provider: "ollama", model };
    } catch (error) {
        obs.record({
            provider: "ollama",
            model,
            route: "local",
            latency_ms: Date.now() - t0,
            success: false,
            error: error.message,
        });
        throw error;
    }
}

/**
 * Main router entry. Tries the cheapest path that can handle the query.
 *
 * @param {string} question
 * @param {Object} ctx { memory, forceRoute }
 * @returns { route, handler } — handler is an async fn
 */
async function route(question, { memory = null, forceRoute = null } = {}) {
    if (forceRoute) return { route: forceRoute };

    const cls = classify(question);
    const useLocal = config.get("router.localFirst") !== false;
    const hasOllama = useLocal ? await ollamaAvailable() : false;

    // Trivial questions can often be answered from episodic/working memory directly
    if (cls === "trivial" && memory?.hasActivity) {
        return { route: "memory", classification: cls };
    }

    if (hasOllama && cls !== "complex") {
        return { route: "ollama", classification: cls };
    }

    return { route: "cloud", classification: cls };
}

/**
 * Build a plain-text answer from memory for trivial questions.
 * No LLM call.
 */
function answerFromMemory(question, memory) {
    const q = question.toLowerCase();
    const parts = [];

    if (memory.globalText && (q.includes("working") || q.includes("recent") || q.includes("today"))) {
        parts.push("## Recent activity (all projects)\n" + memory.globalText);
    }
    if (memory.episodicText) {
        parts.push("## Recent commands in this project\n" + memory.episodicText);
    }
    if (memory.workingText) {
        parts.push("## Current task\n" + memory.workingText);
    }

    if (parts.length === 0) return "No recent activity found in memory.";
    return parts.join("\n\n");
}

module.exports = {
    classify,
    ollamaAvailable,
    ollamaChat,
    route,
    answerFromMemory,
    OLLAMA_MODEL,
};
