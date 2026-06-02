/**
 * Cross-Project Intelligence
 * Remembers solutions across ALL your projects
 * "You solved this before in project X..."
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const supermemory = require("../memory/supermemory");
const config = require("../config");
const { exec } = require("child_process");

// Store project registry
const REGISTRY_PATH = path.join(os.homedir(), ".config", "ai-agent", "projects.json");

/**
 * Load project registry
 */
function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
        }
    } catch (e) {
        // Ignore errors
    }
    return { projects: {}, lastUpdated: null };
}

/**
 * Save project registry
 */
function saveRegistry(registry) {
    const dir = path.dirname(REGISTRY_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Register a project for cross-project intelligence
 */
function registerProject(projectPath) {
    const registry = loadRegistry();
    const name = path.basename(projectPath);

    // Get project info
    let projectInfo = {
        path: projectPath,
        name,
        addedAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        languages: [],
        frameworks: [],
        indexed: false,
    };

    // Detect languages and frameworks
    try {
        if (fs.existsSync(path.join(projectPath, "package.json"))) {
            const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf-8"));
            projectInfo.languages.push("javascript");
            if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
                projectInfo.languages.push("typescript");
            }
            // Detect frameworks
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps.react) projectInfo.frameworks.push("react");
            if (deps.vue) projectInfo.frameworks.push("vue");
            if (deps.express) projectInfo.frameworks.push("express");
            if (deps.next) projectInfo.frameworks.push("nextjs");
            if (deps.nestjs) projectInfo.frameworks.push("nestjs");
        }
        if (fs.existsSync(path.join(projectPath, "requirements.txt")) ||
            fs.existsSync(path.join(projectPath, "pyproject.toml"))) {
            projectInfo.languages.push("python");
        }
        if (fs.existsSync(path.join(projectPath, "go.mod"))) {
            projectInfo.languages.push("go");
        }
        if (fs.existsSync(path.join(projectPath, "Cargo.toml"))) {
            projectInfo.languages.push("rust");
        }
    } catch (e) {
        // Ignore
    }

    registry.projects[projectPath] = projectInfo;
    registry.lastUpdated = new Date().toISOString();
    saveRegistry(registry);

    return projectInfo;
}

/**
 * Get all registered projects
 */
function getProjects() {
    const registry = loadRegistry();
    return Object.values(registry.projects);
}

/**
 * Index a project's key patterns and solutions into Supermemory
 */
