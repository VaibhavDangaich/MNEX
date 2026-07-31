/**
 * GitHub Integration Module
 * Free alternative to Supermemory's paid GitHub connector
 * Uses GitHub REST API to fetch and index repos, issues, PRs, code
 */

const config = require("../config");
const supermemory = require("../memory/supermemory");

const GITHUB_API = "https://api.github.com";

/**
 * Make authenticated GitHub API request
 */
async function githubFetch(endpoint, token) {
    const response = await fetch(`${GITHUB_API}${endpoint}`, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: token ? `Bearer ${token}` : undefined,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });

    if (!response.ok) {
        const body = await response.text();
        // Carry the status and headers on the error object rather than only in
        // the message. The durable engine needs them to tell a transient 502 or
        // a rate limit (retry, honouring Retry-After / x-ratelimit-reset) from a
        // deterministic 404 or 422 (never retry — retrying just burns quota).
        const error = new Error(`GitHub API error: ${response.status} - ${body}`);
        error.status = response.status;
        error.headers = response.headers;
        error.endpoint = endpoint;
        throw error;
    }

    return response.json();
}

/**
 * Get user's repositories
 */
async function getUserRepos(token, options = {}) {
    const { type = "owner", sort = "updated", perPage = 30 } = options;
    const repos = await githubFetch(
        `/user/repos?type=${type}&sort=${sort}&per_page=${perPage}`,
        token
    );
    return repos;
}

/**
 * Get repository README content
 */
async function getRepoReadme(owner, repo, token) {
    try {
        const readme = await githubFetch(`/repos/${owner}/${repo}/readme`, token);
        // Decode base64 content
        const content = Buffer.from(readme.content, "base64").toString("utf-8");
        return content;
    } catch (error) {
        return null; // No README
    }
}

/**
 * Get repository's package.json (for Node.js projects)
 */
async function getPackageJson(owner, repo, token) {
    try {
        const file = await githubFetch(
            `/repos/${owner}/${repo}/contents/package.json`,
            token
        );
        const content = Buffer.from(file.content, "base64").toString("utf-8");
        return JSON.parse(content);
    } catch (error) {
        return null;
    }
}

/**
 * Get recent commits from a repo
 */
async function getRecentCommits(owner, repo, token, perPage = 10) {
    const commits = await githubFetch(
        `/repos/${owner}/${repo}/commits?per_page=${perPage}`,
        token
    );
    return commits.map((c) => ({
        sha: c.sha.substring(0, 7),
        message: c.commit.message.split("\n")[0],
        author: c.commit.author.name,
        date: c.commit.author.date,
    }));
}

/**
 * Get user's issues (assigned to them)
 */
async function getUserIssues(token, options = {}) {
    const { filter = "assigned", state = "open", perPage = 30 } = options;
    const issues = await githubFetch(
        `/issues?filter=${filter}&state=${state}&per_page=${perPage}`,
        token
    );
    return issues;
}

/**
 * Get user's pull requests
 */
async function getUserPullRequests(token) {
    const prs = await githubFetch(`/search/issues?q=is:pr+author:@me+is:open`, token);
    return prs.items || [];
}

/**
 * Get starred repos (things user is interested in)
 */
async function getStarredRepos(token, perPage = 30) {
    const repos = await githubFetch(`/user/starred?per_page=${perPage}`, token);
    return repos;
}

/**
 * Get a specific file's content from a repo
 */
async function getFileContent(owner, repo, path, token) {
    try {
        const file = await githubFetch(
            `/repos/${owner}/${repo}/contents/${path}`,
            token
        );
        if (file.type === "file" && file.content) {
            return Buffer.from(file.content, "base64").toString("utf-8");
        }
        return null;
    } catch (error) {
        return null;
    }
}

/**
 * Get repository tree (file structure)
 */
