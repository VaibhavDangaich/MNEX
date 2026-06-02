/**
 * Future You Journal
 * Auto-documents your daily work with reasoning
 * "What did I do today and why?"
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const llm = require("../llm");
const episodic = require("../memory/episodic");
const working = require("../memory/working");
const config = require("../config");

/**
 * Get today's git commits
 */
function getTodaysCommits(cwd) {
    return new Promise((resolve) => {
        const today = new Date().toISOString().split("T")[0];
        exec(
            `git log --since="${today} 00:00" --format="%h|%s|%an|%ai" --all`,
            { cwd },
            (err, stdout) => {
                if (err) {
                    resolve([]);
                    return;
                }
                const commits = stdout.trim().split("\n").filter(Boolean).map(line => {
                    const [sha, message, author, date] = line.split("|");
                    return { sha, message, author, date };
                });
                resolve(commits);
            }
        );
    });
}

/**
 * Get files changed today
 */
function getTodaysChangedFiles(cwd) {
    return new Promise((resolve) => {
        const today = new Date().toISOString().split("T")[0];
        exec(
            `git log --since="${today} 00:00" --name-only --format="" --all | sort | uniq`,
            { cwd },
            (err, stdout) => {
                if (err) {
                    resolve([]);
                    return;
                }
                const files = stdout.trim().split("\n").filter(Boolean);
                resolve(files);
            }
        );
    });
}

/**
 * Get git diff stats for today
 */
function getTodaysDiffStats(cwd) {
    return new Promise((resolve) => {
        const today = new Date().toISOString().split("T")[0];
        exec(
            `git log --since="${today} 00:00" --stat --all`,
            { cwd },
            (err, stdout) => {
                if (err) {
                    resolve({ additions: 0, deletions: 0 });
                    return;
                }
                // Parse stats
                const insertions = (stdout.match(/(\d+) insertions?/g) || [])
                    .reduce((sum, m) => sum + parseInt(m), 0);
                const deletions = (stdout.match(/(\d+) deletions?/g) || [])
                    .reduce((sum, m) => sum + parseInt(m), 0);
                resolve({ additions: insertions, deletions });
            }
        );
    });
}

/**
 * Get recent terminal commands from episodic memory
 */
async function getTodaysCommands(projectName) {
    const events = await episodic.getRecent(projectName, 100);
    const today = new Date().toISOString().split("T")[0];

    return events
        .filter(e => e.type === "terminal" && e.timestamp?.startsWith(today))
        .map(e => e.command)
        .filter(Boolean);
}

/**
 * Get working memory context
 */
function getWorkingContext(projectName) {
    return working.get(projectName);
}

/**
 * Generate journal entry using AI
 */
async function generateJournalEntry(data) {
    const {
        projectName,
        commits,
        changedFiles,
        diffStats,
        commands,
        workingContext,
        date,
    } = data;

    const prompt = `You are writing a developer journal entry for "Future Me" - documenting what was done today and WHY, so the developer can understand their past decisions.

PROJECT: ${projectName}
DATE: ${date}

TODAY'S GIT COMMITS:
${commits.map(c => `- ${c.sha}: ${c.message}`).join("\n") || "None"}

FILES CHANGED:
${changedFiles.slice(0, 20).join(", ") || "None"}

STATS: +${diffStats.additions} lines, -${diffStats.deletions} lines

TERMINAL COMMANDS (sample):
${commands.slice(0, 10).join("\n") || "None"}

CURRENT TASK/CONTEXT:
${workingContext?.currentTask || workingContext?.context || "Not specified"}

---

Write a journal entry that:
1. Summarizes what was accomplished
2. Explains the WHY behind decisions (infer from commits and context)
3. Notes any gotchas or things to remember
4. Lists next steps if obvious

Format as Markdown. Be concise but insightful. Write as if explaining to yourself 6 months from now.`;

    try {
        const entry = await llm.ask(prompt, { context: {} });
        return entry;
    } catch (e) {
        return `# ${date} - ${projectName}\n\nFailed to generate: ${e.message}`;
    }
}

/**
 * Create today's journal entry
 */
