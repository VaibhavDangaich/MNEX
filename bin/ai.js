#!/usr/bin/env node

/**
 * CLI Entry Point
 * No intelligence here - just wires commands to core modules
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

// Load environment variables from multiple locations (priority order):
// 1. Current working directory .env
// 2. Home directory ~/.ai-agent.env
// 3. Home directory ~/.config/ai-agent/.env
// 4. Package directory .env (fallback for development)

const envPaths = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".ai-agent.env"),
    path.join(os.homedir(), ".config", "ai-agent", ".env"),
    path.join(__dirname, "../.env"),
];

let envLoaded = false;
for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        require("dotenv").config({ path: envPath });
        envLoaded = true;
        break;
    }
}

// If no .env found and no API keys set, show warning on first run
if (!envLoaded && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    // Will show setup prompt in commands that need API keys
}

const { Command } = require("commander");
const { getGitContext } = require("../core/context");
const memory = require("../core/memory");
const conversation = require("../core/memory/conversation");
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
            const response = await llm.streamChat(question, gitContext, recalled, (chunk) => {
                process.stdout.write(chunk);
            });
            console.log("\n");

            // Save conversation for multi-turn context
            const projName = projectName || cwd.split("/").pop();
            conversation.addTurn(projName, question, response);

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
// ai sync - Sync current context to cloud
// ============================================
program
    .command("sync")
    .description("Sync current context to cloud for multi-device access")
    .action(async () => {
        const cloudsync = require("../core/memory/cloudsync");
        const working = require("../core/memory/working");
        const config = require("../core/config");
        const projectName = getProjectName();

        console.log("\n☁️  Cloud Sync");
        console.log("─".repeat(40));

        const apiKey = config.get("supermemory.apiKey");
        if (!apiKey) {
            console.log("❌ No Supermemory API key configured");
            console.log("   Run 'ai init' to set up cloud sync\n");
            return;
        }

        console.log(`📱 Device: ${cloudsync.getDeviceId()}`);
        console.log(`📁 Project: ${projectName || "global"}`);
        console.log("");

        // Sync working memory
        if (projectName) {
            const workingMem = working.get(projectName);
            console.log("📤 Syncing working context...");
            await cloudsync.syncWorkingContext(projectName, workingMem);
            console.log("   ✅ Working context synced");
        }

        // Show sync status
        console.log("\n📊 What gets synced automatically:");
        console.log("   ✓ Conversations (every ai ask)");
        console.log("   ✓ Tasks (ai task)");
        console.log("   ✓ Important file edits");
        console.log("   ✓ Git commits");
        console.log("   ✓ Memories (ai remember)");
        console.log("\n✨ Continue on any device with the same Supermemory key!\n");
    });

// ============================================
// ai handoff - Prepare for device switch
// ============================================
program
    .command("handoff")
    .description("Sync everything for seamless device handoff")
    .action(async () => {
        const cloudsync = require("../core/memory/cloudsync");
        const working = require("../core/memory/working");
        const episodic = require("../core/memory/episodic");
        const config = require("../core/config");
        const projectName = getProjectName();
        const cwd = process.cwd();
        const gitContext = getGitContext(cwd);

        console.log("\n🔄 Device Handoff");
        console.log("─".repeat(40));

        const apiKey = config.get("supermemory.apiKey");
        if (!apiKey) {
            console.log("❌ No Supermemory API key configured");
            console.log("   Run 'ai init' to enable multi-device sync\n");
            return;
        }

        console.log(`📱 From: ${cloudsync.getDeviceId()}`);
        console.log(`📁 Project: ${projectName || cwd.split("/").pop()}`);
        console.log("");

        // Gather all context
        const workingMem = projectName ? working.get(projectName) : {};
        const recentEvents = await episodic.getRecent(projectName, 10);

        const context = {
            currentTask: workingMem.currentTask,
            branch: gitContext.branch,
            recentFiles: recentEvents
                .filter(e => e.type === "editor")
                .map(e => e.file)
                .slice(0, 5),
            recentActivity: recentEvents
                .map(e => e.command || `${e.action} ${e.file}`)
                .slice(0, 5),
            summary: workingMem.context,
        };

        console.log("📤 Syncing everything...");
        const result = await cloudsync.handoff(projectName || "global", context);

        if (result.success) {
            console.log("   ✅ Context synced to cloud");
            console.log("\n🎉 Ready! Continue on any device.");
            console.log("   Just use 'ai ask' - your context is there.\n");
        } else {
            console.log(`   ❌ Sync failed: ${result.error}\n`);
        }
    });

// ============================================
// ai init - First time setup wizard
// ============================================
program
    .command("init")
    .description("Initialize AI Agent with your API keys")
    .action(async () => {
        const readline = require("readline");
        const configDir = path.join(os.homedir(), ".config", "ai-agent");
        const configFile = path.join(configDir, ".env");

        console.log("\n🤖 AI Agent Setup Wizard");
        console.log("─".repeat(40));

        // Check if already configured
        if (process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) {
            console.log("✅ API key already configured!\n");
            console.log("To reconfigure, edit: " + configFile);
            console.log("Or set environment variables: OPENAI_API_KEY / GEMINI_API_KEY\n");
            return;
        }

        console.log("\nThis will create a config file at:");
        console.log(`  ${configFile}\n`);

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

        try {
            console.log("Which LLM provider do you want to use?");
            console.log("  1) OpenAI (GPT-4, GPT-3.5)");
            console.log("  2) Google Gemini\n");

            const choice = await question("Enter 1 or 2: ");

            let envContent = "# AI Agent Configuration\n\n";

            if (choice === "1") {
                console.log("\nGet your OpenAI API key at: https://platform.openai.com/api-keys\n");
                const apiKey = await question("Enter your OpenAI API key: ");
                envContent += `LLM_PROVIDER=openai\n`;
                envContent += `OPENAI_API_KEY=${apiKey.trim()}\n`;
            } else if (choice === "2") {
                console.log("\nGet your Gemini API key at: https://makersuite.google.com/app/apikey\n");
                const apiKey = await question("Enter your Gemini API key: ");
                envContent += `LLM_PROVIDER=gemini\n`;
                envContent += `GEMINI_API_KEY=${apiKey.trim()}\n`;
            } else {
                console.log("Invalid choice. Run 'ai init' again.");
                rl.close();
                return;
            }

            console.log("\n(Optional) Supermemory for semantic memory: https://supermemory.ai");
            const superKey = await question("Enter Supermemory API key (or press Enter to skip): ");
            if (superKey.trim()) {
                envContent += `SUPERMEMORY_API_KEY=${superKey.trim()}\n`;
            }

            // Create config directory and file
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            fs.writeFileSync(configFile, envContent);

            console.log("\n✅ Configuration saved to: " + configFile);
            console.log("\n🎉 Setup complete! Try:");
            console.log('   ai ask "hello, what can you do?"\n');

        } catch (error) {
            console.error("Setup failed:", error.message);
        } finally {
            rl.close();
        }
    });

// ============================================
// ai setup - Show setup instructions
// ============================================
program
    .command("setup")
    .description("Show setup instructions for monitoring")
    .action(() => {
        const hookPath = path.join(__dirname, "../hooks/zsh-hook.sh");
        const configFile = path.join(os.homedir(), ".config", "ai-agent", ".env");

        console.log("\n🔧 AI Agent Setup");
        console.log("─".repeat(40));

        // Check API key status
        if (process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) {
            console.log("✅ API Key: Configured");
        } else {
            console.log("❌ API Key: Not configured");
            console.log("   Run: ai init\n");
        }

        console.log("\n1️⃣  Terminal Monitoring (shell hook):");
        console.log("   Add this line to your ~/.zshrc:\n");
        console.log(`   source "${hookPath}"\n`);
        console.log("   Then run: source ~/.zshrc\n");

        console.log("2️⃣  Editor Monitoring (file watcher):");
        console.log("   Run in your project directory:\n");
        console.log("   ai watch .\n");
        console.log("   This watches file changes from ANY editor.\n");

        console.log("─".repeat(40));
        console.log("Config file: " + configFile);
        console.log("\nCommands:");
        console.log("   ai init            # Setup API keys");
        console.log("   ai-monitor on/off  # Toggle terminal monitoring");
        console.log("   ai watch [path]    # Start file watcher");
        console.log("   ai status          # Show current context");
        console.log('   ai ask "question"  # Ask the AI\n');
    });

program.parse(process.argv);