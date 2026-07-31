/**
 * Temporal workflow definitions.
 *
 * This file is bundled and executed inside Temporal's deterministic sandbox, so
 * it must contain no I/O, no Date.now(), no Math.random(), and no require() of
 * anything that performs side effects. Everything real happens in activities,
 * which are looked up by name in the worker's registry
 * (core/orchestration/activities.js).
 *
 * Durability here comes from Temporal's event history rather than from the
 * embedded step log: if the worker dies mid-run, the workflow is rescheduled on
 * a new worker and every activity that already completed is served from history
 * instead of being executed again. That is the same guarantee the embedded
 * engine provides via idempotency keys, obtained a different way.
 */

const { proxyActivities } = require("@temporalio/workflow");

// Retry semantics mirror the embedded engine: transient failures back off,
// deterministic ones are not retried. nonRetryableErrorTypes matches the error
// name the GitHub client raises for deterministic 4xx responses.
const acts = proxyActivities({
    startToCloseTimeout: "5 minutes",
    retry: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "30s",
        maximumAttempts: 4,
        nonRetryableErrorTypes: ["NonRetryableGitHubError"],
    },
});

/**
 * Index a GitHub account.
 *
 * @param {object} params { maxRepos, includeStarred } — never credentials
 */
async function githubIndexWorkflow(params = {}) {
    const { maxRepos = 10, includeStarred = false } = params;

    const repos = await acts.listRepos({ maxRepos });

    const results = [];
    let completed = 0;
    let failed = 0;

    for (const repo of repos) {
        try {
            const result = await acts.indexRepo({ owner: repo.owner, repo: repo.name });
            results.push({ name: `repo:${repo.full_name}`, ok: true, result });
            completed++;
        } catch (err) {
            // One inaccessible repo should not abandon the whole account.
            results.push({
                name: `repo:${repo.full_name}`,
                ok: false,
                error: String(err?.message || err),
            });
            failed++;
        }
    }

    if (includeStarred) {
        try {
            const result = await acts.indexStarred({ limit: 20 });
            results.push({ name: "starred", ok: true, result });
            completed++;
        } catch (err) {
            results.push({ name: "starred", ok: false, error: String(err?.message || err) });
            failed++;
        }
    }

    return { results, completed, failed, total: results.length };
}

/**
 * Minimal workflow used by `mnex workflow doctor` and by the integration test to
 * prove the client -> server -> worker -> activity path end to end.
 */
async function echoWorkflow(value) {
    return acts.echo({ value });
}

module.exports = { githubIndexWorkflow, echoWorkflow };
