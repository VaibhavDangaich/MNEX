/**
 * Durability proof for the Temporal backend.
 *
 * Asserts the guarantee Temporal actually makes, not a stronger one:
 *   - an activity that COMPLETED before the worker died is never re-executed;
 *   - the activity that was IN FLIGHT when the worker died is retried, because
 *     its completion was never reported. Activities are at-least-once, which is
 *     why mnex activities must be idempotent.
 *
 * Uses the real core/orchestration/temporal/workflows.js with stubbed
 * activities, so it exercises the shipped workflow code without touching GitHub.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Client, Connection } = require("@temporalio/client");

const LOG = "/tmp/mnex_verify_activities.log";
const REPOS = 6;
const WORKER = path.join(__dirname, "temporal-worker.js");
const BUNDLE = "/tmp/mnex_workflow_bundle.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startWorker = () =>
    spawn(process.execPath, [WORKER], {
        env: { ...process.env, VERIFY_LOG: LOG, VERIFY_REPOS: String(REPOS), VERIFY_BUNDLE: BUNDLE },
        stdio: "inherit",
    });

(async () => {
    // Pre-bundle once so worker boot is fast and predictable.
    const { bundleWorkflowCode } = require("@temporalio/worker");
    const { code } = await bundleWorkflowCode({
        workflowsPath: require.resolve("../../core/orchestration/temporal/workflows.js"),
    });
    fs.writeFileSync(BUNDLE, code);
    console.log(`bundled workflows (${(code.length / 1048576).toFixed(2)} MB)`);

    fs.writeFileSync(LOG, "");
    const wfId = `mnex-verify-${Date.now()}`;

    console.log("1. starting worker A");
    let worker = startWorker();
    await sleep(4000);

    const connection = await Connection.connect({ address: "localhost:7233" });
    const client = new Client({ connection });

    console.log(`2. starting workflow ${wfId} (${REPOS} repos)`);
    const handle = await client.workflow.start("githubIndexWorkflow", {
        taskQueue: "mnex-verify", workflowId: wfId, args: [{ maxRepos: REPOS }],
    });

    await sleep(2600);
    const beforeLines = fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
    const completedBefore = beforeLines.slice(0, -1).map((l) => l.split(" ")[1]); // last one was in flight
    const inFlight = beforeLines.at(-1)?.split(" ")[1];
    console.log(`3. SIGKILL worker A — ${completedBefore.length} completed, "${inFlight}" in flight`);
    worker.kill("SIGKILL");

    await sleep(1500);
    console.log("4. starting worker B (fresh process)");
    worker = startWorker();

    const result = await handle.result();
    worker.kill("SIGTERM");
    await connection.close();

    const lines = fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
    const repos = lines.map((l) => l.split(" ")[1]);
    const pids = new Set(lines.map((l) => l.split(" ")[0]));
    const counts = repos.reduce((m, r) => ((m[r] = (m[r] || 0) + 1), m), {});
    const repeated = Object.keys(counts).filter((r) => counts[r] > 1);
    const completedRerun = completedBefore.filter((r) => counts[r] > 1);

    console.log("\n" + "=".repeat(62));
    console.log(`workflow result       : ${result.completed} completed, ${result.failed} failed`);
    console.log(`distinct repos indexed: ${new Set(repos).size} of ${REPOS}`);
    console.log(`worker PIDs involved  : ${pids.size}  (survived a worker SIGKILL)`);
    console.log(`completed-then-rerun  : ${completedRerun.length ? completedRerun.join(", ") : "none"}  <-- must be none`);
    console.log(`in-flight retried     : ${repeated.join(", ") || "none"}  <-- expected: the interrupted one`);
    console.log("=".repeat(62));

    const ok =
        completedRerun.length === 0 &&
        new Set(repos).size === REPOS &&
        pids.size >= 2 &&
        result.completed === REPOS &&
        repeated.length <= 1;

    console.log(ok
        ? "\n✅ PASS — completed activities were never re-executed; only the\n" +
          "   in-flight one was retried, which is Temporal's at-least-once contract.\n"
        : "\n❌ FAIL\n");
    process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("verify error:", e); process.exit(1); });
