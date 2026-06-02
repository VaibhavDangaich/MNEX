/**
 * Eval Harness
 *
 * Goals:
 *  1. Run a suite of (question, expectation) cases against the agent
 *  2. Assert tool usage, content matching, latency, and cost
 *  3. Diff against a stored baseline so regressions are visible
 *
 * Baseline is a snapshot of the last `ai eval baseline` run.
 */

const fs = require("fs");
const path = require("path");

const CASES_FILE = path.join(__dirname, "cases.json");
const BASELINE_FILE = path.join(__dirname, "baseline.json");

function loadCases() {
    return JSON.parse(fs.readFileSync(CASES_FILE, "utf-8")).cases;
}

function loadBaseline() {
    if (!fs.existsSync(BASELINE_FILE)) return null;
    try { return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8")); } catch { return null; }
}

function saveBaseline(results) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(results, null, 2));
}

function addCase(question, expect) {
    const raw = JSON.parse(fs.readFileSync(CASES_FILE, "utf-8"));
    const id = "case-" + (raw.cases.length + 1);
    raw.cases.push({ id, question, expect: expect || { min_length: 10 } });
    fs.writeFileSync(CASES_FILE, JSON.stringify(raw, null, 2));
    return id;
}

function assertCase(caseDef, result) {
    const answer = result.final || result.draft || "";
    const toolsUsed = (result.observations || []).map((o) => o.tool);
    const e = caseDef.expect || {};
    const failures = [];

    if (e.min_length && answer.length < e.min_length) {
        failures.push(`answer length ${answer.length} < min ${e.min_length}`);
    }
    if (e.contains_all) {
        for (const k of e.contains_all) {
            if (!answer.includes(k)) failures.push(`missing keyword "${k}"`);
        }
    }
    if (e.contains_any) {
        const any = e.contains_any.some((k) => answer.includes(k));
        if (!any) failures.push(`answer missing any of [${e.contains_any.join(", ")}]`);
    }
    if (e.contains_any_ci) {
        const any = e.contains_any_ci.some((k) => answer.toLowerCase().includes(k.toLowerCase()));
        if (!any) failures.push(`answer (ci) missing any of [${e.contains_any_ci.join(", ")}]`);
    }
    if (e.tool_called_any) {
        const any = e.tool_called_any.some((t) => toolsUsed.includes(t));
        if (!any) failures.push(`no tool in [${e.tool_called_any.join(", ")}] was called (used: ${toolsUsed.join(", ") || "none"})`);
    }
    if (e.max_latency_ms && result.latency_ms > e.max_latency_ms) {
        failures.push(`latency ${result.latency_ms}ms > max ${e.max_latency_ms}ms`);
    }

    return { pass: failures.length === 0, failures, toolsUsed };
}

async function runCase(caseDef, { project = null } = {}) {
    const agent = require("../agent/graph");
    const t0 = Date.now();
    let result;
    try {
        result = await agent.run({ question: caseDef.question, project });
    } catch (e) {
        return {
            id: caseDef.id,
            question: caseDef.question,
            pass: false,
            failures: [`agent threw: ${e.message}`],
            answer: "",
            toolsUsed: [],
            latency_ms: Date.now() - t0,
            critic_score: null,
            iterations: 0,
        };
    }
    const latency_ms = Date.now() - t0;
    const verdict = assertCase(caseDef, { ...result, latency_ms });
    return {
        id: caseDef.id,
        question: caseDef.question,
        pass: verdict.pass,
        failures: verdict.failures,
        answer: (result.final || result.draft || "").slice(0, 1200),
        toolsUsed: verdict.toolsUsed,
        latency_ms,
        critic_score: result.critique?.score ?? null,
        iterations: result.iterations || 0,
    };
}

async function runSuite({ project = null, cases = null } = {}) {
    const toRun = cases || loadCases();
    const results = [];
    for (const c of toRun) {
        process.stdout.write(`• ${c.id} … `);
        const r = await runCase(c, { project });
        results.push(r);
        process.stdout.write(r.pass ? "PASS" : "FAIL");
        if (!r.pass) process.stdout.write(` — ${r.failures.join("; ")}`);
        process.stdout.write(`  (${r.latency_ms}ms, crit=${r.critic_score ?? "?"})\n`);
    }
    const summary = {
        total: results.length,
        passed: results.filter((r) => r.pass).length,
        failed: results.filter((r) => !r.pass).length,
        avg_latency: Math.round(
            results.reduce((a, b) => a + b.latency_ms, 0) / (results.length || 1)
        ),
        avg_critic: (
            results.map((r) => r.critic_score).filter(Boolean).reduce((a, b) => a + b, 0) /
            (results.filter((r) => r.critic_score).length || 1)
        ).toFixed(2),
        ts: new Date().toISOString(),
    };
    return { summary, results };
}

function diffBaseline(current, baseline) {
    if (!baseline) return { regressions: [], improvements: [], note: "no baseline stored" };
    const bById = Object.fromEntries((baseline.results || []).map((r) => [r.id, r]));
    const regressions = [];
    const improvements = [];
    for (const r of current.results) {
        const b = bById[r.id];
        if (!b) continue;
        if (b.pass && !r.pass) regressions.push({ id: r.id, was: "PASS", now: "FAIL", failures: r.failures });
        if (!b.pass && r.pass) improvements.push({ id: r.id, was: "FAIL", now: "PASS" });
        if (b.pass && r.pass && r.latency_ms > b.latency_ms * 1.5) {
            regressions.push({ id: r.id, note: `latency regressed ${b.latency_ms}→${r.latency_ms}ms` });
        }
    }
    return { regressions, improvements };
}

function formatReport({ summary, results }, diff = null) {
    const lines = [];
    lines.push(`\n═══ Eval report — ${summary.ts} ═══`);
    lines.push(`Passed: ${summary.passed}/${summary.total}   Failed: ${summary.failed}`);
    lines.push(`Avg latency: ${summary.avg_latency}ms   Avg critic: ${summary.avg_critic}`);
    if (diff) {
        if (diff.regressions?.length) {
            lines.push(`\nRegressions:`);
            for (const r of diff.regressions) lines.push(`  ✗ ${r.id}: ${r.failures?.join("; ") || r.note}`);
        }
        if (diff.improvements?.length) {
            lines.push(`\nImprovements:`);
            for (const r of diff.improvements) lines.push(`  ✓ ${r.id}: now passing`);
        }
        if (!diff.regressions?.length && !diff.improvements?.length) {
            lines.push(`\n(no changes vs baseline)`);
        }
    }
    return lines.join("\n");
}

module.exports = {
    loadCases, addCase, loadBaseline, saveBaseline,
    runCase, runSuite, diffBaseline, formatReport, assertCase,
};
