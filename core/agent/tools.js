/**
 * Agent Tools
 *
 * Each tool is a simple {name, description, schema, run(args)} object.
 * The planner node picks tool calls from this list.
 * Tools MUST be fast, side-effect-free (read-only by default), and safe.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const MAX_FILE_BYTES = 200 * 1024;

function safeRun(args, fn) {
    try {
        return { ok: true, result: fn() };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

const tools = {
    read_file: {
        name: "read_file",
        description: "Read the contents of a file. Args: { path: string, maxBytes?: number }",
        run({ path: p, maxBytes = MAX_FILE_BYTES }) {
            return safeRun({ p }, () => {
                const resolved = path.resolve(process.cwd(), p);
                const stat = fs.statSync(resolved);
                if (stat.size > maxBytes) {
                    const buf = Buffer.alloc(maxBytes);
                    const fd = fs.openSync(resolved, "r");
                    fs.readSync(fd, buf, 0, maxBytes, 0);
                    fs.closeSync(fd);
                    return `${buf.toString("utf-8")}\n…(truncated, ${stat.size} bytes total)`;
                }
                return fs.readFileSync(resolved, "utf-8");
            });
        },
    },

    list_files: {
        name: "list_files",
        description: "List files in a directory. Args: { dir?: string, pattern?: string }",
        run({ dir = ".", pattern = null } = {}) {
            return safeRun({}, () => {
                const resolved = path.resolve(process.cwd(), dir);
                const entries = fs.readdirSync(resolved, { withFileTypes: true });
                let names = entries
                    .filter((e) => !e.name.startsWith("."))
                    .map((e) => (e.isDirectory() ? e.name + "/" : e.name));
                if (pattern) {
                    const re = new RegExp(pattern);
                    names = names.filter((n) => re.test(n));
                }
                return names.slice(0, 200).join("\n");
            });
        },
    },

    grep: {
        name: "grep",
        description: "Search code for a pattern. Args: { pattern: string, dir?: string }",
        run({ pattern, dir = "." } = {}) {
            return safeRun({}, () => {
                const r = spawnSync(
                    "grep",
                    ["-rn", "--include=*.{js,ts,jsx,tsx,py,go,rs,java,md,json}",
                     "--exclude-dir=node_modules", "--exclude-dir=.git",
                     "-m", "50", pattern, path.resolve(process.cwd(), dir)],
                    { encoding: "utf-8", timeout: 5000, maxBuffer: 512 * 1024 }
                );
                if (r.status !== 0 && !r.stdout) return "No matches.";
                return (r.stdout || "").split("\n").slice(0, 60).join("\n");
            });
        },
    },

    git_log: {
        name: "git_log",
        description: "Show recent git commits. Args: { n?: number }",
        run({ n = 10 } = {}) {
            return safeRun({}, () =>
                execFileSync("git", ["log", `-n${n}`, "--oneline", "--no-color"], {
                    encoding: "utf-8", cwd: process.cwd(),
                }).trim()
            );
        },
    },

    git_diff: {
        name: "git_diff",
        description: "Show uncommitted changes. Args: { staged?: boolean }",
        run({ staged = false } = {}) {
            return safeRun({}, () =>
                execFileSync("git", ["diff", staged ? "--staged" : "HEAD", "--stat"], {
                    encoding: "utf-8", cwd: process.cwd(), maxBuffer: 512 * 1024,
                })
            );
        },
    },

    query_memory: {
        name: "query_memory",
        description: "Search the local memory graph for related past work. Args: { query: string }",
        run({ query }) {
            return safeRun({}, () => {
                const causal = require("../memory/causal");
                const rows = causal.search(query, { limit: 15 });
                if (!rows.length) return "No matches in work history.";
                return rows
                    .map((r) => `[${r.type}] ${r.label} (${r.ts.slice(0, 16)})`)
                    .join("\n");
            });
        },
    },

    recent_activity: {
        name: "recent_activity",
        description: "Recent commands and file edits across projects. Args: { minutes?: number }",
        async run({ minutes = 60 } = {}) {
            const episodic = require("../memory/episodic");
            const events = await episodic.getLastMinutes(minutes);
            if (!events.length) return { ok: true, result: "No recent activity." };
            const lines = events.slice(0, 30).map((e) => {
                if (e.type === "terminal") return `[cmd] ${e.command}`;
                if (e.type === "editor") return `[edit] ${e.action} ${e.file}`;
                return `[${e.type}]`;
            });
            return { ok: true, result: lines.join("\n") };
        },
    },
};

function allTools() {
    try {
        const plugins = require("../plugins/loader");
        return { ...tools, ...plugins.pluginTools() };
    } catch {
        return tools;
    }
}

function describeAll() {
    return Object.values(allTools())
        .map((t) => `- ${t.name}: ${t.description}`)
        .join("\n");
}

async function execute(call) {
    const all = allTools();
    const t = all[call.tool];
    if (!t) return { ok: false, error: `Unknown tool: ${call.tool}` };
    try {
        const out = await t.run(call.args || {});
        // Plugin tools may return either raw or {ok, result}
        if (out && typeof out === "object" && "ok" in out) return out;
        return { ok: true, result: out };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = { tools, allTools, describeAll, execute };
