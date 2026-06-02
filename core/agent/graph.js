/**
 * LangGraph Agent with Critic Loop
 *
 *        ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐
 *        │  recall  │ →  │ planner  │ →  │ executor │ →  │  critic  │ →  │ synthesizer  │
 *        └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────────┘
 *                              ▲                              │
 *                              └───────── retry (if weak) ────┘
 *
 * State machine:
 *   - recall       — load memory (episodic + working + semantic + causal)
 *   - planner      — LLM picks tool calls OR declares "enough context"
 *   - executor     — run tool calls, append observations
 *   - critic       — LLM scores draft; loops back with new plan if < threshold
 *   - synthesizer  — produce final streaming answer
 */

const { StateGraph, END, START, Annotation } = require("@langchain/langgraph");
const llm = require("../llm");
const memory = require("../memory");
const tools = require("./tools");
const obs = require("../obs/tracker");
const router = require("../llm/router");
const preferences = require("./preferences");

const MAX_ITERATIONS = 3;
const CRITIC_THRESHOLD = 7; // 1..10

const AgentState = Annotation.Root({
    question: Annotation(),
    project: Annotation(),
    context: Annotation(),
    recalled: Annotation(),
    plan: Annotation({ default: () => ({ tool_calls: [], reasoning: "" }) }),
    observations: Annotation({ reducer: (a, b) => [...(a || []), ...(b || [])], default: () => [] }),
    draft: Annotation({ default: () => "" }),
    critique: Annotation({ default: () => ({ score: 0, reasoning: "", needs: [] }) }),
    iterations: Annotation({ reducer: (a, b) => (b ?? a), default: () => 0 }),
    final: Annotation({ default: () => "" }),
    route: Annotation({ default: () => "cloud" }),
    trace: Annotation({ reducer: (a, b) => [...(a || []), ...(b || [])], default: () => [] }),
});

// ─────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────

async function recallNode(state) {
    const recalled = await memory.recall(state.project, state.question);
    return { recalled, trace: [{ node: "recall", ts: Date.now(), info: `loaded ${recalled.episodic?.length || 0} events` }] };
}

async function plannerNode(state) {
    const prevObs = (state.observations || [])
        .map((o) => `- [${o.tool}] ${truncate(o.result, 400)}`)
        .join("\n");
    const memoryDigest = [
        state.recalled?.episodicText ? "Recent activity:\n" + state.recalled.episodicText : "",
        state.recalled?.workingText ? "Working context:\n" + state.recalled.workingText : "",
        state.recalled?.localText ? "Memory:\n" + state.recalled.localText : "",
    ].filter(Boolean).join("\n\n");

    const fewshot = preferences.fewShotBlock();

    const prompt = `You are the PLANNER node of an agent. Decide whether to call tools or declare the context is sufficient.

## Available tools
${tools.describeAll()}

## Memory summary
${memoryDigest || "(empty)"}

## Observations so far (iteration ${state.iterations || 0}/${MAX_ITERATIONS})
${prevObs || "(none)"}

## Prior feedback from user
${fewshot || "(none)"}

## User question
${state.question}

Respond with strict JSON, no markdown:
{
  "reasoning": "one short sentence",
  "tool_calls": [ { "tool": "name", "args": { ... } } ],
  "done": false
}

Set "done": true and "tool_calls": [] if you have enough context to answer.
Call at most 3 tools at a time. Prefer smaller, targeted calls.`;

    const raw = await llm.ask(prompt, { node: "agent.planner" });
    let plan = { reasoning: "(parse failed)", tool_calls: [], done: true };
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) plan = JSON.parse(m[0]);
    } catch { /* keep default */ }

    return {
        plan,
        iterations: (state.iterations || 0) + 1,
        trace: [{ node: "planner", ts: Date.now(), reasoning: plan.reasoning, tools: (plan.tool_calls || []).map((c) => c.tool) }],
    };
}

async function executorNode(state) {
    const calls = state.plan?.tool_calls || [];
    const observations = [];
    for (const call of calls) {
        const out = await tools.execute(call);
        observations.push({
            tool: call.tool,
            args: call.args,
            ok: !!out.ok,
            result: out.ok ? String(out.result).slice(0, 4000) : `ERROR: ${out.error}`,
        });
    }
    return {
        observations,
        trace: [{ node: "executor", ts: Date.now(), ran: observations.length }],
    };
}

