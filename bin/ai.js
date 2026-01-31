#!/usr/bin/env node

/**
 * CLI Entry Point
 * No intelligence here - just wires commands to core modules
 */

// Load environment variables from .env file
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { Command } = require("commander");
const { getGitContext } = require("../core/context");
const memory = require("../core/memory");
const { formatForDisplay, getMessages } = require("../core/prompt");
const llm = require("../core/llm");
const terminal = require("../core/monitor/terminal");

const program = new Command();

program
    .name("ai")
    .description("Context-aware AI agent with memory")
    .version("1.0.0");

/**
 * Helper to get project name (returns null if not in a real project)
 */
function getProjectName() {
    const cwd = process.cwd();
    const { getProjectName: getProject } = require("../core/context");
    return getProject(cwd);
}

/**
 * Check if we're in a real project
 */
function isInProject() {
    return getProjectName() !== null;
}

// ============================================
// ai ask "question"
// ============================================
program
    .command("ask <question>")
    .description("Ask the AI agent a question")
    .option("-d, --debug", "Show the full prompt being sent")
    .action(async (question, options) => {
        const cwd = process.cwd();
        const gitContext = getGitContext(cwd);
        const projectName = getProjectName();

        console.log("\n🤖 AI Agent");
        console.log("─".repeat(40));

        // Show context - differentiate between project and random directory
        if (projectName) {
            console.log(`📁 Project: ${projectName}`);
        } else {
            console.log(`📍 Directory: ${cwd.split("/").pop()} (not a project)`);
        }
        if (gitContext.isGitRepo) {
            console.log(`🌿 Branch: ${gitContext.branch}`);
        }

        // Get full memory (all 3 layers)
        const recalled = await memory.recall(projectName, question);
        
        // Show what context we have
        if (recalled.hasActivity) {
            console.log(`⚡ Recent: ${recalled.episodic.length} command(s)`);
        }
        if (recalled.hasWorkingContext) {
            console.log(`🎯 Working context: Active`);
        }
        if (recalled.hasMemory) {
            console.log(`💾 Memory: ${recalled.local.length} item(s)`);
        }

        console.log("─".repeat(40));

        // Debug: show full prompt
        if (options.debug) {
            const promptDebug = await formatForDisplay(question, gitContext, recalled);
            console.log("\n[DEBUG] Full Prompt:\n");
            console.log(promptDebug);
            console.log("\n" + "─".repeat(40));
        }

        // Call LLM with LangChain prompt template
        try {
            console.log("\n💬 Response:\n");
            await llm.streamChat(question, gitContext, recalled, (chunk) => {
                process.stdout.write(chunk);
            });
            console.log("\n");
        } catch (error) {
            console.error("\n❌ Error:", error.message);
            process.exit(1);
        }
    });

// ============================================
// ai log (called by shell hook)
// ============================================
program
    .command("log")
    .description("Log a terminal command (used by shell hook)")
    .option("--command <cmd>", "The command that was run")
    .option("--exit-code <code>", "Exit code", "0")
    .option("--cwd <dir>", "Working directory")
    .option("--output <out>", "Command output")
    .action(async (options) => {
        if (!options.command) return;

        await terminal.logEvent({
            command: options.command,
            exitCode: parseInt(options.exitCode, 10),
            cwd: options.cwd || process.cwd(),
            output: options.output || "",
        });
    });

// ============================================
// ai remember "fact"
// ============================================
program
    .command("remember <fact>")
    .description("Store a fact in project memory")
    .action(async (fact) => {
        const projectName = getProjectName();
        await memory.remember(projectName, fact);
        console.log("\n✅ Remembered for project:", projectName);
        console.log(`   "${fact}"\n`);
    });

// ============================================
// ai task "description"
// ============================================
program
    .command("task <description>")
    .description("Set current task/goal for this project")
    .action(async (description) => {
        const projectName = getProjectName();
        await memory.working.setCurrentTask(projectName, description);
        console.log("\n🎯 Task set for project:", projectName);
        console.log(`   "${description}"\n`);
    });

// ============================================
// ai memory show
// ============================================
const memoryCmd = program
    .command("memory")
    .description("Memory management commands");

