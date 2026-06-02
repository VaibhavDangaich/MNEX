/**
 * Multi-Agent Code Review (LangGraph, parallel fan-out)
 *
 *                        ┌──────────┐
 *                   ┌──▶ │ reviewer │ ──┐
 *                   │    └──────────┘   │
 *       ┌────────┐  │    ┌──────────┐   │   ┌──────────┐
 *       │  diff  │ ─┼──▶ │  tester  │ ──┼──▶│ merger   │
 *       └────────┘  │    └──────────┘   │   └──────────┘
 *                   │    ┌──────────┐   │
 *                   └──▶ │ docsmith │ ──┘
 *                        └──────────┘
 *
 * Three specialists score the current diff in parallel:
 *   - reviewer: bugs, security, style
 *   - tester:   test coverage, edge cases, suggested test names
 *   - docsmith: docstrings / comments / README drift
 *
 * Their findings are merged into a single report.
 */

const { StateGraph, END, START, Annotation } = require("@langchain/langgraph");
const { execFileSync } = require("child_process");
const llm = require("../llm");

const ReviewState = Annotation.Root({
    diff: Annotation(),
    target: Annotation({ default: () => "HEAD" }),
    reviewer: Annotation({ default: () => null }),
    tester: Annotation({ default: () => null }),
    docsmith: Annotation({ default: () => null }),
    report: Annotation({ default: () => "" }),
});

function currentDiff(target = "HEAD") {
    try {
        const base = target === "HEAD" ? "HEAD" : target;
        return execFileSync("git", ["diff", base, "--", ":!*lock*", ":!*.lock"], {
            encoding: "utf-8",
            cwd: process.cwd(),
            maxBuffer: 2 * 1024 * 1024,
        });
    } catch (e) {
        return "";
    }
}

async function diffNode(state) {
    const d = state.diff || currentDiff(state.target);
    return { diff: d };
}

function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}

async function reviewerNode(state) {
    if (!state.diff) return { reviewer: "(no diff to review)" };
    const prompt = `You are a senior code reviewer. Focus ONLY on:
- Bugs, null/undefined hazards, off-by-one, race conditions
- Security (injection, secrets, unsafe shell, broken auth)
- Error handling that's missing or wrong
Ignore style nits and formatting.

Respond with a concise markdown bullet list. Cite file:line where possible.
If nothing to report, say "No issues found."

DIFF:
${truncate(state.diff, 12000)}`;
    const out = await llm.ask(prompt, { node: "review.reviewer" });
    return { reviewer: out };
}

async function testerNode(state) {
    if (!state.diff) return { tester: "(no diff)" };
    const prompt = `You are a testing specialist. For the diff below, list:
- Which new / changed functions lack test coverage
- Edge cases a reviewer should specifically verify
- Suggested test names (as \`describe > it\` / function names)

Bullet list, markdown. Keep it under 15 lines.

DIFF:
${truncate(state.diff, 12000)}`;
    const out = await llm.ask(prompt, { node: "review.tester" });
    return { tester: out };
}

async function docsmithNode(state) {
    if (!state.diff) return { docsmith: "(no diff)" };
    const prompt = `You are a documentation auditor. For the diff below, note:
- Public functions / modules missing docstrings
- Existing docs/comments that no longer match the code
- README sections that should be updated (if obvious from the diff)

Bullet list, markdown. Be terse. If nothing applies, say "No doc drift."

DIFF:
${truncate(state.diff, 12000)}`;
    const out = await llm.ask(prompt, { node: "review.docsmith" });
    return { docsmith: out };
}

async function mergerNode(state) {
    const parts = [];
    parts.push(`# Multi-agent review — ${state.target}\n`);
    parts.push(`## 🔍 Reviewer\n${state.reviewer || "_n/a_"}\n`);
    parts.push(`## 🧪 Tester\n${state.tester || "_n/a_"}\n`);
    parts.push(`## 📚 Docsmith\n${state.docsmith || "_n/a_"}\n`);
    return { report: parts.join("\n") };
}

function build() {
    const g = new StateGraph(ReviewState)
        .addNode("fetch_diff", diffNode)
        .addNode("run_reviewer", reviewerNode)
        .addNode("run_tester", testerNode)
        .addNode("run_docsmith", docsmithNode)
        .addNode("merge", mergerNode)
        .addEdge(START, "fetch_diff")
        // Fan-out: diff → three agents in parallel
        .addEdge("fetch_diff", "run_reviewer")
        .addEdge("fetch_diff", "run_tester")
        .addEdge("fetch_diff", "run_docsmith")
        // Fan-in: all three → merge
        .addEdge("run_reviewer", "merge")
        .addEdge("run_tester", "merge")
        .addEdge("run_docsmith", "merge")
        .addEdge("merge", END);
    return g.compile();
}

let compiled = null;
function getGraph() {
    if (!compiled) compiled = build();
    return compiled;
}

async function run({ target = "HEAD", diff = null } = {}) {
    const graph = getGraph();
    const t0 = Date.now();
    const result = await graph.invoke({ target, diff }, { recursionLimit: 10 });
    return { ...result, elapsed_ms: Date.now() - t0 };
}

module.exports = { run, getGraph, currentDiff };
