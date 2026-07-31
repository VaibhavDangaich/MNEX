/**
 * File-watcher ignore rules.
 *
 * chokidar v4 dropped glob support in `ignored`, which silently turned every
 * "**\/node_modules\/**" pattern into a literal that never matches. The watcher
 * then walked into node_modules on every project. The end-to-end case at the
 * bottom is the one that actually catches that class of regression.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { isIgnored } = require("../core/monitor/filewatcher");

test("build artefacts and vendor directories are ignored", () => {
    const ignored = [
        "/p/node_modules/react/index.js",
        "/p/.git/HEAD",
        "/p/dist/bundle.js",
        "/p/build/out.o",
        "/p/coverage/lcov.info",
        "/p/.next/cache/x",
        "/p/venv/lib/python3/site.py",
        "/p/__pycache__/mod.pyc",
        "/p/nested/deep/node_modules/x/y.js",
    ];
    for (const p of ignored) assert.ok(isIgnored(p), `should ignore ${p}`);
});

test("noisy files are ignored", () => {
    for (const p of ["/p/app.log", "/p/.DS_Store", "/p/package-lock.json", "/p/yarn.lock"]) {
        assert.ok(isIgnored(p), `should ignore ${p}`);
    }
});

test("source files are not ignored", () => {
    const kept = [
        "/p/src/index.js",
        "/p/lib/util.ts",
        "/p/main.py",
        "/p/README.md",
        "/p/src/components/Button.tsx",
    ];
    for (const p of kept) assert.ok(!isIgnored(p), `should NOT ignore ${p}`);
});

test("ignore matches whole path segments, not substrings", () => {
    // A naive `path.includes("env")` would wrongly drop all of these.
    const kept = [
        "/p/src/env.js",
        "/p/src/environment.ts",
        "/p/src/nodemodules.js",
        "/p/distance.js",
        "/p/src/building.js",
        "/p/target_practice.md",
    ];
    for (const p of kept) assert.ok(!isIgnored(p), `should NOT ignore ${p}`);
});

test("windows-style separators are handled", () => {
    assert.ok(isIgnored("C:\\proj\\node_modules\\x\\y.js"));
    assert.ok(!isIgnored("C:\\proj\\src\\app.js"));
});

test("chokidar honours the predicate and skips node_modules end to end", async () => {
    const chokidar = require("chokidar");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnex-watch-"));
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "//");
    fs.writeFileSync(path.join(root, "src", "app.js"), "//");

    const seen = [];
    const watcher = chokidar.watch(root, { ignored: isIgnored, ignoreInitial: false });
    watcher.on("add", (p) => seen.push(p));

    await new Promise((r) => setTimeout(r, 900));
    await watcher.close();

    const inNodeModules = seen.filter((p) => p.includes("node_modules"));
    assert.strictEqual(inNodeModules.length, 0, `watched node_modules: ${inNodeModules.join(", ")}`);
    assert.ok(seen.some((p) => p.endsWith("app.js")), "real source files must still be watched");

    fs.rmSync(root, { recursive: true, force: true });
});

test("chokidar is require()-able from CommonJS on the declared engine range", () => {
    // chokidar@5 is ESM-only and needs Node >=20.19; requiring it from this
    // CommonJS package breaks on the Node 18 that package.json advertises.
    // chokidar 4 does not list ./package.json in its exports map, so read it
    // from disk rather than through the resolver.
    const pkgPath = path.join(__dirname, "..", "node_modules", "chokidar", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    assert.ok(pkg.version.startsWith("4."), `expected chokidar 4.x, got ${pkg.version}`);
    assert.ok(pkg.exports["."].require, "chokidar must expose a CommonJS entry point");
    assert.strictEqual(pkg.type, undefined, "chokidar 4 must not be an ESM-only package");
    assert.doesNotThrow(() => require("chokidar"));
});
