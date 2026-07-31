/**
 * Temporal backend.
 *
 * Everything here runs without a Temporal server. The one test that genuinely
 * needs a cluster is skipped unless MNEX_TEMPORAL_ADDRESS is set, so CI stays
 * green without provisioning one. The full crash-resume proof lives in
 * scripts/verify/temporal-resume.js, which is run manually against a dev server.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const adapter = require("../core/orchestration/temporal/adapter");
const registry = require("../core/orchestration/activities");

const ROOT = path.join(__dirname, "..");

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try { return fn(); }
    finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

// ------------------------------------------------------------ selection ---

test("embedded is the default backend", () => {
    withEnv({ MNEX_ORCHESTRATOR: undefined }, () => {
        assert.strictEqual(adapter.isEnabled(), false);
        assert.strictEqual(require("../core/orchestration").backendName(), "embedded");
    });
});

test("temporal is selected only by explicit opt-in", () => {
    withEnv({ MNEX_ORCHESTRATOR: "temporal" }, () => {
        assert.strictEqual(adapter.isEnabled(), true);
        assert.strictEqual(require("../core/orchestration").backendName(), "temporal");
    });
    withEnv({ MNEX_ORCHESTRATOR: "TEMPORAL" }, () => {
        assert.strictEqual(adapter.isEnabled(), true, "selection is case-insensitive");
    });
    for (const v of ["embedded", "", "temporal-ish", "1"]) {
        withEnv({ MNEX_ORCHESTRATOR: v }, () => assert.strictEqual(adapter.isEnabled(), false));
    }
});

test("connection settings default sensibly and are overridable", () => {
    withEnv({
        MNEX_TEMPORAL_ADDRESS: undefined,
        MNEX_TEMPORAL_NAMESPACE: undefined,
        MNEX_TEMPORAL_TASK_QUEUE: undefined,
    }, () => {
        assert.deepStrictEqual(adapter.settings(), adapter.DEFAULTS);
    });

    withEnv({
        MNEX_TEMPORAL_ADDRESS: "temporal.internal:7233",
        MNEX_TEMPORAL_NAMESPACE: "prod",
        MNEX_TEMPORAL_TASK_QUEUE: "mnex-prod",
    }, () => {
        assert.deepStrictEqual(adapter.settings(), {
            address: "temporal.internal:7233",
            namespace: "prod",
            taskQueue: "mnex-prod",
        });
    });
});

test("a missing SDK produces an actionable message, not MODULE_NOT_FOUND", () => {
    if (adapter.isAvailable()) {
        assert.doesNotThrow(() => adapter.assertAvailable());
        return;
    }
    assert.throws(() => adapter.assertAvailable(), (err) => {
        assert.match(err.message, /npm i @temporalio/);
        assert.match(err.message, /embedded/);
        return true;
    });
});

// ------------------------------------------------------- activity registry ---

test("activities resolve by name and unknown names fail loudly", () => {
    assert.strictEqual(typeof registry.resolve("indexRepo"), "function");
    assert.strictEqual(typeof registry.resolve("listRepos"), "function");
    assert.strictEqual(typeof registry.resolve("echo"), "function");

    assert.throws(() => registry.resolve("nope"), /Unknown activity "nope"/);
    assert.throws(() => registry.resolve("nope"), /Registered:/);
});

test("the echo activity round-trips its input", async () => {
    assert.deepStrictEqual(await registry.activities.echo({ value: 7 }), { echoed: 7 });
});

test("both backends can express the same unit descriptor", () => {
    // A unit must be portable: name + activity name + JSON input, no closure.
    const unit = { name: "repo:acme/x", activity: "indexRepo", input: { owner: "acme", repo: "x" } };
    assert.strictEqual(typeof registry.resolve(unit.activity), "function");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(unit)), unit, "unit must be serialisable");
});

// ---------------------------------------------------------------- safety ---

test("credentials are never part of a workflow input descriptor", () => {
    // Temporal persists workflow history; a token in workflow args would be
    // written to the Temporal datastore in the clear.
    const src = fs.readFileSync(
        path.join(ROOT, "core", "orchestration", "temporal", "workflows.js"), "utf8"
    );
    for (const secret of ["githubToken", "supermemoryKey", "apiKey", "GITHUB_TOKEN"]) {
        assert.ok(!src.includes(secret), `workflow code references a credential: ${secret}`);
    }
});

test("workflow code imports nothing that performs I/O", () => {
    // Temporal workflows are replayed deterministically. Requiring anything that
    // touches the network, filesystem or clock breaks replay.
    const raw = fs.readFileSync(
        path.join(ROOT, "core", "orchestration", "temporal", "workflows.js"), "utf8"
    );
    // Strip comments first — the file documents these constructs in order to
    // warn against them, and matching the prose would be a false positive.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    const requires = [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(requires, ["@temporalio/workflow"],
        `workflow file must only import @temporalio/workflow, found: ${requires.join(", ")}`);

    for (const banned of ["Date.now(", "Math.random(", 'require("fs")', "fetch("]) {
        assert.ok(!src.includes(banned), `non-deterministic construct in workflow: ${banned}`);
    }
});

test("GitHub 4xx errors are typed so Temporal treats them as non-retryable", () => {
    const src = fs.readFileSync(path.join(ROOT, "core", "integrations", "github.js"), "utf8");
    assert.ok(src.includes("NonRetryableGitHubError"));

    const wf = fs.readFileSync(
        path.join(ROOT, "core", "orchestration", "temporal", "workflows.js"), "utf8"
    );
    assert.ok(wf.includes("nonRetryableErrorTypes"), "retry policy must classify them");
    assert.ok(wf.includes("NonRetryableGitHubError"), "names must match the thrower");
});

// ------------------------------------------------------------- packaging ---

test("the Temporal SDK is optional, never a hard dependency", () => {
    const pkg = require(path.join(ROOT, "package.json"));
    const hard = Object.keys(pkg.dependencies).filter((d) => d.startsWith("@temporalio"));
    assert.deepStrictEqual(hard, [],
        "@temporalio/* must stay in optionalDependencies — it requires Node >=20.3 " +
        "while this package supports Node >=18");

    const optional = Object.keys(pkg.optionalDependencies || {});
    for (const p of ["@temporalio/client", "@temporalio/worker", "@temporalio/workflow"]) {
        assert.ok(optional.includes(p), `${p} should be declared optional`);
    }
});

test("declared Node engine floor is not raised by the optional SDK", () => {
    const pkg = require(path.join(ROOT, "package.json"));
    assert.strictEqual(pkg.engines.node, ">=18.0.0",
        "adding Temporal must not raise the floor for users who do not opt in");
});

// ----------------------------------------------------------- integration ---

const liveServer = process.env.MNEX_TEMPORAL_ADDRESS;

test("round trip against a live Temporal server", { skip: !liveServer }, async () => {
    const res = await withEnv({ MNEX_ORCHESTRATOR: "temporal" }, () => adapter.doctor());
    assert.strictEqual(res.ok, true, `doctor failed: ${res.error}`);
    assert.match(String(res.roundTrip.echoed), /^ping-/);
});
