/**
 * Developer DNA / Digital Twin
 *
 * Mines the user's actual work history (episodic, causal graph, conversations)
 * and produces a profile: languages, frameworks, error patterns, productivity
 * windows, co-editing clusters, recurring questions.
 *
 * Also returns a short digest for injection into the agent system prompt.
 */

const fs = require("fs");
const path = require("path");

function readJsonSafe(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function episodic() {
    const p = path.join(__dirname, "../../storage/episodic.json");
    return readJsonSafe(p)?.events || [];
}

function conversations() {
    const p = path.join(__dirname, "../../storage/conversations.json");
    return readJsonSafe(p)?.conversations || [];
}

const EXT_LANG = {
    js: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript",
    py: "Python", rb: "Ruby", go: "Go", rs: "Rust",
    java: "Java", c: "C", cpp: "C++", h: "C/C++",
    sh: "Shell", bash: "Shell", zsh: "Shell",
    html: "HTML", css: "CSS", scss: "CSS",
    sql: "SQL", md: "Markdown", json: "JSON",
    vue: "Vue", svelte: "Svelte", yaml: "YAML", yml: "YAML",
};

function languages(events) {
    const counts = {};
    for (const e of events) {
        if (e.type !== "editor") continue;
        const ext = (e.extension || path.extname(e.file || "") || "").replace(/^\./, "").toLowerCase();
        const lang = EXT_LANG[ext];
        if (!lang) continue;
        counts[lang] = (counts[lang] || 0) + 1;
    }
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
}

function topCommands(events) {
    const counts = {};
    for (const e of events) {
        if (e.type !== "terminal" || !e.command) continue;
        const head = e.command.trim().split(/\s+/)[0];
        counts[head] = (counts[head] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
}

function errorSignatures(events) {
    const sigs = {};
    for (const e of events) {
        if (e.type === "terminal" && e.exitCode && e.exitCode !== 0) {
            const cmd = (e.command || "").trim().split(/\s+/).slice(0, 2).join(" ");
            sigs[cmd] = (sigs[cmd] || 0) + 1;
        }
        if (e.type === "editor" && e.action === "error") {
            for (const err of e.errors || []) {
                const k = err.type || "syntax";
                sigs[`[edit] ${k}`] = (sigs[`[edit] ${k}`] || 0) + 1;
            }
        }
    }
    return Object.entries(sigs).sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function productivityHours(events) {
    const buckets = Array(24).fill(0);
    for (const e of events) {
        if (!e.timestamp) continue;
        const h = new Date(e.timestamp).getHours();
        buckets[h] += 1;
    }
    // Compress to top hours
    const ranked = buckets
        .map((c, h) => ({ h, c }))
        .sort((a, b) => b.c - a.c)
        .slice(0, 4)
        .filter((x) => x.c > 0)
        .map((x) => `${String(x.h).padStart(2, "0")}:00`);
    return ranked;
}

function coEditClusters(events) {
    // Find pairs of files edited within 60s of each other
    const editEvents = events
        .filter((e) => e.type === "editor" && e.action === "save")
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const pairCounts = {};
    for (let i = 0; i < editEvents.length; i++) {
        for (let j = i + 1; j < editEvents.length; j++) {
            const dt = new Date(editEvents[j].timestamp) - new Date(editEvents[i].timestamp);
            if (dt > 60_000) break;
            const [a, b] = [editEvents[i].file, editEvents[j].file].sort();
            if (!a || !b || a === b) continue;
            const key = `${a} ↔ ${b}`;
            pairCounts[key] = (pairCounts[key] || 0) + 1;
        }
    }
    return Object.entries(pairCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
}

function frequentQuestions(convos) {
    // Naive topic extraction: group by first 5 keywords (stopwords removed)
    const STOP = new Set(["what", "how", "why", "when", "where", "the", "a", "an",
        "is", "are", "do", "does", "did", "i", "me", "my", "this", "that",
        "it", "can", "should", "would", "to", "and", "of", "in", "on", "for"]);
    const clusters = {};
    for (const c of convos) {
        const words = (c.question || "")
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 3 && !STOP.has(w))
            .slice(0, 3)
            .sort()
            .join(", ");
        if (!words) continue;
        clusters[words] = (clusters[words] || 0) + 1;
    }
    return Object.entries(clusters).sort((a, b) => b[1] - a[1]).slice(0, 6);
}

function build() {
    const ev = episodic();
    const cv = conversations();
    return {
        windowEvents: ev.length,
        windowConversations: cv.length,
        languages: languages(ev),
        topCommands: topCommands(ev),
        errorSignatures: errorSignatures(ev),
        productiveHours: productivityHours(ev),
        coEditClusters: coEditClusters(ev),
        frequentTopics: frequentQuestions(cv),
        generatedAt: new Date().toISOString(),
    };
}

function format(profile = null) {
    const p = profile || build();
    const out = ["# Developer DNA", `_Generated ${p.generatedAt}_`, ""];

    out.push(`**Sample size:** ${p.windowEvents} events · ${p.windowConversations} conversations`);
    out.push("");

    if (p.languages.length) {
        out.push("## Languages");
        for (const [l, n] of p.languages) out.push(`- ${l} — ${n} edits`);
        out.push("");
    }
    if (p.topCommands.length) {
        out.push("## Top commands");
        for (const [c, n] of p.topCommands) out.push(`- \`${c}\` × ${n}`);
        out.push("");
    }
    if (p.errorSignatures.length) {
        out.push("## Recurring error signatures");
        for (const [sig, n] of p.errorSignatures) out.push(`- ${sig} — ${n} occurrences`);
        out.push("");
    }
    if (p.productiveHours.length) {
        out.push(`## Most productive hours`);
        out.push(`- ${p.productiveHours.join(", ")}`);
        out.push("");
    }
    if (p.coEditClusters.length) {
        out.push("## Co-edited file pairs");
        for (const [pair, n] of p.coEditClusters) out.push(`- ${pair} × ${n}`);
        out.push("");
    }
    if (p.frequentTopics.length) {
        out.push("## Frequent question topics");
        for (const [t, n] of p.frequentTopics) out.push(`- ${t} × ${n}`);
    }
    return out.join("\n");
}

/**
 * Compact 3–5 line digest for prompt injection.
 */
function digest() {
    const p = build();
    const parts = [];
    if (p.languages.length) {
        parts.push(`Primary languages: ${p.languages.slice(0, 3).map(([l]) => l).join(", ")}.`);
    }
    if (p.errorSignatures.length) {
        parts.push(`Recent error signatures: ${p.errorSignatures.slice(0, 3).map(([s]) => s).join(", ")}.`);
    }
    if (p.frequentTopics.length) {
        parts.push(`Frequent topics: ${p.frequentTopics.slice(0, 3).map(([t]) => t).join(" / ")}.`);
    }
    return parts.join(" ");
}

module.exports = { build, format, digest };
