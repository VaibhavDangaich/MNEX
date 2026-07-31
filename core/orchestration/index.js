/**
 * Orchestrator selection.
 *
 * mnex ships two durable backends behind one interface:
 *
 *   embedded (default) — a write-ahead step log in the SQLite already bundled.
 *                        No server, no extra process, works offline. This is
 *                        what a `npm i -g` CLI should do by default.
 *
 *   temporal (opt-in)  — a real Temporal.io cluster, for users who already run
 *                        one and want its history, visibility UI and operational
 *                        tooling. Requires MNEX_ORCHESTRATOR=temporal, the
 *                        optional @temporalio/* packages, and Node >=20.3.
 *
 * Both express work the same way — a named activity plus a JSON input — so
 * calling code does not branch on the backend.
 */

const engine = require("./engine");

function backendName() {
    const temporal = require("./temporal/adapter");
    return temporal.isEnabled() ? "temporal" : "embedded";
}

/**
 * Run the GitHub index under whichever backend is selected.
 *
 * The two paths return the same shape ({ completed, skipped, failed, total })
 * so the CLI renders one summary either way.
 */
async function runGithubIndex(options = {}) {
    const temporal = require("./temporal/adapter");

    if (temporal.isEnabled()) {
        // Fails loudly if the optional SDK is absent rather than silently
        // downgrading — a user who asked for Temporal should not be told the run
        // succeeded on a different backend.
        temporal.assertAvailable();
        const res = await temporal.runGithubIndex(options);
        return { ...res, skipped: 0 };
    }

    const github = require("../integrations/github");
    const res = await github.indexUserGitHubDurable(
        options.githubToken,
        options.supermemoryKey,
        options
    );
    return { backend: "embedded", ...res };
}

module.exports = {
    engine,
    backendName,
    runGithubIndex,
};
