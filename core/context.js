const { execSync } = require("child_process");
const path = require("path");

function getGitContext(cwd) {
    try {
        // Check if we're inside a git repo
        execSync("git rev-parse --is-inside-work-tree", {
            cwd,
            stdio: "ignore",
        });

        // Get repo root
        const repoRoot = execSync("git rev-parse --show-toplevel", {
            cwd,
        })
            .toString()
            .trim();

        // Get repo name
        const repoName = path.basename(repoRoot);

        // Get current branch
        const branch = execSync("git branch --show-current", {
            cwd,
        })
            .toString()
            .trim();

        return {
            isGitRepo: true,
            repoName,
            branch,
            cwd,        // Pass cwd for git diff operations
            repoRoot,   // Pass repoRoot for full context
        };
    } catch (err) {
        return {
            isGitRepo: false,
            cwd,
        };
    }
}

module.exports = {
    getGitContext,
};