/**
 * Observability Tracker
 * Records every LLM call: provider, model, tokens, cost, latency, route.
 * Backed by SQLite so `ai stats` can slice by day/project/model.
 */

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_FILE = path.join(__dirname, "../../storage/telemetry.db");

let db = null;

// Cost per 1M tokens (input / output) — update as pricing changes.
const COST_TABLE = {
    "gpt-4o": { in: 2.5, out: 10.0 },
    "gpt-4o-mini": { in: 0.15, out: 0.6 },
    "gpt-4-turbo": { in: 10.0, out: 30.0 },
    "gpt-4": { in: 30.0, out: 60.0 },
    "gpt-3.5-turbo": { in: 0.5, out: 1.5 },
    "gemini-pro": { in: 0.5, out: 1.5 },
    "gemini-1.5-pro": { in: 1.25, out: 5.0 },
    "gemini-1.5-flash": { in: 0.075, out: 0.3 },
    "gemini-2.0-flash": { in: 0.1, out: 0.4 },
    ollama: { in: 0, out: 0 },
    local: { in: 0, out: 0 },
};

function getDb() {
    if (db) return db;
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_FILE);
    db.pragma("journal_mode = WAL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS llm_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            provider TEXT,
            model TEXT,
            route TEXT,
            project TEXT,
            question TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            total_tokens INTEGER,
            cost_usd REAL,
            latency_ms INTEGER,
            success INTEGER,
            error TEXT,
            node TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls(ts);
        CREATE INDEX IF NOT EXISTS idx_llm_calls_project ON llm_calls(project);
    `);
    return db;
}

function estimateCost(model, promptTokens, completionTokens) {
    if (!model) return 0;
    const key = Object.keys(COST_TABLE).find((k) => model.toLowerCase().includes(k));
    if (!key) return 0;
    const rate = COST_TABLE[key];
    return (
        (promptTokens / 1_000_000) * rate.in +
        (completionTokens / 1_000_000) * rate.out
    );
}

/**
 * Record a single LLM call.
 * @param {Object} entry { provider, model, route, project, question, prompt_tokens, completion_tokens, latency_ms, success, error, node }
 */
function record(entry) {
    try {
        const d = getDb();
        const prompt = entry.prompt_tokens || 0;
        const completion = entry.completion_tokens || 0;
        const total = prompt + completion;
        const cost = estimateCost(entry.model, prompt, completion);
        d.prepare(
            `INSERT INTO llm_calls
             (ts, provider, model, route, project, question, prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, success, error, node)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
            new Date().toISOString(),
            entry.provider || null,
            entry.model || null,
            entry.route || "direct",
            entry.project || null,
            (entry.question || "").slice(0, 500),
            prompt,
            completion,
            total,
            cost,
            entry.latency_ms || 0,
            entry.success ? 1 : 0,
            entry.error || null,
            entry.node || null
        );
        return cost;
    } catch (e) {
        // Never let telemetry break the agent
        return 0;
    }
}

/**
 * Wrap an async LLM call with timing + recording.
 * @param {Object} meta { provider, model, route, project, question, node }
 * @param {Function} fn async function returning { content, usage? }
 */
async function trace(meta, fn) {
    const t0 = Date.now();
    try {
        const result = await fn();
        const usage = extractUsage(result);
        record({
            ...meta,
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            latency_ms: Date.now() - t0,
            success: true,
        });
        return result;
    } catch (error) {
        record({
            ...meta,
            latency_ms: Date.now() - t0,
            success: false,
            error: error.message,
        });
        throw error;
    }
}

function extractUsage(response) {
    const md = response?.response_metadata || response?.usage_metadata || {};
    const tokens = md.tokenUsage || md.token_usage || md.usage || md;
    return {
        prompt: tokens.promptTokens || tokens.input_tokens || tokens.prompt_tokens || 0,
        completion: tokens.completionTokens || tokens.output_tokens || tokens.completion_tokens || 0,
    };
}

function summary({ days = 7, project = null } = {}) {
    const d = getDb();
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const where = project
        ? "WHERE ts >= ? AND project = ?"
        : "WHERE ts >= ?";
    const args = project ? [since, project] : [since];

    const totals = d.prepare(
        `SELECT COUNT(*) calls, SUM(total_tokens) tokens, SUM(cost_usd) cost,
                AVG(latency_ms) avg_latency, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) failures
         FROM llm_calls ${where}`
    ).get(...args);

    const byModel = d.prepare(
        `SELECT model, COUNT(*) calls, SUM(cost_usd) cost, SUM(total_tokens) tokens
         FROM llm_calls ${where}
         GROUP BY model ORDER BY cost DESC`
    ).all(...args);

    const byRoute = d.prepare(
        `SELECT route, COUNT(*) calls, SUM(cost_usd) cost
         FROM llm_calls ${where}
         GROUP BY route ORDER BY calls DESC`
    ).all(...args);

    const byDay = d.prepare(
        `SELECT DATE(ts) day, COUNT(*) calls, SUM(cost_usd) cost
         FROM llm_calls ${where}
         GROUP BY DATE(ts) ORDER BY day DESC LIMIT 14`
    ).all(...args);

    return { totals, byModel, byRoute, byDay, days, project };
}

function recent(limit = 20, project = null) {
    const d = getDb();
    const where = project ? "WHERE project = ?" : "";
    const args = project ? [project, limit] : [limit];
    return d.prepare(
        `SELECT ts, provider, model, route, project, latency_ms, total_tokens, cost_usd, success, node
         FROM llm_calls ${where} ORDER BY id DESC LIMIT ?`
    ).all(...args);
}

module.exports = { record, trace, summary, recent, estimateCost };
