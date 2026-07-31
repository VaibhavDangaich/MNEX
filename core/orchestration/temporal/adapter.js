/**
 * Temporal.io backend (opt-in).
 *
 * mnex defaults to the embedded engine because a globally-installed CLI should
 * not require a server. Teams that already run Temporal can opt in instead and
 * get its durability, visibility UI and operational tooling, without any calling
 * code changing — both backends are driven through the same unit descriptors.
 *
 * Everything here is lazily required. `@temporalio/*` is an optionalDependency
 * and needs Node >=20.3, while mnex supports Node >=18, so importing it eagerly
 * would break the floor the package advertises.
 *
 * Enable with:
 *     export MNEX_ORCHESTRATOR=temporal
 *     export MNEX_TEMPORAL_ADDRESS=localhost:7233     # optional
 *     export MNEX_TEMPORAL_NAMESPACE=default          # optional
 *     export MNEX_TEMPORAL_TASK_QUEUE=mnex            # optional
 */

const path = require("path");

const DEFAULTS = {
    address: "localhost:7233",
    namespace: "default",
    taskQueue: "mnex",
};

function settings() {
    return {
        address: process.env.MNEX_TEMPORAL_ADDRESS || DEFAULTS.address,
        namespace: process.env.MNEX_TEMPORAL_NAMESPACE || DEFAULTS.namespace,
        taskQueue: process.env.MNEX_TEMPORAL_TASK_QUEUE || DEFAULTS.taskQueue,
    };
}

/** True when the user has asked for the Temporal backend. */
function isEnabled() {
    return String(process.env.MNEX_ORCHESTRATOR || "").toLowerCase() === "temporal";
}

/**
 * Whether the SDK is actually installed. It is optional, so a user can select
 * the backend without having run the install step — that should produce a clear
 * message rather than a raw MODULE_NOT_FOUND.
 */
function isAvailable() {
    try {
        require.resolve("@temporalio/client");
        require.resolve("@temporalio/worker");
        return true;
    } catch {
        return false;
    }
}

function assertAvailable() {
    if (isAvailable()) return;
    throw new Error(
        "MNEX_ORCHESTRATOR=temporal but the Temporal SDK is not installed.\n" +
        "  Install it (needs Node >=20.3):\n" +
        "    npm i @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity\n" +
        "  Or unset MNEX_ORCHESTRATOR to use the built-in embedded engine."
    );
}

const WORKFLOWS_PATH = path.join(__dirname, "workflows.js");

/** Connect a client. Caller owns closing the returned connection. */
async function connect() {
    assertAvailable();
    const { Client, Connection } = require("@temporalio/client");
    const { address, namespace } = settings();
    const connection = await Connection.connect({ address });
    return { client: new Client({ connection, namespace }), connection };
}

/**
 * Start a worker that serves mnex activities.
 *
 * Activities run in this process, so credentials stay on this machine and never
 * enter workflow history.
 */
async function startWorker({ taskQueue } = {}) {
    assertAvailable();
    const { Worker } = require("@temporalio/worker");
    const { activities } = require("../activities");
    const cfg = settings();

    const worker = await Worker.create({
        workflowsPath: WORKFLOWS_PATH,
        activities,
        taskQueue: taskQueue || cfg.taskQueue,
        namespace: cfg.namespace,
        connection: await workerConnection(cfg.address),
    });
    return worker;
}

async function workerConnection(address) {
    const { NativeConnection } = require("@temporalio/worker");
    return NativeConnection.connect({ address });
}

/**
 * Run the GitHub index workflow to completion.
 *
 * `ephemeralWorker` runs a worker for the duration of the command, which is the
 * right default for a CLI: the user gets durability without having to operate a
 * separate process. Teams running a long-lived worker (`mnex worker`) should
 * pass false so the workflow is picked up by that fleet instead.
 */
async function runGithubIndex(options = {}) {
    assertAvailable();
    const { maxRepos = 10, includeStarred = false, ephemeralWorker = true } = options;
    const cfg = settings();

    const workflowId = options.workflowId || `mnex-github-index-${Date.now()}`;
    let worker = null;
    let workerRun = null;

    if (ephemeralWorker) {
        worker = await startWorker({ taskQueue: cfg.taskQueue });
        workerRun = worker.run();
    }

    const { client, connection } = await connect();
    try {
        const handle = await client.workflow.start("githubIndexWorkflow", {
            taskQueue: cfg.taskQueue,
            workflowId,
            args: [{ maxRepos, includeStarred }],
        });
        if (options.onStart) options.onStart({ workflowId: handle.workflowId, runId: handle.firstExecutionRunId });

        const result = await handle.result();
        return { workflowId: handle.workflowId, backend: "temporal", ...result };
    } finally {
        if (worker) {
            worker.shutdown();
            try { await workerRun; } catch { /* shutdown races are expected */ }
        }
        await connection.close();
    }
}

/** Connectivity check used by `mnex workflow doctor`. */
async function doctor() {
    const cfg = settings();
    const out = { enabled: isEnabled(), available: isAvailable(), ...cfg };
    if (!out.available) {
        out.ok = false;
        out.error = "Temporal SDK not installed";
        return out;
    }
    let worker = null;
    let workerRun = null;
    let connection = null;
    try {
        worker = await startWorker({ taskQueue: cfg.taskQueue });
        workerRun = worker.run();
        const c = await connect();
        connection = c.connection;
        const value = `ping-${Date.now()}`;
        const res = await c.client.workflow.execute("echoWorkflow", {
            taskQueue: cfg.taskQueue,
            workflowId: `mnex-doctor-${Date.now()}`,
            args: [value],
        });
        out.ok = res?.echoed === value;
        out.roundTrip = res;
    } catch (err) {
        out.ok = false;
        out.error = String(err?.message || err);
    } finally {
        if (worker) {
            worker.shutdown();
            try { await workerRun; } catch { /* expected */ }
        }
        if (connection) await connection.close();
    }
    return out;
}

module.exports = {
    DEFAULTS,
    settings,
    isEnabled,
    isAvailable,
    assertAvailable,
    connect,
    startWorker,
    runGithubIndex,
    doctor,
    WORKFLOWS_PATH,
};