async function getRepoTree(owner, repo, token, branch = "main") {
    try {
        const tree = await githubFetch(
            `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
            token
        );
        return tree.tree.filter((item) => item.type === "blob").map((item) => item.path);
    } catch (error) {
        // Try master branch
        try {
            const tree = await githubFetch(
                `/repos/${owner}/${repo}/git/trees/master?recursive=1`,
                token
            );
            return tree.tree.filter((item) => item.type === "blob").map((item) => item.path);
        } catch {
            return [];
        }
    }
}

/**
 * Index a repository into Supermemory
 */
async function indexRepo(owner, repo, token, supermemoryKey) {
    const results = { indexed: 0, errors: [] };

    console.log(`\n📦 Indexing ${owner}/${repo}...`);

    // 1. Index README
    const readme = await getRepoReadme(owner, repo, token);
    if (readme) {
        try {
            await supermemory.store(
                `github-${owner}-${repo}`,
                `[GitHub README: ${owner}/${repo}]\n\n${readme}`,
                supermemoryKey
            );
            results.indexed++;
            console.log("   ✅ README indexed");
        } catch (e) {
            results.errors.push(`README: ${e.message}`);
        }
    }

    // 2. Index package.json (project info)
    const pkg = await getPackageJson(owner, repo, token);
    if (pkg) {
        const pkgInfo = `[GitHub Package: ${owner}/${repo}]
Name: ${pkg.name || repo}
Description: ${pkg.description || "N/A"}
Version: ${pkg.version || "N/A"}
Dependencies: ${Object.keys(pkg.dependencies || {}).join(", ") || "none"}
DevDependencies: ${Object.keys(pkg.devDependencies || {}).join(", ") || "none"}
Scripts: ${Object.keys(pkg.scripts || {}).join(", ") || "none"}`;

        try {
            await supermemory.store(
                `github-${owner}-${repo}`,
                pkgInfo,
                supermemoryKey
            );
            results.indexed++;
            console.log("   ✅ package.json indexed");
        } catch (e) {
            results.errors.push(`package.json: ${e.message}`);
        }
    }

    // 3. Index recent commits
    try {
        const commits = await getRecentCommits(owner, repo, token, 20);
        if (commits.length > 0) {
            const commitLog = `[GitHub Commits: ${owner}/${repo}]\n\n` +
                commits.map((c) => `- ${c.sha}: ${c.message} (${c.author})`).join("\n");

            await supermemory.store(
                `github-${owner}-${repo}`,
                commitLog,
                supermemoryKey
            );
            results.indexed++;
            console.log(`   ✅ ${commits.length} commits indexed`);
        }
    } catch (e) {
        results.errors.push(`commits: ${e.message}`);
    }

    // 4. Index key source files (limited to avoid rate limits)
    const tree = await getRepoTree(owner, repo, token);
    const keyFiles = tree.filter((f) => {
        // Index important files only
        const important = [
            /^src\/index\.(js|ts|py)$/,
            /^index\.(js|ts|py)$/,
            /^main\.(js|ts|py|go|rs)$/,
            /^app\.(js|ts|py)$/,
            /^lib\.rs$/,
            /\.md$/,
            /^config\//,
            /^\.env\.example$/,
        ];
        return important.some((pattern) => pattern.test(f));
    }).slice(0, 10); // Limit to 10 files

    for (const file of keyFiles) {
        try {
            const content = await getFileContent(owner, repo, file, token);
            if (content && content.length < 50000) {
                // Max 50KB
                await supermemory.store(
                    `github-${owner}-${repo}`,
                    `[GitHub File: ${owner}/${repo}/${file}]\n\n${content}`,
                    supermemoryKey
                );
                results.indexed++;
                console.log(`   ✅ ${file} indexed`);
            }
        } catch (e) {
            results.errors.push(`${file}: ${e.message}`);
        }
    }

    return results;
}

/**
 * Index user's GitHub activity and repos
 */
async function indexUserGitHub(token, supermemoryKey, options = {}) {
    const { maxRepos = 10, includeStarred = false } = options;
    const summary = { repos: 0, items: 0, errors: [] };

    console.log("\n🐙 Indexing GitHub account...\n");

    // 1. Get and index user's repos
    const repos = await getUserRepos(token, { perPage: maxRepos });
    console.log(`Found ${repos.length} repositories\n`);

    for (const repo of repos) {
        try {
            const result = await indexRepo(repo.owner.login, repo.name, token, supermemoryKey);
            summary.repos++;
            summary.items += result.indexed;
            summary.errors.push(...result.errors);
        } catch (e) {
            summary.errors.push(`${repo.full_name}: ${e.message}`);
        }
    }

    // 2. Index open issues assigned to user
    try {
        const issues = await getUserIssues(token, { perPage: 20 });
        if (issues.length > 0) {
            const issueText = `[GitHub Issues Assigned to Me]\n\n` +
                issues.map((i) => `- [${i.repository?.full_name || "unknown"}] #${i.number}: ${i.title}\n  ${i.body?.substring(0, 200) || ""}`).join("\n\n");

            await supermemory.store("github-my-issues", issueText, supermemoryKey);
            summary.items++;
            console.log(`\n✅ ${issues.length} assigned issues indexed`);
        }
    } catch (e) {
        summary.errors.push(`issues: ${e.message}`);
    }

    // 3. Index open PRs by user
    try {
        const prs = await getUserPullRequests(token);
        if (prs.length > 0) {
            const prText = `[GitHub Pull Requests by Me]\n\n` +
                prs.map((p) => `- ${p.repository_url?.split("/").slice(-2).join("/")} #${p.number}: ${p.title}`).join("\n");

            await supermemory.store("github-my-prs", prText, supermemoryKey);
            summary.items++;
            console.log(`✅ ${prs.length} open PRs indexed`);
        }
    } catch (e) {
        summary.errors.push(`PRs: ${e.message}`);
    }

    // 4. Optionally index starred repos
    if (includeStarred) {
        try {
            const starred = await getStarredRepos(token, 20);
            const starredText = `[GitHub Starred Repos - Things I'm Interested In]\n\n` +
                starred.map((r) => `- ${r.full_name}: ${r.description || "No description"}`).join("\n");

            await supermemory.store("github-starred", starredText, supermemoryKey);
            summary.items++;
            console.log(`✅ ${starred.length} starred repos indexed`);
        } catch (e) {
            summary.errors.push(`starred: ${e.message}`);
        }
    }

    return summary;
}