async function synthesizerNode(state) {
    const obsText = (state.observations || [])
        .map((o) => `### ${o.tool}\n${o.result}`)
        .join("\n\n");

    const memoryDigest = [
        state.recalled?.episodicText,
        state.recalled?.workingText,
        state.recalled?.localText,
        state.recalled?.semanticText,
    ].filter(Boolean).join("\n\n");

    const prompt = `You are answering the user's question using all the context below.
Cite specific files, commands, or commits where relevant. Be concise and direct.

## User question
${state.question}

## Memory
${memoryDigest || "(empty)"}

## Tool observations
${obsText || "(none)"}

## Answer`;

    const answer = await llm.ask(prompt, { node: "agent.synthesizer" });
    return {
        draft: answer,
        final: answer,
        trace: [{ node: "synthesizer", ts: Date.now() }],
    };
}

async function criticNode(state) {
    // Skip the LLM critique call if we've already hit max iterations
    if ((state.iterations || 0) >= MAX_ITERATIONS) {
        return {
            critique: { score: 10, reasoning: "max iterations reached, accepting", needs: [] },
            trace: [{ node: "critic", ts: Date.now(), score: 10, forced: true }],
        };
    }

    const prompt = `You are the CRITIC node. Score the draft answer 1–10 for how well it addresses the user's question given the observations. If < ${CRITIC_THRESHOLD}, list what's missing.

## Question
${state.question}

## Draft answer
${state.draft}

## Observations used
${(state.observations || []).slice(-5).map((o) => `- ${o.tool}: ${truncate(o.result, 200)}`).join("\n")}

Respond with strict JSON, no markdown:
{
  "score": 1-10,
  "reasoning": "one short sentence",
  "needs": ["what to fetch or verify next"]
}`;

    const raw = await llm.ask(prompt, { node: "agent.critic" });
    let critique = { score: 10, reasoning: "critic parse failed", needs: [] };
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) critique = JSON.parse(m[0]);
    } catch { /* keep lenient default */ }

    return {
        critique,
        trace: [{ node: "critic", ts: Date.now(), score: critique.score }],
    };
}

// ─────────────────────────────────────────────────────────────
// Edges / routing logic
// ─────────────────────────────────────────────────────────────

function afterPlanner(state) {
    if (state.plan?.done || !(state.plan?.tool_calls?.length)) {
        return "synthesize";
    }
    return "execute";
}

function afterCritic(state) {
    if ((state.critique?.score || 0) >= CRITIC_THRESHOLD) return END;
    if ((state.iterations || 0) >= MAX_ITERATIONS) return END;
    return "planner";
}

// ─────────────────────────────────────────────────────────────
// Graph builder
// ─────────────────────────────────────────────────────────────

function buildGraph() {
    const g = new StateGraph(AgentState)
        .addNode("recall", recallNode)
        .addNode("planner", plannerNode)
        .addNode("execute", executorNode)
        .addNode("synthesize", synthesizerNode)
        .addNode("critic", criticNode)
        .addEdge(START, "recall")
        .addEdge("recall", "planner")
        .addConditionalEdges("planner", afterPlanner, {
            execute: "execute",
            synthesize: "synthesize",
        })
        .addEdge("execute", "planner")
        .addEdge("synthesize", "critic")
        .addConditionalEdges("critic", afterCritic, {
            planner: "planner",
            [END]: END,
        });

    return g.compile();
}

let compiled = null;
function getGraph() {
    if (!compiled) compiled = buildGraph();
    return compiled;
}

/**
 * Run the agent on a question.
 * @param {Object} opts { question, project, context }
 */
async function run({ question, project = null, context = {} }) {
    const graph = getGraph();
    const t0 = Date.now();
    const initial = { question, project, context };

    try {
        const result = await graph.invoke(initial, { recursionLimit: 25 });
        obs.record({
            provider: "agent",
            model: "langgraph",
            route: "agent",
            project,
            question,
            latency_ms: Date.now() - t0,
            success: true,
            node: "graph.run",
        });
        return result;
    } catch (error) {
        obs.record({
            provider: "agent",
            model: "langgraph",
            route: "agent",
            project,
            question,
            latency_ms: Date.now() - t0,
            success: false,
            error: error.message,
            node: "graph.run",
        });
        throw error;
    }
}

/**
 * Render the graph execution trace for debugging.
 */
function renderTrace(result) {
    const lines = ["─── Agent trace ───"];
    for (const t of result.trace || []) {
        const extras = Object.entries(t)
            .filter(([k]) => !["node", "ts"].includes(k))
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
            .join(" ");
        lines.push(`  ${t.node.padEnd(12)} ${extras}`);
    }
    lines.push(`  iterations: ${result.iterations}`);
    lines.push(`  critic score: ${result.critique?.score ?? "n/a"}`);
    return lines.join("\n");
}

function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n) + "…" : s;
}

module.exports = { run, getGraph, renderTrace };