async function createJournalEntry(projectPath, options = {}) {
    const { outputDir = null } = options;
    const projectName = path.basename(projectPath);
    const date = new Date().toISOString().split("T")[0];

    console.log("\n📝 Generating journal entry...\n");

    // Gather all data
    const [commits, changedFiles, diffStats, commands] = await Promise.all([
        getTodaysCommits(projectPath),
        getTodaysChangedFiles(projectPath),
        getTodaysDiffStats(projectPath),
        getTodaysCommands(projectName),
    ]);

    const workingContext = getWorkingContext(projectName);

    console.log(`📊 Today's stats:`);
    console.log(`   Commits: ${commits.length}`);
    console.log(`   Files changed: ${changedFiles.length}`);
    console.log(`   Lines: +${diffStats.additions} / -${diffStats.deletions}`);
    console.log(`   Commands: ${commands.length}\n`);

    if (commits.length === 0 && changedFiles.length === 0) {
        console.log("💤 No activity detected today. Nothing to journal.\n");
        return null;
    }

    // Generate entry
    const entry = await generateJournalEntry({
        projectName,
        commits,
        changedFiles,
        diffStats,
        commands,
        workingContext,
        date,
    });

    // Determine output path
    const journalDir = outputDir || path.join(projectPath, "docs", "journal");
    const journalFile = path.join(journalDir, `${date}.md`);

    // Create directory if needed
    if (!fs.existsSync(journalDir)) {
        fs.mkdirSync(journalDir, { recursive: true });
    }

    // Add header
    const fullEntry = `---
date: ${date}
project: ${projectName}
commits: ${commits.length}
files_changed: ${changedFiles.length}
lines_added: ${diffStats.additions}
lines_removed: ${diffStats.deletions}
---

${entry}

---

## Raw Data

### Commits
${commits.map(c => `- \`${c.sha}\`: ${c.message}`).join("\n") || "None"}

### Files Changed
${changedFiles.slice(0, 30).map(f => `- ${f}`).join("\n") || "None"}
${changedFiles.length > 30 ? `\n... and ${changedFiles.length - 30} more files` : ""}
`;

    // Write file
    fs.writeFileSync(journalFile, fullEntry);

    console.log(`✅ Journal saved to: ${journalFile}\n`);

    return {
        path: journalFile,
        entry: fullEntry,
        stats: {
            commits: commits.length,
            filesChanged: changedFiles.length,
            additions: diffStats.additions,
            deletions: diffStats.deletions,
        },
    };
}

/**
 * Read past journal entries
 */
function readJournalEntries(projectPath, limit = 7) {
    const journalDir = path.join(projectPath, "docs", "journal");

    if (!fs.existsSync(journalDir)) {
        return [];
    }

    const files = fs.readdirSync(journalDir)
        .filter(f => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, limit);

    return files.map(f => {
        const content = fs.readFileSync(path.join(journalDir, f), "utf-8");
        return {
            date: f.replace(".md", ""),
            content,
        };
    });
}

/**
 * Get weekly summary
 */
async function getWeeklySummary(projectPath) {
    const entries = readJournalEntries(projectPath, 7);

    if (entries.length === 0) {
        return "No journal entries found for this week.";
    }

    const prompt = `Summarize this week's development work from these journal entries:

${entries.map(e => `### ${e.date}\n${e.content.substring(0, 500)}...`).join("\n\n")}

Provide:
1. Major accomplishments
2. Patterns or recurring work
3. Any concerning trends
4. Suggested focus for next week

Be concise.`;

    try {
        return await llm.ask(prompt, { context: {} });
    } catch (e) {
        return `Failed to generate summary: ${e.message}`;
    }
}

/**
 * Search journal entries
 */
function searchJournal(projectPath, query) {
    const entries = readJournalEntries(projectPath, 30);
    const queryLower = query.toLowerCase();

    return entries.filter(e => 
        e.content.toLowerCase().includes(queryLower)
    ).map(e => ({
        date: e.date,
        snippet: e.content.substring(0, 200) + "...",
    }));
}

module.exports = {
    createJournalEntry,
    readJournalEntries,
    getWeeklySummary,
    searchJournal,
    getTodaysCommits,
    getTodaysChangedFiles,
    generateJournalEntry,
};
