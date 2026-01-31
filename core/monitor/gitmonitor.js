/**
 * Git Monitor
 * Captures git diffs and commit info to store in memory
 * This gives the AI detailed knowledge of code changes
 */

const { execSync } = require("child_process");
const path = require("path");
const config = require("../config");

/**
 * Get the current git diff (staged + unstaged)
 * @param {string} cwd - Working directory
 * @returns {Object} Diff info
 */
function getCurrentDiff(cwd) {
    try {
        // Get unstaged changes
        const unstaged = execSync("git diff --stat", {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();

        // Get staged changes
        const staged = execSync("git diff --cached --stat", {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();

        // Get detailed diff (limited to avoid huge outputs)
        const detailedDiff = execSync("git diff -U3 --no-color | head -500", {
            cwd,
            encoding: "utf-8",
            shell: true,
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();

        return {
            unstaged,
            staged,
            detailed: detailedDiff,
            hasChanges: !!(unstaged || staged),
        };
    } catch (error) {
        return { unstaged: "", staged: "", detailed: "", hasChanges: false };
    }
}

/**
 * Get recent commit diffs
 * @param {string} cwd - Working directory
 * @param {number} count - Number of commits
 * @returns {Array} Array of commit diffs
 */
function getRecentCommits(cwd, count = 5) {
    try {
        // Get recent commit hashes with messages
        const logOutput = execSync(
            `git log --oneline -${count} --format="%H|%s|%ai"`,
            {
                cwd,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "ignore"],
            }
        ).trim();

        if (!logOutput) return [];

        const commits = logOutput.split("\n").map((line) => {
            const [hash, message, date] = line.split("|");
            return { hash, message, date };
        });

        // Get diff for most recent commit
        if (commits.length > 0) {
            try {
                const lastCommitDiff = execSync(
                    `git show --stat --format="" ${commits[0].hash} | head -100`,
                    {
                        cwd,
                        encoding: "utf-8",
                        shell: true,
                        stdio: ["pipe", "pipe", "ignore"],
                    }
                ).trim();
                commits[0].diffStat = lastCommitDiff;

                // Get actual code changes for latest commit (limited)
                const codeChanges = execSync(
                    `git show -U3 --no-color ${commits[0].hash} | head -300`,
                    {
                        cwd,
                        encoding: "utf-8",
                        shell: true,
                        stdio: ["pipe", "pipe", "ignore"],
                    }
                ).trim();
                commits[0].codeChanges = codeChanges;
            } catch {
                // Ignore if we can't get diff
            }
        }

        return commits;
    } catch (error) {
        return [];
    }
}

/**
 * Get diff between two commits or refs
 * @param {string} cwd - Working directory
 * @param {string} from - Start ref (commit, branch, tag)
 * @param {string} to - End ref (default HEAD)
 */
function getDiffBetween(cwd, from, to = "HEAD") {
    try {
        const stat = execSync(`git diff --stat ${from}..${to}`, {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();

        const detailed = execSync(
            `git diff -U3 --no-color ${from}..${to} | head -500`,
            {
                cwd,
                encoding: "utf-8",
                shell: true,
                stdio: ["pipe", "pipe", "ignore"],
            }
        ).trim();

        return { stat, detailed };
    } catch (error) {
        return { stat: "", detailed: "" };
    }
}

/**
 * Capture git commit and store rich context
 * Called when we detect a git commit command
 * @param {string} cwd - Working directory
 * @param {string} commitMessage - The commit message
 */
async function captureCommit(cwd, commitMessage) {
    const supermemory = require("../memory/supermemory");
    const episodic = require("../memory/episodic");
    const apiKey = config.get("supermemory.apiKey");
    const projectName = path.basename(cwd);

    try {
        // Get the commit that was just made
        const commits = getRecentCommits(cwd, 1);
        if (commits.length === 0) return;

        const latestCommit = commits[0];

        // Build rich context for memory
        const memoryContent = `
## Git Commit in ${projectName}

**Commit:** ${latestCommit.hash?.substring(0, 8)}
**Message:** ${commitMessage || latestCommit.message}
**Date:** ${latestCommit.date}

### Files Changed:
${latestCommit.diffStat || "No file stats available"}

### Code Changes:
\`\`\`diff
${latestCommit.codeChanges || "No code changes captured"}
\`\`\`
`.trim();

        // Store in episodic memory
        await episodic.add({
            type: "git_commit",
            project: projectName,
            commit: latestCommit.hash,
            message: commitMessage || latestCommit.message,
            diffStat: latestCommit.diffStat,
            codeChanges: latestCommit.codeChanges,
            timestamp: new Date().toISOString(),
        });

        // Store in Supermemory for semantic search
        if (apiKey) {
            await supermemory.store(projectName, memoryContent, apiKey);
            if (config.get("debug")) {
                console.log("📝 Stored commit in Supermemory");
            }
        }

        return latestCommit;
    } catch (error) {
        if (config.get("debug")) {
            console.warn("Failed to capture commit:", error.message);
        }
    }
}

/**
 * Format git info for prompt injection
 * @param {string} cwd - Working directory
 */
function formatForPrompt(cwd) {
    const diff = getCurrentDiff(cwd);
    const commits = getRecentCommits(cwd, 3);

    let output = "";

    if (diff.hasChanges) {
        output += "### Uncommitted Changes:\n";
        if (diff.staged) output += `**Staged:**\n${diff.staged}\n`;
        if (diff.unstaged) output += `**Unstaged:**\n${diff.unstaged}\n`;
        if (diff.detailed) {
            output += `\n**Diff Preview:**\n\`\`\`diff\n${diff.detailed.substring(0, 1000)}\n\`\`\`\n`;
        }
    }

    if (commits.length > 0) {
        output += "\n### Recent Commits:\n";
        commits.forEach((c, i) => {
            output += `${i + 1}. \`${c.hash?.substring(0, 8)}\` - ${c.message}\n`;
        });

        // Include latest commit's code changes
        if (commits[0].codeChanges) {
            output += `\n**Latest Commit Changes:**\n\`\`\`diff\n${commits[0].codeChanges.substring(0, 1500)}\n\`\`\`\n`;
        }
    }

    return output;
}

module.exports = {
    getCurrentDiff,
    getRecentCommits,
    getDiffBetween,
    captureCommit,
    formatForPrompt,
};
