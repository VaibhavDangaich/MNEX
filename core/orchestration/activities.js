/**
 * Named activity registry.
 *
 * Both orchestrator backends execute the same units of work, but they cannot
 * share a closure: Temporal workflow code is deterministic and replayed, so the
 * thing it schedules has to be a *name* the worker resolves in its own process,
 * not a function captured in the caller's scope.
 *
 * So a unit of work is described declaratively:
 *
 *     { name: "repo:owner/name", activity: "indexRepo", input: { owner, repo } }
 *
 * The embedded engine looks `activity` up in this registry and calls it inline.
 * The Temporal adapter passes the same descriptor into a workflow, which invokes
 * it through proxyActivities. Neither backend needs to know about the other.
 *
 * Credentials are deliberately NOT part of `input`. Temporal persists workflow
 * history, so anything placed in workflow arguments is written to the Temporal
 * datastore in the clear. Activities resolve secrets from local config at call
 * time instead, which keeps tokens on the machine running the worker.
 */

const config = require("../config");

/** Resolve credentials activity-side. Never pass these through workflow input. */
function credentials() {
    return {
        githubToken: config.get("github.token"),
        supermemoryKey: config.get("supermemory.apiKey"),
    };
}

const activities = {
    /**
     * Index a single repository. Input carries only non-secret identifiers.
     */
    async indexRepo({ owner, repo }) {
        const github = require("../integrations/github");
        const { githubToken, supermemoryKey } = credentials();
        return github.indexRepo(owner, repo, githubToken, supermemoryKey);
    },

    /** List the repositories to index. */
    async listRepos({ maxRepos = 10 }) {
        const github = require("../integrations/github");
        const { githubToken } = credentials();
        const repos = await github.getUserRepos(githubToken, { perPage: maxRepos });
        // Return only what later steps need, so workflow history stays small.
        return repos.map((r) => ({
            full_name: r.full_name,
            owner: r.owner.login,
            name: r.name,
        }));
    },

    /** Index starred repos as a single memory entry. */
    async indexStarred({ limit = 20 }) {
        const github = require("../integrations/github");
        const supermemory = require("../memory/supermemory");
        const { githubToken, supermemoryKey } = credentials();
        const starred = await github.getStarredRepos(githubToken, limit);
        const text = `[GitHub Starred Repos - Things I'm Interested In]\n\n` +
            starred.map((r) => `- ${r.full_name}: ${r.description || "No description"}`).join("\n");
        await supermemory.store("github-starred", text, supermemoryKey);
        return { count: starred.length };
    },

    /** Used by tests and by `mnex workflow doctor` to prove the path works. */
    async echo({ value }) {
        return { echoed: value };
    },
};

/** Look up an activity by name. Throws rather than silently doing nothing. */
function resolve(name) {
    const fn = activities[name];
    if (typeof fn !== "function") {
        throw new Error(
            `Unknown activity "${name}". Registered: ${Object.keys(activities).join(", ")}`
        );
    }
    return fn;
}

module.exports = { activities, resolve, credentials };