/**
 * Durable variant of indexUserGitHub.
 *
 * Indexing an account is the longest-running thing mnex does — one pass over 50+
 * repos is many hundreds of GitHub calls and can run for minutes, which is long
 * enough to be interrupted by Ctrl-C, a closed laptop, or a rate limit. The
 * non-durable version above restarts from zero, re-fetching and re-storing every
 * repo that already succeeded.
 *
 * Here each repo is one durable step keyed by its full name, so a resumed run
 * skips completed repos entirely and only does the remaining work. Transient
 * failures retry with full-jitter backoff; deterministic ones (404 on a deleted
 * repo, 403 on one you lost access to) fail that step and let the run continue.
 *
 * @param {object} options { maxRepos, includeStarred, resume, runId, onProgress }
 */
async function indexUserGitHubDurable(token, supermemoryKey, options = {}) {
    const orchestration = require("../orchestration/engine");
    const { maxRepos = 10, includeStarred = false, resume = false } = options;

    const WORKFLOW = "github-index";

    // Resuming reuses the previous run id, which is what makes the idempotency
    // keys line up and lets completed steps short-circuit.
    let runId = options.runId;
    if (!runId && resume) {
        const prior = orchestration.findResumableRun(WORKFLOW);
        if (!prior) throw new Error("No interrupted github-index run to resume.");
        runId = prior.run_id;
    }

    const run = orchestration.startRun(
        WORKFLOW,
        { maxRepos, includeStarred },
        { runId, project: "github" }
    );
    runId = run.runId;

    const repos = await orchestration.runStep(
        runId,
        "list-repos",
        () => getUserRepos(token, { perPage: maxRepos }),
        { input: { maxRepos } }
    ).then((r) => r.result);

    const units = repos.map((repo) => ({
        name: `repo:${repo.full_name}`,
        input: { full_name: repo.full_name },
        run: () => indexRepo(repo.owner.login, repo.name, token, supermemoryKey),
    }));

    if (includeStarred) {
        units.push({
            name: "starred",
            input: { limit: 20 },
            run: async () => {
                const starred = await getStarredRepos(token, 20);
                const text = `[GitHub Starred Repos - Things I'm Interested In]\n\n` +
                    starred.map((r) => `- ${r.full_name}: ${r.description || "No description"}`).join("\n");
                await supermemory.store("github-starred", text, supermemoryKey);
                return { count: starred.length };
            },
        });
    }

    const outcome = await orchestration.runAll(runId, units, {
        continueOnError: true,
        onProgress: options.onProgress,
        onRetry: options.onRetry,
    });

    return { runId, ...outcome };
}

/**
 * Get current user info
 */
async function getCurrentUser(token) {
    return githubFetch("/user", token);
}

module.exports = {
    githubFetch,
    indexUserGitHubDurable,
    getUserRepos,
    getRepoReadme,
    getPackageJson,
    getRecentCommits,
    getUserIssues,
    getUserPullRequests,
    getStarredRepos,
    getFileContent,
    getRepoTree,
    indexRepo,
    indexUserGitHub,
    getCurrentUser,
};
