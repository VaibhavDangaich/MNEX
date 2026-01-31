const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * Check if a directory is a real project (not just any random folder)
 * A project has: git repo, package.json, Cargo.toml, pyproject.toml, etc.
 */
function isRealProject(cwd) {
    const projectIndicators = [
        ".git",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "go.mod",
        "pom.xml",
        "build.gradle",
        "Makefile",
        "CMakeLists.txt",
        ".project",
        "requirements.txt",
        "setup.py",
    ];

    for (const indicator of projectIndicators) {
        if (fs.existsSync(path.join(cwd, indicator))) {
            return true;
        }
    }
    return false;
}

/**
 * Get project name only if it's a real project
 */
function getProjectName(cwd) {
    const gitContext = getGitContext(cwd);
    
    if (gitContext.isGitRepo) {
        return gitContext.repoName;
    }
    
    if (isRealProject(cwd)) {
        return path.basename(cwd);
    }
    
    return null; // Not a project, just a random directory
}

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
            isProject: true,
            repoName,
            branch,
            cwd,
            repoRoot,
        };
    } catch (err) {
        return {
            isGitRepo: false,
            isProject: isRealProject(cwd),
            cwd,
        };
    }
}

module.exports = {
    getGitContext,
    getProjectName,
    isRealProject,
};