memoryCmd
    .command("show")
    .description("Show all memories for current project")
    .option("-a, --all", "Show memories for all projects")
    .action((options) => {
        const projectName = getProjectName();

        console.log("\n💾 Memory Store");
        console.log("─".repeat(40));

        if (options.all) {
            const allMemory = memory.show(null);
            const projects = Object.keys(allMemory);

            if (projects.length === 0) {
                console.log("No memories stored.\n");
                return;
            }

            for (const proj of projects) {
                console.log(`\n📁 ${proj}:`);
                for (const item of allMemory[proj]) {
                    console.log(`   • ${item.text}`);
                }
            }
        } else {
            const projectMemory = memory.show(projectName);

            console.log(`📁 Project: ${projectName}\n`);

            if (projectMemory.length === 0) {
                console.log("No memories for this project.\n");
                console.log('Use "ai remember <fact>" to add memories.\n');
                return;
            }

            for (const item of projectMemory) {
                console.log(`• ${item.text}`);
                console.log(`  (saved: ${new Date(item.createdAt).toLocaleDateString()})\n`);
            }
        }

        console.log("");
    });

// ============================================
// ai memory forget all
// ============================================
memoryCmd
    .command("forget <scope>")
    .description('Clear memories ("all" for everything, or project name)')
    .action((scope) => {
        const currentProject = getProjectName();

        if (scope === "all") {
            memory.forgetAll(null);
            console.log("\n🗑️  All memories cleared.\n");
        } else if (scope === "project" || scope === "current") {
            memory.forgetAll(currentProject);
            console.log(`\n🗑️  Memories cleared for: ${currentProject}\n`);
        } else {
            memory.forget(scope);
            console.log(`\n🗑️  Memories cleared for: ${scope}\n`);
        }
    });

// ============================================
// ai status
// ============================================
program
    .command("status")
    .description("Show current context and memory status")
    .action(async () => {
        const cwd = process.cwd();
        const gitContext = getGitContext(cwd);
        const projectName = getProjectName();

        console.log("\n📊 AI Agent Status");
        console.log("─".repeat(40));

        // Project info
        console.log(`\n📁 Project: ${projectName}`);
        if (gitContext.isGitRepo) {
            console.log(`🌿 Branch: ${gitContext.branch}`);
        }

        // Working memory
        const workingMem = memory.working.get(projectName);
        if (workingMem.currentTask) {
            console.log(`\n🎯 Current Task: ${workingMem.currentTask}`);
        }
        if (workingMem.recentErrors && workingMem.recentErrors.length > 0) {
            console.log(`\n⚠️  Recent Errors: ${workingMem.recentErrors.length}`);
        }

        // Episodic memory stats
        const stats = memory.getStats(projectName);
        console.log(`\n⚡ Recent Activity: ${stats.episodic.totalEvents} events`);
        console.log(`💾 Semantic Memory: ${stats.semantic.count} items`);

        // Recent commands
        const recent = await memory.episodic.getRecent(projectName, 5);
        if (recent.length > 0) {
            console.log(`\n📜 Last ${recent.length} commands:`);
            for (const cmd of recent) {
                const status = cmd.exitCode === 0 ? "✓" : "✗";
                console.log(`   [${status}] ${cmd.command}`);
            }
        }

        console.log("\n");
    });

// ============================================
// ai history
// ============================================
program
    .command("history")
    .description("Show recent terminal history")
    .option("-n, --limit <n>", "Number of commands", "20")
    .action(async (options) => {
        const projectName = getProjectName();
        const limit = parseInt(options.limit, 10);

        console.log("\n📜 Terminal History");
        console.log("─".repeat(40));

        const events = await memory.episodic.getRecent(projectName, limit);

        if (events.length === 0) {
            console.log("No terminal history recorded.");
            console.log("Make sure the shell hook is installed.\n");
            return;
        }

        for (const event of events) {
            const status = event.exitCode === 0 ? "✓" : "✗";
            const time = new Date(event.timestamp).toLocaleTimeString();
            console.log(`[${time}] [${status}] ${event.command}`);
        }

        console.log("\n");
    });