async function indexProject(projectPath, supermemoryKey) {
    const name = path.basename(projectPath);
    const results = { indexed: 0, errors: [] };

    console.log(`\n📁 Indexing ${name}...`);

    // 1. Index README
    const readmePath = path.join(projectPath, "README.md");
    if (fs.existsSync(readmePath)) {
        try {
            const content = fs.readFileSync(readmePath, "utf-8");
            await supermemory.store(
                `project-${name}`,
                `[Project: ${name}]\n[Type: README]\n\n${content}`,
                supermemoryKey
            );
            results.indexed++;
            console.log("   ✅ README");
        } catch (e) {
            results.errors.push(`README: ${e.message}`);
        }
    }

    // 2. Index key source files
    const keyPatterns = [
        "src/index.{js,ts}",
        "src/main.{js,ts,py}",
        "src/app.{js,ts}",
        "lib/*.{js,ts}",
        "core/*.{js,ts}",
        "utils/*.{js,ts}",
        "helpers/*.{js,ts}",
    ];

    // Find key files
    const keyFiles = [];
    const walkDir = (dir, depth = 0) => {
        if (depth > 3) return;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory() && !file.startsWith(".") && file !== "node_modules") {
                    walkDir(fullPath, depth + 1);
                } else if (stat.isFile()) {
                    const ext = path.extname(file);
                    if ([".js", ".ts", ".py", ".go", ".rs"].includes(ext)) {
                        // Only include files with interesting patterns
                        const content = fs.readFileSync(fullPath, "utf-8");
                        if (content.includes("export") || content.includes("function") ||
                            content.includes("class") || content.includes("def ")) {
                            keyFiles.push({ path: fullPath, content });
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore permission errors
        }
    };

    walkDir(projectPath);

    // Index top 20 key files
    const filesToIndex = keyFiles
        .sort((a, b) => b.content.length - a.content.length)
        .slice(0, 20);

    for (const file of filesToIndex) {
        try {
            const relativePath = path.relative(projectPath, file.path);
            await supermemory.store(
                `project-${name}`,
                `[Project: ${name}]\n[File: ${relativePath}]\n\n${file.content.substring(0, 10000)}`,
                supermemoryKey
            );
            results.indexed++;
            console.log(`   ✅ ${relativePath}`);
        } catch (e) {
            results.errors.push(`${file.path}: ${e.message}`);
        }
    }

    // 3. Index git commit patterns (solutions)
    try {
        const commits = await getGitCommits(projectPath, 50);
        if (commits.length > 0) {
            // Group by type
            const fixes = commits.filter(c => c.message.toLowerCase().includes("fix"));
            const features = commits.filter(c => 
                c.message.toLowerCase().includes("add") || 
                c.message.toLowerCase().includes("feat")
            );

            const commitLog = `[Project: ${name}]\n[Type: Git History]\n\n` +
                `FIXES:\n${fixes.map(c => `- ${c.message}`).join("\n")}\n\n` +
                `FEATURES:\n${features.map(c => `- ${c.message}`).join("\n")}`;

            await supermemory.store(
                `project-${name}`,
                commitLog,
                supermemoryKey
            );
            results.indexed++;
            console.log(`   ✅ Git history (${commits.length} commits)`);
        }
    } catch (e) {
        results.errors.push(`git: ${e.message}`);
    }

    // Update registry
    const registry = loadRegistry();
    if (registry.projects[projectPath]) {
        registry.projects[projectPath].indexed = true;
        registry.projects[projectPath].indexedAt = new Date().toISOString();
        saveRegistry(registry);
    }

    return results;
}

/**
 * Get git commits
 */
function getGitCommits(projectPath, limit = 50) {
    return new Promise((resolve) => {
        exec(
            `git log --oneline -${limit}`,
            { cwd: projectPath },
            (err, stdout) => {
                if (err) {
                    resolve([]);
                    return;
                }
                const commits = stdout.trim().split("\n").map(line => {
                    const [sha, ...rest] = line.split(" ");
                    return { sha, message: rest.join(" ") };
                });
                resolve(commits);
            }
        );
    });
}

/**
 * Search across all projects for similar solutions
 */
async function searchAcrossProjects(query, supermemoryKey) {
    try {
        const results = await supermemory.search(query, supermemoryKey, {
            limit: 10,
        });

        // Group by project
        const byProject = {};
        for (const result of results) {
            // Extract project name from content
            const projectMatch = result.content?.match(/\[Project: ([^\]]+)\]/);
            const project = projectMatch ? projectMatch[1] : "unknown";

            if (!byProject[project]) {
                byProject[project] = [];
            }
            byProject[project].push(result);
        }

        return byProject;
    } catch (e) {
        return {};
    }
}

/**
 * Find similar code/solutions you've written before
 */
async function findSimilarSolutions(problem, currentProject, supermemoryKey) {
    const searchQuery = `solution for ${problem}`;
    const results = await searchAcrossProjects(searchQuery, supermemoryKey);

    // Filter out current project
    const otherProjects = Object.entries(results)
        .filter(([name]) => name !== currentProject)
        .map(([name, hits]) => ({
            project: name,
            relevance: hits[0]?.score || 0,
            snippet: hits[0]?.content?.substring(0, 500) || "",
        }))
        .sort((a, b) => b.relevance - a.relevance);

    return otherProjects;
}

/**
 * Get cross-project context for a query
 */
async function getCrossProjectContext(query, currentProject, supermemoryKey) {
    const similar = await findSimilarSolutions(query, currentProject, supermemoryKey);

    if (similar.length === 0) {
        return null;
    }

    let context = "\n📚 CROSS-PROJECT INTELLIGENCE:\n";
    context += "You've worked on similar things before:\n\n";

    for (const match of similar.slice(0, 3)) {
        context += `• In "${match.project}": ${match.snippet.substring(0, 200)}...\n\n`;
    }

    return context;
}

/**
 * Index all registered projects
 */
async function indexAllProjects(supermemoryKey) {
    const projects = getProjects();
    const results = { total: 0, indexed: 0, errors: [] };

    for (const project of projects) {
        results.total++;
        try {
            const r = await indexProject(project.path, supermemoryKey);
            results.indexed++;
            results.errors.push(...r.errors);
        } catch (e) {
            results.errors.push(`${project.name}: ${e.message}`);
        }
    }

    return results;
}

/**
 * Auto-register current project if not registered
 */
function autoRegister(projectPath) {
    const registry = loadRegistry();
    if (!registry.projects[projectPath]) {
        return registerProject(projectPath);
    }
    // Update last accessed
    registry.projects[projectPath].lastAccessed = new Date().toISOString();
    saveRegistry(registry);
    return registry.projects[projectPath];
}

module.exports = {
    registerProject,
    getProjects,
    indexProject,
    indexAllProjects,
    searchAcrossProjects,
    findSimilarSolutions,
    getCrossProjectContext,
    autoRegister,
    loadRegistry,
};
