/**
 * Preference Learning (DPO-lite, few-shot variant)
 *
 * Every suggestion / answer the user interacts with is tagged with an ID.
 * When they accept or reject it (via `ai suggest feedback`), we store a
 * (question, answer, verdict, reason) record. At planning time we inject
 * the most recent N (accepted, rejected) pairs as few-shot examples so the
 * planner learns *what this user actually wants*.
 *
 * This is the cheap path. The deeper path — exporting these as DPO pairs
 * for fine-tuning — is a one-liner at `exportPairs()`.
 */

const fs = require("fs");
const path = require("path");

const PREF_FILE = path.join(__dirname, "../../storage/preferences.json");
const MAX_RECORDS = 500;
const FEWSHOT_N = 5;

function ensure() {
    const dir = path.dirname(PREF_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(PREF_FILE)) {
        fs.writeFileSync(PREF_FILE, JSON.stringify({ pending: {}, history: [] }, null, 2));
    }
}

function load() {
    ensure();
    try {
        return JSON.parse(fs.readFileSync(PREF_FILE, "utf-8"));
    } catch {
        return { pending: {}, history: [] };
    }
}

function save(data) {
    ensure();
    const tmp = PREF_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, PREF_FILE);
}

/**
 * Record a new suggestion — returns an ID the user can later rate.
 */
function registerSuggestion({ question, answer, project = null }) {
    const data = load();
    const id = Math.random().toString(36).slice(2, 10);
    data.pending[id] = {
        id,
        question: (question || "").slice(0, 500),
        answer: (answer || "").slice(0, 2000),
        project,
        ts: new Date().toISOString(),
    };
    save(data);
    return id;
}

/**
 * Record user verdict on a suggestion.
 */
function recordFeedback(id, verdict, reason = "") {
    const data = load();
    const pending = data.pending[id];
    if (!pending) throw new Error(`Unknown suggestion id: ${id}`);
    if (!["accept", "reject"].includes(verdict)) {
        throw new Error(`verdict must be accept|reject`);
    }
    data.history.unshift({
        ...pending,
        verdict,
        reason: reason.slice(0, 300),
        rated_at: new Date().toISOString(),
    });
    data.history = data.history.slice(0, MAX_RECORDS);
    delete data.pending[id];
    save(data);
    return pending;
}

/**
 * Return recent (accepted, rejected) pairs. Useful for few-shot prompting.
 */
function recentPairs(n = FEWSHOT_N) {
    const data = load();
    const accepted = data.history.filter((h) => h.verdict === "accept").slice(0, n);
    const rejected = data.history.filter((h) => h.verdict === "reject").slice(0, n);
    return { accepted, rejected };
}

/**
 * Build a fewshot string to inject into the planner/synthesizer.
 */
function fewShotBlock() {
    const { accepted, rejected } = recentPairs(3);
    if (accepted.length === 0 && rejected.length === 0) return "";
    const lines = [];
    for (const a of accepted) {
        lines.push(`✓ User liked answering "${truncate(a.question, 80)}" with approach: ${truncate(a.answer, 120)}${a.reason ? " — because: " + a.reason : ""}`);
    }
    for (const r of rejected) {
        lines.push(`✗ User rejected answering "${truncate(r.question, 80)}" with: ${truncate(r.answer, 120)}${r.reason ? " — because: " + r.reason : ""}`);
    }
    return lines.join("\n");
}

/**
 * Export history as DPO-style (chosen, rejected) pairs for fine-tuning.
 */
function exportPairs() {
    const data = load();
    const byQuestion = new Map();
    for (const h of data.history) {
        const k = h.question;
        if (!byQuestion.has(k)) byQuestion.set(k, { chosen: [], rejected: [] });
        byQuestion.get(k)[h.verdict === "accept" ? "chosen" : "rejected"].push(h.answer);
    }
    const pairs = [];
    for (const [q, { chosen, rejected }] of byQuestion) {
        for (const c of chosen) {
            for (const r of rejected) pairs.push({ prompt: q, chosen: c, rejected: r });
        }
    }
    return pairs;
}

function stats() {
    const data = load();
    const h = data.history;
    return {
        pending: Object.keys(data.pending).length,
        total: h.length,
        accepted: h.filter((x) => x.verdict === "accept").length,
        rejected: h.filter((x) => x.verdict === "reject").length,
        dpoPairs: exportPairs().length,
    };
}

function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n) + "…" : s;
}

module.exports = {
    registerSuggestion,
    recordFeedback,
    recentPairs,
    fewShotBlock,
    exportPairs,
    stats,
};
