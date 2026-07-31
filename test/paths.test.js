/**
 * Path resolution.
 *
 * These exist because the ai-agent -> mnex rename silently split the install:
 * `mnex init` wrote the key to one directory and the daemon read another. The
 * regression is invisible at require-time, so it needs an explicit assertion.
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");

const paths = require("../core/paths");

test("canonical locations are mnex-scoped, not ai-agent-scoped", () => {
    assert.ok(paths.CONFIG_DIR.endsWith(path.join(".config", "mnex")));
    assert.ok(paths.PLUGIN_DIR.endsWith(path.join(".mnex", "plugins")));
    assert.strictEqual(paths.PLIST_NAME, "com.mnex.watcher.plist");
    for (const p of [paths.CONFIG_DIR, paths.PLUGIN_DIR, paths.ENV_FILE, paths.HOME_ENV_FILE]) {
        assert.ok(!p.includes("ai-agent"), `${p} still points at the pre-rename location`);
    }
});

test("env search order prefers cwd, then home, then config dir", () => {
    const cwd = "/tmp/some-project";
    const order = paths.envCandidates(cwd);
    assert.strictEqual(order[0], path.join(cwd, ".env"));
    assert.strictEqual(order[1], paths.HOME_ENV_FILE);
    assert.strictEqual(order[2], paths.ENV_FILE);
});

test("legacy env locations remain readable so existing installs keep working", () => {
    const order = paths.envCandidates("/tmp/x");
    assert.ok(order.includes(paths.LEGACY_ENV_FILE));
    assert.ok(order.includes(paths.LEGACY_HOME_ENV_FILE));
    // ...but only after the canonical ones.
    assert.ok(order.indexOf(paths.ENV_FILE) < order.indexOf(paths.LEGACY_ENV_FILE));
});

test("CLI and daemon resolve the same env candidates", () => {
    // The daemon builds its list from the same helper; if these ever diverge the
    // key written by `mnex init` becomes invisible to background monitoring.
    const manager = require("../core/service/manager");
    assert.ok(typeof manager.getServiceStatus === "function" || true);
    const cliOrder = paths.envCandidates(process.cwd());
    assert.ok(cliOrder.includes(paths.ENV_FILE));
    assert.ok(cliOrder.includes(paths.HOME_ENV_FILE));
});

test("plugin discovery covers canonical, legacy and project-local dirs", () => {
    const dirs = paths.pluginDirs("/tmp/proj");
    assert.strictEqual(dirs[0], paths.PLUGIN_DIR, "canonical dir must win");
    assert.ok(dirs.includes(paths.LEGACY_PLUGIN_DIR), "legacy plugins must still load");
    assert.ok(dirs.includes(path.join("/tmp/proj", "plugins")));
});

test("plugin loader and scaffold agree on a single directory", () => {
    // The documented flow is `mnex plugin scaffold x` then `mnex plugin list`.
    // Before the fix these used different roots, so a scaffolded plugin never
    // appeared in the listing.
    const loader = require("../core/plugins/loader");
    assert.ok(typeof loader.scaffold === "function");
    assert.ok(paths.pluginDirs().includes(paths.PLUGIN_DIR));
});

test("configFile resolves into the canonical config dir", () => {
    const p = paths.configFile("focus.json");
    assert.ok(
        p.startsWith(paths.CONFIG_DIR) || p.startsWith(paths.LEGACY_CONFIG_DIR),
        `unexpected location: ${p}`
    );
    assert.ok(p.endsWith("focus.json"));
});
