/**
 * Durable orchestration engine.
 *
 * The property that matters is that a resumed run does not repeat side effects
 * that already succeeded, so most of these tests count real invocations of a
 * step body rather than asserting on return values.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const engine = require("../core/orchestration/engine");

function tmpDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnex-orch-"));
    return path.join(dir, "workflows.db");
}

test("idempotency key is stable across key ordering and unstable across values", () => {
    const a = engine.idempotencyKey("run1", "step", { b: 2, a: 1 });
    const b = engine.idempotencyKey("run1", "step", { a: 1, b: 2 });
    assert.strictEqual(a, b, "key ordering must not change the hash");

    assert.notStrictEqual(a, engine.idempotencyKey("run1", "step", { a: 1, b: 3 }));
    assert.notStrictEqual(a, engine.idempotencyKey("run2", "step", { a: 1, b: 2 }));
    assert.notStrictEqual(a, engine.idempotencyKey("run1", "other", { a: 1, b: 2 }));
});

test("completed step is not re-executed on replay", async () => {
    const dbPath = tmpDb();
    const run = engine.startRun("wf", {}, { dbPath });

    let calls = 0;
    const body = async () => { calls++; return { v: calls }; };

    const first = await engine.runStep(run.runId, "s1", body, { input: { x: 1 }, dbPath });
    const second = await engine.runStep(run.runId, "s1", body, { input: { x: 1 }, dbPath });

    assert.strictEqual(calls, 1, "step body must run exactly once");
    assert.strictEqual(first.cached, false);
    assert.strictEqual(second.cached, true);
    assert.deepStrictEqual(second.result, { v: 1 }, "cached result is replayed verbatim");
    engine.close();
});

test("different input to the same step name is a different step", async () => {
    const dbPath = tmpDb();
    const run = engine.startRun("wf", {}, { dbPath });
    let calls = 0;
    const body = async () => { calls++; return calls; };

    await engine.runStep(run.runId, "s", body, { input: { page: 1 }, dbPath });
    await engine.runStep(run.runId, "s", body, { input: { page: 2 }, dbPath });

    assert.strictEqual(calls, 2);
    engine.close();
});

test("transient failure retries and eventually succeeds", async () => {
    const dbPath = tmpDb();
    const run = engine.startRun("wf", {}, { dbPath });

    let attempts = 0;
    const flaky = async () => {
        attempts++;
        if (attempts < 3) {
            const e = new Error("boom");
            e.status = 503;
            throw e;
        }
        return "ok";
    };

    const res = await engine.runStep(run.runId, "flaky", flaky, {
        dbPath, retries: 5, baseDelay: 1, maxDelay: 2,
    });

    assert.strictEqual(attempts, 3);
    assert.strictEqual(res.result, "ok");
    engine.close();
});

test("non-retryable status fails immediately without burning attempts", async () => {
    const dbPath = tmpDb();
    const run = engine.startRun("wf", {}, { dbPath });

    let attempts = 0;
    const notFound = async () => {
        attempts++;
        const e = new Error("nope");
        e.status = 404;
        throw e;
    };

    await assert.rejects(
        () => engine.runStep(run.runId, "nf", notFound, { dbPath, retries: 5, baseDelay: 1 }),
        /nope/
    );
    assert.strictEqual(attempts, 1, "404 must not be retried");

    const steps = engine.getSteps(run.runId, { dbPath });
    assert.strictEqual(steps[0].status, engine.STATUS.FAILED);
    engine.close();
});

test("resume skips completed units and only runs the remainder", async () => {
    const dbPath = tmpDb();
    const executed = [];

    const makeUnits = (failOn) => ["a", "b", "c", "d"].map((n) => ({
        name: `unit:${n}`,
        input: { n },
        run: async () => {
            if (n === failOn) {
                const e = new Error("interrupted");
                e.status = 400; // non-retryable, so the run stops here
                throw e;
            }
            executed.push(n);
            return n;
        },
    }));

    const run = engine.startRun("resumable", {}, { dbPath });

    // First pass dies on "c".
    await assert.rejects(
        () => engine.runAll(run.runId, makeUnits("c"), { dbPath, retries: 0 }),
        /interrupted/
    );
    assert.deepStrictEqual(executed, ["a", "b"], "only a and b completed before the failure");

    // Second pass over the same run id, nothing failing now.
    executed.length = 0;
    const outcome = await engine.runAll(run.runId, makeUnits(null), { dbPath, retries: 0 });

    assert.deepStrictEqual(executed, ["c", "d"], "a and b must NOT re-execute on resume");
    assert.strictEqual(outcome.skipped, 2, "a and b served from the step log");
    assert.strictEqual(outcome.completed, 2);
    engine.close();
});

test("run state survives a fresh process-level open of the database", async () => {
    const dbPath = tmpDb();
    const run = engine.startRun("persist", {}, { dbPath });
    await engine.runStep(run.runId, "s", async () => "done", { dbPath });

    // Simulate a new CLI invocation: drop the handle and reopen from disk.
    engine.close();

    const progress = engine.runProgress(run.runId, { dbPath });
    assert.strictEqual(progress.done, 1);

    let called = false;
    const res = await engine.runStep(run.runId, "s", async () => { called = true; return "x"; }, { dbPath });
    assert.strictEqual(called, false, "a new process must still see the step as done");
    assert.strictEqual(res.result, "done");
    engine.close();
});

test("full jitter backoff stays within [0, min(cap, base*2^n))", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
        const expo = Math.min(30000, 500 * 2 ** attempt);
        for (let i = 0; i < 50; i++) {
            const d = engine.fullJitterDelay(attempt, 500, 30000);
            assert.ok(d >= 0 && d < Math.max(expo, 1), `delay ${d} outside [0,${expo})`);
        }
    }
    // Deterministic bounds with a stubbed rng.
    assert.strictEqual(engine.fullJitterDelay(0, 500, 30000, () => 0), 0);
    assert.strictEqual(engine.fullJitterDelay(3, 500, 30000, () => 0.999), 3996);
    assert.strictEqual(engine.fullJitterDelay(20, 500, 30000, () => 0.5), 15000, "capped");
});

test("retry classification separates transient from deterministic failures", () => {
    const withStatus = (s) => Object.assign(new Error("e"), { status: s });
    for (const s of [429, 500, 502, 503, 504]) {
        assert.ok(engine.defaultIsRetryable(withStatus(s)), `${s} should retry`);
    }
    for (const s of [400, 401, 403, 404, 422]) {
        assert.ok(!engine.defaultIsRetryable(withStatus(s)), `${s} should not retry`);
    }
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
        assert.ok(engine.defaultIsRetryable(Object.assign(new Error("e"), { code })));
    }
    assert.ok(!engine.defaultIsRetryable(new Error("plain")));
    assert.ok(!engine.defaultIsRetryable(null));
});

test("server-supplied pacing overrides computed backoff", () => {
    const now = 1_000_000;

    const retryAfter = { headers: { "retry-after": "12" } };
    assert.strictEqual(engine.serverRequestedDelayMs(retryAfter, now), 12000);

    const rateLimited = {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 30000) / 1000) },
    };
    assert.strictEqual(engine.serverRequestedDelayMs(rateLimited, now), 30000);

    // Headers-as-Map (undici/fetch Response.headers) must work too.
    const asMap = { headers: new Map([["retry-after", "5"]]) };
    asMap.headers.get = Map.prototype.get.bind(asMap.headers);
    assert.strictEqual(engine.serverRequestedDelayMs(asMap, now), 5000);

    assert.strictEqual(engine.serverRequestedDelayMs(new Error("no headers"), now), null);
});

test("prune deletes finished runs but keeps in-flight ones", async () => {
    const dbPath = tmpDb();

    const oldRun = engine.startRun("wf", {}, { dbPath });
    await engine.runStep(oldRun.runId, "s", async () => 1, { dbPath });
    engine.finishRun(oldRun.runId, engine.RUN_STATUS.COMPLETED, { dbPath });

    const liveRun = engine.startRun("wf", {}, { dbPath });
    await engine.runStep(liveRun.runId, "s", async () => 1, { dbPath });

    // Backdate the finished run past the retention window.
    engine.db(dbPath).prepare("UPDATE runs SET updated_at = ? WHERE run_id = ?")
        .run(Date.now() - 40 * 24 * 60 * 60 * 1000, oldRun.runId);

    const res = engine.prune({ days: 30, dbPath });
    assert.strictEqual(res.runs, 1);
    assert.strictEqual(engine.getRun(oldRun.runId, { dbPath }), null);
    assert.ok(engine.getRun(liveRun.runId, { dbPath }), "running run must survive prune");
    engine.close();
});

test("findResumableRun returns the interrupted run for its workflow", async () => {
    const dbPath = tmpDb();
    const done = engine.startRun("github-index", {}, { dbPath });
    engine.finishRun(done.runId, engine.RUN_STATUS.COMPLETED, { dbPath });

    assert.strictEqual(engine.findResumableRun("github-index", { dbPath }), null);

    const live = engine.startRun("github-index", {}, { dbPath });
    assert.strictEqual(engine.findResumableRun("github-index", { dbPath }).run_id, live.runId);
    assert.strictEqual(engine.findResumableRun("other-wf", { dbPath }), null);
    engine.close();
});
