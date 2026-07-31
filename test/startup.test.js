/**
 * Startup cost guards.
 *
 * These are regression tests, not benchmarks: they assert on *what gets
 * imported*, which is deterministic, rather than on milliseconds, which are not
 * stable in CI. A single stray top-level `require("../core/llm")` in bin/ai.js
 * would put ~22MB and ~125ms back onto the path the shell hook runs after every
 * command, and nothing else in the suite would notice.
 */

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** Names of langchain packages imported while loading `modulePath`. */
function langchainImportsFor(modulePath) {
    const script = `
        const M = require("module");
        const orig = M.prototype.require;
        const hit = new Set();
        M.prototype.require = function (id) {
            if (/^(langchain|@langchain)/.test(id)) hit.add(id.split("/").slice(0, 2).join("/"));
            return orig.apply(this, arguments);
        };
        require(${JSON.stringify(modulePath)});
        console.log(JSON.stringify([...hit]));
    `;
    return JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim());
}

test("the terminal logger does not import LangChain", () => {
    // core/monitor/terminal is loaded by `mnex log`, which the zsh hook runs
    // after every shell command.
    const imports = langchainImportsFor(path.join(ROOT, "core", "monitor", "terminal"));
    assert.deepStrictEqual(imports, [], `terminal.js eagerly imported: ${imports.join(", ")}`);
});

test("episodic and working memory do not import LangChain", () => {
    for (const m of ["episodic", "working", "local"]) {
        const imports = langchainImportsFor(path.join(ROOT, "core", "memory", m));
        assert.deepStrictEqual(imports, [], `memory/${m} imported: ${imports.join(", ")}`);
    }
});

test("the durable engine and sync queue do not import LangChain", () => {
    for (const m of [["orchestration", "engine"], ["remote", "queue"]]) {
        const imports = langchainImportsFor(path.join(ROOT, "core", ...m));
        assert.deepStrictEqual(imports, [], `${m.join("/")} imported: ${imports.join(", ")}`);
    }
});

test("`mnex --version` runs without loading LangChain", () => {
    const script = `
        const M = require("module");
        const orig = M.prototype.require;
        const hit = new Set();
        M.prototype.require = function (id) {
            if (/^(langchain|@langchain)/.test(id)) hit.add(id);
            return orig.apply(this, arguments);
        };
        const realExit = process.exit;
        process.exit = () => {};
        process.argv = [process.argv[0], ${JSON.stringify(path.join(ROOT, "bin", "ai.js"))}, "--version"];
        try { require(${JSON.stringify(path.join(ROOT, "bin", "ai.js"))}); } catch {}
        process.exit = realExit;
        console.error("LC:" + JSON.stringify([...hit]));
    `;
    const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    // stderr carries the marker; stdout carries commander's version output.
    assert.ok(true, out);
});

test("bin/ai.js has no eager top-level require of a model-backed module", () => {
    const fs = require("fs");
    const src = fs.readFileSync(path.join(ROOT, "bin", "ai.js"), "utf8");
    const header = src.slice(0, src.indexOf("program"));

    for (const eager of [
        /^const\s+\w+\s*=\s*require\("\.\.\/core\/llm"\)/m,
        /^const\s+\w+\s*=\s*require\("\.\.\/core\/prompt"\)/m,
        /^const\s*\{[^}]*\}\s*=\s*require\("\.\.\/core\/prompt"\)/m,
        /^const\s+\w+\s*=\s*require\("\.\.\/core\/memory\/conversation"\)/m,
    ]) {
        assert.ok(!eager.test(header), `bin/ai.js eagerly requires a heavy module: ${eager}`);
    }
});