// ============================================
// ai watch [path]
// ============================================
program
    .command("watch [path]")
    .description("Watch a directory for file changes (works with any editor)")
    .action(async (watchPath) => {
        const filewatcher = require("../core/monitor/filewatcher");
        const targetPath = watchPath || process.cwd();

        console.log("\n👁️  AI Agent File Watcher");
        console.log("─".repeat(40));
        console.log(`📁 Watching: ${targetPath}`);
        console.log("📝 Tracking: .js, .ts, .py, .go, .rs, .md, etc.");
        console.log("🚫 Ignoring: node_modules, .git, dist, build\n");
        console.log("Press Ctrl+C to stop.\n");

        filewatcher.start(targetPath);

        // Keep process alive
        process.on("SIGINT", async () => {
            console.log("\n");
            await filewatcher.stop();
            process.exit(0);
        });

        // Prevent exit
        await new Promise(() => {});
    });

// ============================================
// ai supermemory - Debug Supermemory connection
// ============================================
program
    .command("supermemory")
    .description("Test and debug Supermemory connection")
    .option("-s, --store <text>", "Store a test memory")
    .option("-q, --query <query>", "Search memories")
    .option("-l, --list", "List recent memories")
    .action(async (options) => {
        const supermemory = require("../core/memory/supermemory");
        const config = require("../core/config");
        const apiKey = config.get("supermemory.apiKey");
        const projectName = getProjectName();

        console.log("\n🧠 Supermemory Debug");
        console.log("─".repeat(40));

        if (!apiKey) {
            console.log("❌ No SUPERMEMORY_API_KEY found in .env");
            console.log("   Add: SUPERMEMORY_API_KEY=your-key-here\n");
            return;
        }

        console.log(`✅ API Key: ${apiKey.substring(0, 10)}...`);
        console.log(`📁 Project: ${projectName}\n`);

        if (options.store) {
            console.log(`📤 Storing: "${options.store}"`);
            try {
                const result = await supermemory.store(projectName, options.store, apiKey);
                console.log("✅ Stored successfully!");
                console.log("   Result:", JSON.stringify(result, null, 2));
            } catch (error) {
                console.log("❌ Store failed:", error.message);
            }
        }

        if (options.query) {
            console.log(`🔍 Searching: "${options.query}"`);
            try {
                const results = await supermemory.search(projectName, options.query, apiKey);
                console.log(`✅ Found ${results.length} results:`);
                results.forEach((r, i) => {
                    console.log(`\n${i + 1}. ${r.content?.substring(0, 200) || JSON.stringify(r)}`);
                });
            } catch (error) {
                console.log("❌ Search failed:", error.message);
            }
        }

        if (options.list) {
            console.log("📋 Searching for all memories...");
            try {
                // Search with empty query to get recent memories
                const results = await supermemory.search(projectName, "*", apiKey, 10);
                console.log(`✅ Found ${results.length} memories:`);
                results.forEach((r, i) => {
                    console.log(`\n${i + 1}. ${r.content?.substring(0, 200) || JSON.stringify(r)}`);
                });
            } catch (error) {
                console.log("❌ List failed:", error.message);
            }
        }

        if (!options.store && !options.query && !options.list) {
            console.log("Usage:");
            console.log("  ai supermemory --store 'test memory'  # Store a memory");
            console.log("  ai supermemory --query 'search term'  # Search memories");
            console.log("  ai supermemory --list                 # List all memories");
        }

        console.log("");
    });

// ============================================
// ai setup
// ============================================
program
    .command("setup")
    .description("Setup shell hook for terminal monitoring")
    .action(() => {
        const hookPath = require("path").join(__dirname, "../hooks/zsh-hook.sh");

        console.log("\n🔧 AI Agent Setup");
        console.log("─".repeat(40));

        console.log("\n1️⃣  Terminal Monitoring (shell hook):");
        console.log("   Add this line to your ~/.zshrc:\n");
        console.log(`   source "${hookPath}"\n`);
        console.log("   Then run: source ~/.zshrc\n");

        console.log("2️⃣  Editor Monitoring (file watcher):");
        console.log("   Run in your project directory:\n");
        console.log("   ai watch .\n");
        console.log("   This watches file changes from ANY editor.\n");

        console.log("─".repeat(40));
        console.log("Commands:");
        console.log("   ai-monitor on/off  # Toggle terminal monitoring");
        console.log("   ai watch [path]    # Start file watcher");
        console.log("   ai status          # Show current context");
        console.log("   ask \"question\"     # Quick shortcut\n");
    });

program.parse(process.argv);