#!/usr/bin/env node
/**
 * Smoke test — no API key required.
 *
 * Unit tests cover pure logic; this covers the things that only break when the
 * package is assembled: a module that fails to load, a command that vanished
 * from the CLI, a path that points somewhere nothing writes to, or a file that
 * is missing from the published tarball.
 *
 * It deliberately does not call an LLM, so it can run in CI on every push.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "ai.js");

let failures = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg, err) => {
    failures++;
    console.error(`  FAIL ${msg}${err ? `\n         ${String(err).split("\n")[0]}` : ""}`);
};

function check(msg, fn) {
    try {
        fn();
        ok(msg);
    } catch (err) {
        fail(msg, err);
    }
}

// ---------------------------------------------------------------- modules ---
console.log("\nmodule loading");
function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return e.isFile() && p.endsWith(".js") ? [p] : [];
    });
}

const modules = walk(path.join(ROOT, "core"));
let loaded = 0;
for (const m of modules) {
    try {
        require(m);
        loaded++;
    } catch (err) {
        fail(`require ${path.relative(ROOT, m)}`, err);
    }
}
if (loaded === modules.length) ok(`all ${loaded} core modules require cleanly`);

// -------------------------------------------------------------------- CLI ---
console.log("\nCLI");
function runCli(args) {
    return execFileSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
    });
}

let helpText = "";
check("`mnex --help` exits cleanly", () => {
    helpText = runCli(["--help"]);
    if (!/Usage: mnex/.test(helpText)) throw new Error("unexpected help output");
});

check("`mnex --version` matches package.json", () => {
    const v = runCli(["--version"]).trim();
    const expected = require(path.join(ROOT, "package.json")).version;
    if (v !== expected) throw new Error(`CLI reports ${v}, package.json says ${expected}`);
});

// Commands the README documents. If one is renamed or dropped, the docs go
// stale silently — this turns that into a build failure.
const DOCUMENTED = [
    "ask", "graph", "profile", "review", "github", "eval", "suggest", "stats",
    "plugin", "workflow", "worker", "remember", "task", "memory", "status", "history",
    "watch", "errors", "focus", "sync", "handoff", "service", "journal",
    "projects", "decide", "learned", "snippet", "remind", "knowledge", "init",
];
check(`all ${DOCUMENTED.length} documented commands are registered`, () => {
    const missing = DOCUMENTED.filter((c) => !new RegExp(`^\\s+${c}[\\s|]`, "m").test(helpText));
    if (missing.length) throw new Error(`missing from --help: ${missing.join(", ")}`);
});

check("`mnex --help` for a subcommand parses", () => {
    const out = runCli(["workflow", "--help"]);
    if (!/list|resume|prune/.test(out)) throw new Error("workflow help missing subcommands");
});

// ------------------------------------------------------------------ paths ---
console.log("\npaths");
const paths = require(path.join(ROOT, "core", "paths"));
check("no canonical path still points at the pre-rename location", () => {
    const bad = [paths.CONFIG_DIR, paths.ENV_FILE, paths.PLUGIN_DIR, paths.HOME_ENV_FILE, paths.PLIST_NAME]
        .filter((p) => String(p).includes("ai-agent"));
    if (bad.length) throw new Error(`still legacy: ${bad.join(", ")}`);
});

check("the CLI's env search order includes what `mnex init` writes", () => {
    if (!paths.envCandidates().includes(paths.ENV_FILE)) {
        throw new Error("init target is not in the CLI env search order");
    }
});

// -------------------------------------------------------- durable engine ---
console.log("\ndurable orchestration");
const os = require("os");
const engine = require(path.join(ROOT, "core", "orchestration", "engine"));
const smokeDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnex-smoke-")), "wf.db");

check("a run persists, replays cached steps and resumes", () => {
    const run = engine.startRun("smoke", {}, { dbPath: smokeDb });
    let calls = 0;
    const body = async () => { calls++; return "v"; };

    return Promise.resolve()
        .then(() => engine.runStep(run.runId, "s", body, { dbPath: smokeDb }))
        .then(() => engine.runStep(run.runId, "s", body, { dbPath: smokeDb }))
        .then((second) => {
            if (calls !== 1) throw new Error(`step ran ${calls} times, expected 1`);
            if (!second.cached) throw new Error("second call was not served from the step log");
            engine.close();
        });
});

// ------------------------------------------------------------- packaging ---
console.log("\npackaging");
const pkg = require(path.join(ROOT, "package.json"));
check("every runtime directory is in the `files` allowlist", () => {
    const needed = ["core/", "bin/", "config/", "scripts/"];
    const missing = needed.filter((d) => !pkg.files.includes(d));
    if (missing.length) throw new Error(`would not be published: ${missing.join(", ")}`);
});

check("no source file is an empty stub", () => {
    const empties = walk(path.join(ROOT, "core")).filter((f) => fs.statSync(f).size === 0);
    if (empties.length) {
        throw new Error(`empty modules: ${empties.map((f) => path.relative(ROOT, f)).join(", ")}`);
    }
});

check("declared engines are compatible with the installed deps", () => {
    const chokidarPkg = JSON.parse(
        fs.readFileSync(path.join(ROOT, "node_modules", "chokidar", "package.json"), "utf8")
    );
    if (chokidarPkg.type === "module") {
        throw new Error("chokidar is ESM-only; require() will fail on the declared Node range");
    }
});

check("the optional Temporal SDK has not become a hard dependency", () => {
    // @temporalio/* needs Node >=20.3 while this package advertises >=18.
    const hard = Object.keys(pkg.dependencies).filter((d) => d.startsWith("@temporalio"));
    if (hard.length) throw new Error(`must stay optional: ${hard.join(", ")}`);
    if (pkg.engines.node !== ">=18.0.0") {
        throw new Error(`engine floor changed to ${pkg.engines.node}`);
    }
});

// ----------------------------------------------------------------- result ---
console.log("");
if (failures) {
    console.error(`smoke test FAILED (${failures} problem${failures > 1 ? "s" : ""})\n`);
    process.exit(1);
}
console.log("smoke test passed\n");
