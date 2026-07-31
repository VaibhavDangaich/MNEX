#!/usr/bin/env node

/**
 * CLI Entry Point
 * No intelligence here - just wires commands to core modules
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

// Load environment variables. Search order (and the legacy fallbacks that keep
// pre-rename installs working) is defined once in core/paths.js so the CLI and
// the background daemon can never disagree about where the API key lives.
const corePaths = require("../core/paths");

const envPaths = [
    ...corePaths.envCandidates(process.cwd()),
    path.join(__dirname, "../.env"), // dev checkout fallback
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
    .name("mnex")
    .description("mnex — cognitive-architecture AI coding agent with persistent memory")
    // Read from package.json rather than a literal — the hardcoded string had
    // already drifted a patch release behind (reported 1.5.0 while the package
    // was 1.5.1), which makes bug reports point at the wrong version.
    .version(require("../package.json").version);

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
    .option("--agent", "Use the LangGraph agent (recall → plan → execute → critic)")
    .option("--trace", "Print the agent execution trace (implies --agent)")
    .option("--route <mode>", "Force routing: memory | ollama | cloud")
    .action(async (question, options) => {
        const cwd = process.cwd();
        const gitContext = getGitContext(cwd);
        const projectName = getProjectName();

        console.log("\n🧠 mnex");
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
        
        // Get cross-project intelligence if available
        let crossProjectContext = null;
        try {
            const crossproject = require("../core/agent/crossproject");
            const configModule = require("../core/config");
            const supermemoryKey = configModule.get("supermemory.apiKey");
            if (supermemoryKey) {
                crossProjectContext = await crossproject.getCrossProjectContext(
                    question, 
                    projectName, 
                    supermemoryKey
                );
            }
            // Auto-register current project
            if (projectName) {
                crossproject.autoRegister(cwd);
            }
        } catch (e) {
            // Silently ignore cross-project errors
        }
        
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
        if (crossProjectContext) {
            console.log(`🧠 Cross-project: Found similar work`);
        }

        console.log("─".repeat(40));

        // Debug: show full prompt
        if (options.debug) {
            const promptDebug = await formatForDisplay(question, gitContext, recalled);
            console.log("\n[DEBUG] Full Prompt:\n");
            console.log(promptDebug);
            if (crossProjectContext) {
                console.log("\n[DEBUG] Cross-Project Context:\n");
                console.log(crossProjectContext);
            }
            console.log("\n" + "─".repeat(40));
        }

        // Add cross-project context to recalled memories
        if (crossProjectContext) {
            recalled.crossProject = crossProjectContext;
        }

        try {
            const useAgent = options.agent || options.trace;
            const router = require("../core/llm/router");
            const preferences = require("../core/agent/preferences");

            // ── AGENT PATH (LangGraph) ──
            if (useAgent) {
                console.log("\n🧠 Agent mode (recall → plan → execute → critic)\n");
                const agent = require("../core/agent/graph");
                const result = await agent.run({
                    question,
                    project: projectName,
                    context: gitContext,
                });
                const answer = result.final || result.draft || "(no answer)";
                console.log("💬 Response:\n");
                console.log(answer);
                console.log("");

                if (options.trace) {
                    console.log(agent.renderTrace(result));
                }

                const projName = projectName || cwd.split("/").pop();
                await conversation.addTurn(projName, question, answer);
                const sid = preferences.registerSuggestion({ question, answer, project: projName });
                console.log(`\n💡 Rate this answer: mnex suggest feedback ${sid} accept|reject [reason]`);
                return;
            }

            // ── ROUTER PATH (local-first) ──
            const routed = await router.route(question, {
                memory: recalled,
                forceRoute: options.route || null,
            });

            console.log(`\n🚏 Route: ${routed.route}${routed.classification ? ` (${routed.classification})` : ""}\n`);

            if (routed.route === "memory") {
                const answer = router.answerFromMemory(question, recalled);
                console.log(answer);
                const projName = projectName || cwd.split("/").pop();
                await conversation.addTurn(projName, question, answer);
                return;
            }

            if (routed.route === "ollama") {
                const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
                const messages = await require("../core/prompt").getMessages(question, gitContext, recalled);
                const plain = messages.map((m) => ({
                    role: m._getType() === "human" ? "user" : "system",
                    content: m.content,
                }));
                const out = await router.ollamaChat(plain);
                console.log("💬 Response:\n");
                console.log(out.content);
                const projName = projectName || cwd.split("/").pop();
                await conversation.addTurn(projName, question, out.content);
                return;
            }

            // ── CLOUD STREAM (default) ──
            console.log("💬 Response:\n");
            const response = await llm.streamChat(question, gitContext, recalled, (chunk) => {
                process.stdout.write(chunk);
            });
            console.log("\n");
            const projName = projectName || cwd.split("/").pop();
            await conversation.addTurn(projName, question, response);

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

        console.log("\n📊 mnex Status");
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
// ai watch [path] - with proactive suggestions
// ============================================
program
    .command("watch [path]")
    .description("Watch a directory for file changes with proactive AI suggestions and error detection")
    .option("--proactive", "Enable proactive suggestions (Spidey Sense)")
    .option("--errors", "Enable real-time error detection with notifications")
    .option("--service", "Run as background service (for LaunchAgent)")
    .option("--notify", "Send macOS notifications for alerts")
    .action(async (watchPath, options) => {
        const filewatcher = require("../core/monitor/filewatcher");
        const proactive = require("../core/agent/proactive");
        const serviceManager = require("../core/service/manager");
        const targetPath = watchPath || process.cwd();
        const isService = options.service;
        const enableNotify = options.notify || isService;
        const enableErrors = options.errors || options.proactive; // Errors enabled with --proactive too

        if (!isService) {
            console.log("\n👁️  mnex File Watcher");
            console.log("─".repeat(40));
            console.log(`📁 Watching: ${targetPath}`);
            console.log("📝 Tracking: .js, .ts, .py, .go, .rs, .md, etc.");
            console.log("🚫 Ignoring: node_modules, .git, dist, build");
            if (options.proactive) {
                console.log("🕷️  Spidey Sense: ENABLED (suggestions + errors)");
            } else if (options.errors) {
                console.log("🚨 Error Detection: ENABLED");
            }
            if (enableNotify) {
                console.log("🔔 Notifications: ENABLED");
            }
            console.log("🎯 Focus: Auto-tracks currently edited file");
            console.log("\nPress Ctrl+C to stop.\n");
        } else {
            // Service mode - log to file
            console.log(`[${new Date().toISOString()}] mnex service started`);
            console.log(`[${new Date().toISOString()}] Watching: ${targetPath}`);
            serviceManager.notify("mnex", "File watcher started", { subtitle: "Monitoring enabled" });
        }

        // Hook into file watcher for proactive analysis and error detection
        if (options.proactive || options.errors) {
            filewatcher.onFileChange = async (filePath, content, changeType, meta = {}) => {
                // Only run analysis on focused project files
                const isFocused = meta.isFocused !== false;
                
                try {
                    const result = await proactive.analyze(filePath, content, { 
                        cwd: targetPath,
                        isFocused,
                        enableErrors: enableErrors,
                    });
                    
                    if (!result) return;
                    
                    // Handle errors (real-time notifications already sent by analyze)
                    if (result.hasErrors && result.errors && result.errors.length > 0) {
                        if (!isService) {
                            console.log(proactive.formatSuggestion(result));
                        }
                        return; // Don't show suggestions when there are errors
                    }
                    
                    // Handle suggestions (only with --proactive)
                    if (options.proactive && result.issues && result.issues.length > 0) {
                        if (!isService) {
                            console.log(proactive.formatSuggestion(result));
                        }
                        
                        // Send notification for focused files with important issues
                        if (enableNotify && isFocused) {
                            const warnings = result.issues.filter(i => 
                                i.severity === "warning" || i.severity === "help"
                            );
                            if (warnings.length > 0) {
                                const fileName = path.basename(filePath);
                                serviceManager.notify(
                                    "🕷️ Spidey Sense", 
                                    warnings[0].message,
                                    { subtitle: fileName }
                                );
                            }
                        }
                    }
                } catch (e) {
                    if (isService) {
                        console.error(`[${new Date().toISOString()}] Proactive error:`, e.message);
                    }
                }
            };
        }

        filewatcher.start(targetPath);

        // Keep process alive
        process.on("SIGINT", async () => {
            if (!isService) console.log("\n");
            await filewatcher.stop();
            if (isService) {
                console.log(`[${new Date().toISOString()}] mnex service stopped`);
            }
            process.exit(0);
        });

        // Prevent exit
        await new Promise(() => {});
    });

// ============================================
// ai errors [file] - Check file for errors
// ============================================
program
    .command("errors [file]")
    .description("Check a file for syntax errors, security issues, logic bugs, and style problems")
    .option("-a, --all", "Check all files in current directory")
    .option("-d, --deep", "Enable AI-powered deep analysis for logic errors")
    .option("--show-last", "Show details of last notified errors")
    .option("--open", "Open the file in VS Code at the error line")
    .action(async (file, options) => {
        const proactive = require("../core/agent/proactive");
        const fs = require("fs");
        const path = require("path");
        const { exec } = require("child_process");
        const deepAnalysis = options.deep;
        
        // Handle --show-last (called when clicking notification)
        if (options.showLast) {
            const data = proactive.showLastErrors();
            if (data && options.open && data.file && data.errors.length > 0) {
                const line = data.errors[0].line || 1;
                exec(`code -g "${data.file}:${line}"`);
            }
            return;
        }
        
        async function checkFile(filePath, showProgress = false) {
            if (!fs.existsSync(filePath)) {
                console.error(`File not found: ${filePath}`);
                return [];
            }
            
            const content = fs.readFileSync(filePath, "utf-8");
            
            if (showProgress && deepAnalysis) {
                process.stdout.write(`   🧠 Analyzing ${path.basename(filePath)}...`);
            }
            
            const errors = await proactive.checkForErrors(filePath, content, { deepAnalysis });
            
            if (showProgress && deepAnalysis) {
                process.stdout.write("\r" + " ".repeat(50) + "\r");
            }
            
            return errors;
        }
        
        if (options.all) {
            // Check all JS/TS/Python files in current directory
            const extensions = [".js", ".ts", ".jsx", ".tsx", ".py", ".json"];
            const files = fs.readdirSync(process.cwd())
                .filter(f => extensions.includes(path.extname(f)))
                .filter(f => !f.includes("node_modules"));
            
            console.log("\n🔍 Checking files for errors...");
            if (deepAnalysis) {
                console.log("🧠 AI deep analysis: ENABLED (may take a moment)\n");
            } else {
                console.log("💡 Tip: Use --deep for AI-powered logic error detection\n");
            }
            
            let totalErrors = 0;
            for (const f of files) {
                const errors = await checkFile(f, true);
                if (errors.length > 0) {
                    console.log(`📁 ${f}: ${errors.length} issue(s)`);
                    errors.forEach(e => {
                        const icon = e.severity === "error" ? "❌" : 
                                     e.severity === "security" ? "🔐" : 
                                     e.severity === "warning" ? "⚠️" : "💡";
                        const source = e.source === "ai" ? " 🧠" : "";
                        console.log(`   ${icon} L${e.line}: ${e.message}${source}`);
                    });
                    totalErrors += errors.length;
                }
            }
            
            if (totalErrors === 0) {
                console.log("✅ No errors found!");
            } else {
                console.log(`\n📊 Total: ${totalErrors} issue(s) in ${files.length} files`);
            }
        } else if (file) {
            if (deepAnalysis) {
                console.log("\n🧠 Running AI deep analysis...");
            }
            
            const errors = await checkFile(file);
            
            if (errors.length === 0) {
                console.log(`\n✅ No errors in ${path.basename(file)}`);
            } else {
                console.log(`\n🚨 Found ${errors.length} issue(s) in ${path.basename(file)}:\n`);
                errors.forEach(e => {
                    const icon = e.severity === "error" ? "❌" : 
                                 e.severity === "security" ? "🔐" : 
                                 e.severity === "warning" ? "⚠️" : "💡";
                    const source = e.source === "ai" ? " (AI detected)" : "";
                    console.log(`${icon} Line ${e.line}: ${e.message}${source}`);
                    if (e.quickFix) {
                        console.log(`   💡 Quick fix: ${e.quickFix}`);
                    }
                });
            }
        } else {
            console.log("\n🔍 Error Checker");
            console.log("─".repeat(40));
            console.log("Usage:");
            console.log("  ai errors <file>        Check a specific file");
            console.log("  ai errors <file> --deep AI-powered deep analysis");
            console.log("  ai errors --all         Check all code files");
            console.log("  ai errors --all --deep  Deep analyze all files");
            console.log("\nReal-time detection:");
            console.log("  ai watch --proactive    Watch files with instant notifications\n");
        }
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
        console.log("   ✓ Conversations (every mnex ask)");
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
            console.log("   Just use 'mnex ask' - your context is there.\n");
        } else {
            console.log(`   ❌ Sync failed: ${result.error}\n`);
        }
    });

// ============================================
// mnex github - Connect and index GitHub repos
// ============================================
program
    .command("github")
    .description("Connect GitHub to expand your AI's knowledge base")
    .option("-i, --index", "Index your GitHub repos into memory")
    .option("-r, --repos", "List your repositories")
    .option("--repo <repo>", "Index a specific repo (owner/name)")
    .option("-n, --max <number>", "Max repos to index", "10")
    .option("--starred", "Include starred repos")
    .option("--resume", "Resume the last interrupted index instead of starting over")
    .action(async (options) => {
        const github = require("../core/integrations/github");
        const config = require("../core/config");

        console.log("\n🐙 GitHub Integration");
        console.log("─".repeat(40));

        const githubToken = config.get("github.token");
        const supermemoryKey = config.get("supermemory.apiKey");

        if (!githubToken) {
            console.log("❌ No GitHub token configured\n");
            console.log("To set up GitHub integration:");
            console.log("1. Create a Personal Access Token at:");
            console.log("   https://github.com/settings/tokens/new");
            console.log("   (select 'repo' scope for private repos, or just public_repo)");
            console.log("\n2. Add to your config (~/.config/mnex/.env):");
            console.log("   GITHUB_TOKEN=your_token_here\n");
            return;
        }

        if (!supermemoryKey && options.index) {
            console.log("❌ Supermemory API key required for indexing");
            console.log("   Run 'ai init' to set up Supermemory\n");
            return;
        }

        try {
            // Show user info
            const user = await github.getCurrentUser(githubToken);
            console.log(`✅ Connected as: ${user.login}`);
            console.log(`   Repos: ${user.public_repos} public, ${user.total_private_repos || 0} private\n`);

            // List repos
            if (options.repos) {
                const repos = await github.getUserRepos(githubToken, { perPage: 20 });
                console.log("📦 Your Repositories:");
                console.log("─".repeat(40));
                repos.forEach((r) => {
                    const visibility = r.private ? "🔒" : "🌐";
                    console.log(`${visibility} ${r.full_name}`);
                    if (r.description) console.log(`   ${r.description.substring(0, 60)}`);
                });
                console.log("");
                return;
            }

            // Index specific repo
            if (options.repo) {
                const [owner, name] = options.repo.split("/");
                if (!owner || !name) {
                    console.log("❌ Invalid repo format. Use: owner/repo-name");
                    return;
                }
                console.log(`📥 Indexing ${options.repo}...`);
                const result = await github.indexRepo(owner, name, githubToken, supermemoryKey);
                console.log(`\n✅ Indexed ${result.indexed} items from ${options.repo}`);
                if (result.errors.length > 0) {
                    console.log(`⚠️  ${result.errors.length} errors occurred`);
                }
                return;
            }

            // Full index
            if (options.index || options.resume) {
                console.log("📥 Starting GitHub indexing...");
                console.log(`   Max repos: ${options.max}`);
                console.log(`   Include starred: ${options.starred ? "yes" : "no"}`);
                console.log(`   Durable: every repo is a checkpointed step; ^C is safe\n`);

                const result = await github.indexUserGitHubDurable(githubToken, supermemoryKey, {
                    maxRepos: parseInt(options.max),
                    includeStarred: options.starred,
                    resume: Boolean(options.resume),
                    onProgress: ({ completed, skipped, failed, total, name }) => {
                        const done = completed + skipped + failed;
                        const tag = skipped && name ? " (already done, skipped)" : "";
                        console.log(`   [${done}/${total}] ${name}${tag}`);
                    },
                    onRetry: ({ stepName, attempt, delay }) => {
                        console.log(`   ↻ ${stepName}: attempt ${attempt + 1} failed, retrying in ${Math.round(delay / 1000)}s`);
                    },
                });

                console.log("\n" + "─".repeat(40));
                console.log(`✅ GitHub Indexing Complete!`);
                console.log(`   run id:          ${result.runId}`);
                console.log(`   📦 newly indexed: ${result.completed}`);
                console.log(`   ⏭️  skipped:       ${result.skipped} (already done in a previous run)`);
                if (result.failed > 0) {
                    console.log(`   ⚠️  failed:        ${result.failed}`);
                    console.log(`   Re-run with: mnex github --resume`);
                }
                console.log("\n🧠 Your GitHub knowledge is now in your AI's memory!");
                console.log('   Try: mnex ask "what projects am I working on?"\n');
                return;
            }

            // Default: show help
            console.log("Commands:");
            console.log("   mnex github --repos          List your repositories");
            console.log("   mnex github --index          Index all repos into memory");
            console.log("   mnex github --repo user/repo Index a specific repo");
            console.log("   mnex github --index --max 20 Index up to 20 repos");
            console.log("   mnex github --index --starred Include starred repos\n");

        } catch (error) {
            console.error("❌ Error:", error.message);
            if (error.message.includes("401")) {
                console.log("   Your GitHub token may be invalid or expired");
            }
        }
    });

// ============================================
// ai journal - Auto-document your day
// ============================================
program
    .command("journal")
    .description("Auto-generate development journal for today")
    .option("-w, --weekly", "Generate weekly summary")
    .option("-r, --read [date]", "Read a past journal entry")
    .option("-s, --search <query>", "Search past journal entries")
    .action(async (options) => {
        const journal = require("../core/agent/journal");
        const cwd = process.cwd();

        console.log("\n📝 Future You Journal");
        console.log("─".repeat(40));

        if (options.weekly) {
            console.log("📊 Generating weekly summary...\n");
            const summary = await journal.getWeeklySummary(cwd);
            console.log(summary);
            console.log("");
            return;
        }

        if (options.read) {
            const entries = journal.readJournalEntries(cwd, 7);
            if (entries.length === 0) {
                console.log("No journal entries found.\n");
                console.log("Create your first entry with: ai journal\n");
                return;
            }

            // If specific date provided
            if (typeof options.read === "string") {
                const entry = entries.find(e => e.date === options.read);
                if (entry) {
                    console.log(entry.content);
                } else {
                    console.log(`No entry found for ${options.read}`);
                }
            } else {
                // Show recent entries
                console.log("📚 Recent journal entries:\n");
                for (const entry of entries) {
                    console.log(`📅 ${entry.date}`);
                    console.log(entry.content.substring(0, 300) + "...\n");
                    console.log("─".repeat(40) + "\n");
                }
            }
            return;
        }

        if (options.search) {
            const results = journal.searchJournal(cwd, options.search);
            if (results.length === 0) {
                console.log(`No entries found matching "${options.search}"\n`);
                return;
            }
            console.log(`🔍 Found ${results.length} entries:\n`);
            for (const r of results) {
                console.log(`📅 ${r.date}`);
                console.log(`   ${r.snippet}\n`);
            }
            return;
        }

        // Default: create today's journal
        const result = await journal.createJournalEntry(cwd);
        if (result) {
            console.log("─".repeat(40));
            console.log("\n📖 Preview:\n");
            console.log(result.entry.substring(0, 500) + "...\n");
        }
    });

// ============================================
// ai projects - Cross-project intelligence
// ============================================
program
    .command("projects")
    .description("Manage cross-project intelligence")
    .option("-l, --list", "List registered projects")
    .option("-a, --add [path]", "Register a project")
    .option("-i, --index", "Index all registered projects")
    .option("--index-one <path>", "Index a specific project")
    .option("-s, --search <query>", "Search across all projects")
    .action(async (options) => {
        const crossproject = require("../core/agent/crossproject");
        const configModule = require("../core/config");
        const supermemoryKey = configModule.get("supermemory.apiKey");

        console.log("\n🧠 Cross-Project Intelligence");
        console.log("─".repeat(40));

        if (options.list) {
            const projects = crossproject.getProjects();
            if (projects.length === 0) {
                console.log("No projects registered yet.\n");
                console.log("Register projects with: ai projects --add /path/to/project\n");
                return;
            }
            console.log(`📁 ${projects.length} registered projects:\n`);
            for (const p of projects) {
                const indexed = p.indexed ? "✅" : "⏳";
                console.log(`${indexed} ${p.name}`);
                console.log(`   Path: ${p.path}`);
                console.log(`   Languages: ${p.languages.join(", ") || "unknown"}`);
                console.log(`   Frameworks: ${p.frameworks.join(", ") || "none"}`);
                console.log("");
            }
            return;
        }

        if (options.add) {
            const projectPath = typeof options.add === "string" 
                ? path.resolve(options.add) 
                : process.cwd();
            
            console.log(`📥 Registering: ${projectPath}`);
            const info = crossproject.registerProject(projectPath);
            console.log(`✅ Registered: ${info.name}`);
            console.log(`   Languages: ${info.languages.join(", ") || "detecting..."}`);
            console.log("\nTo index this project for cross-project search:");
            console.log("   ai projects --index\n");
            return;
        }

        if (options.indexOne) {
            if (!supermemoryKey) {
                console.log("❌ Supermemory API key required for indexing");
                console.log("   Run 'ai init' to configure\n");
                return;
            }
            const projectPath = path.resolve(options.indexOne);
            console.log(`📥 Indexing: ${projectPath}`);
            const result = await crossproject.indexProject(projectPath, supermemoryKey);
            console.log(`\n✅ Indexed ${result.indexed} items`);
            if (result.errors.length > 0) {
                console.log(`⚠️  ${result.errors.length} errors`);
            }
            return;
        }

        if (options.index) {
            if (!supermemoryKey) {
                console.log("❌ Supermemory API key required for indexing");
                console.log("   Run 'ai init' to configure\n");
                return;
            }
            console.log("📥 Indexing all registered projects...\n");
            const result = await crossproject.indexAllProjects(supermemoryKey);
            console.log(`\n${"─".repeat(40)}`);
            console.log(`✅ Indexed ${result.indexed}/${result.total} projects`);
            if (result.errors.length > 0) {
                console.log(`⚠️  ${result.errors.length} errors`);
            }
            console.log('\n🧠 Cross-project search enabled!');
            console.log('   Try: ai projects --search "authentication"\n');
            return;
        }

        if (options.search) {
            if (!supermemoryKey) {
                console.log("❌ Supermemory API key required for search");
                return;
            }
            console.log(`🔍 Searching across all projects: "${options.search}"\n`);
            const results = await crossproject.searchAcrossProjects(options.search, supermemoryKey);
            
            const projectNames = Object.keys(results);
            if (projectNames.length === 0) {
                console.log("No matches found.\n");
                return;
            }

            for (const project of projectNames) {
                console.log(`📁 ${project}:`);
                for (const hit of results[project].slice(0, 2)) {
                    const snippet = hit.content?.substring(0, 200) || "";
                    console.log(`   ${snippet}...\n`);
                }
            }
            return;
        }

        // Default: show help
        console.log("Manage your cross-project knowledge base.\n");
        console.log("Commands:");
        console.log("   ai projects --list              List registered projects");
        console.log("   ai projects --add [path]        Register current/specified project");
        console.log("   ai projects --index             Index all projects into memory");
        console.log("   ai projects --search <query>    Search across all projects\n");
        console.log("The more projects you index, the smarter your agent becomes!");
        console.log("It will find similar solutions you've written before.\n");
    });

// ============================================
// ai error - Error Solutions Database
// ============================================
program
    .command("error [errorMessage]")
    .description("Find or store error solutions")
    .option("-s, --solve <solution>", "Store a solution for the error")
    .action(async (errorMessage, options) => {
        const knowledge = require("../core/agent/knowledge");
        const projectName = getProjectName();

        console.log("\n🐛 Error Solutions Database");
        console.log("─".repeat(40));

        if (!errorMessage) {
            const stats = knowledge.getStats();
            console.log(`📊 ${stats.errors} error solutions stored\n`);
            console.log("Usage:");
            console.log('   ai error "Cannot read property of undefined"');
            console.log('   ai error "error message" --solve "how I fixed it"\n');
            return;
        }

        if (options.solve) {
            // Store solution
            console.log("💾 Storing solution...");
            await knowledge.storeError(errorMessage, options.solve, { project: projectName });
            console.log("✅ Solution saved!");
            console.log("   Next time you see this error, I'll remind you.\n");
        } else {
            // Search for solutions
            console.log(`🔍 Searching for: "${errorMessage.substring(0, 50)}..."\n`);
            const results = await knowledge.findErrorSolution(errorMessage);

            if (results.length === 0) {
                console.log("No solutions found for this error.");
                console.log("\nTip: When you solve it, save with:");
                console.log(`   ai error "${errorMessage.substring(0, 30)}..." --solve "your solution"\n`);
            } else {
                console.log(`Found ${results.length} solution(s):\n`);
                for (const r of results.slice(0, 3)) {
                    if (r.solution) {
                        console.log(`📁 ${r.project} (${r.date?.split("T")[0] || "cached"})`);
                        console.log(`   Error: ${r.error.substring(0, 60)}...`);
                        console.log(`   Solution: ${r.solution}\n`);
                    } else if (r.content) {
                        console.log(r.content.substring(0, 300) + "...\n");
                    }
                }
            }
        }
    });

// ============================================
// ai decide - Decision Log
// ============================================
program
    .command("decide <decision>")
    .description("Log an architectural/technical decision")
    .option("-r, --reason <reasoning>", "Why this decision was made")
    .option("-a, --alternatives <alts>", "Alternatives considered (comma-separated)")
    .option("-s, --search", "Search past decisions instead")
    .action(async (decision, options) => {
        const knowledge = require("../core/agent/knowledge");
        const projectName = getProjectName();

        console.log("\n📋 Decision Log");
        console.log("─".repeat(40));

        if (options.search) {
            // Search decisions
            console.log(`🔍 Searching: "${decision}"\n`);
            const results = await knowledge.searchDecisions(decision);

            if (results.length === 0) {
                console.log("No matching decisions found.\n");
            } else {
                console.log(`Found ${results.length} decision(s):\n`);
                for (const r of results.slice(0, 5)) {
                    if (r.decision) {
                        console.log(`📌 ${r.decision}`);
                        console.log(`   Reason: ${r.reasoning}`);
                        console.log(`   Project: ${r.project} | ${r.timestamp?.split("T")[0]}\n`);
                    } else if (r.content) {
                        console.log(r.content.substring(0, 300) + "...\n");
                    }
                }
            }
            return;
        }

        // Log decision
        const reasoning = options.reason || "No reasoning provided";
        const alternatives = options.alternatives?.split(",").map(s => s.trim()) || [];

        console.log("💾 Logging decision...");
        await knowledge.logDecision(decision, reasoning, {
            project: projectName,
            alternatives,
        });
        console.log("✅ Decision logged!\n");
        console.log(`📌 ${decision}`);
        console.log(`   Reason: ${reasoning}`);
        if (alternatives.length > 0) {
            console.log(`   Alternatives: ${alternatives.join(", ")}`);
        }
        console.log("\nSearch later with: ai decide --search \"keyword\"\n");
    });

// ============================================
// ai learned - Learning Capture
// ============================================
program
    .command("learned <insight>")
    .description("Capture a learning or insight")
    .option("-c, --category <cat>", "Category (e.g., react, git, devops)")
    .option("-s, --search", "Search past learnings instead")
    .action(async (insight, options) => {
        const knowledge = require("../core/agent/knowledge");
        const projectName = getProjectName();

        console.log("\n📚 Learning Capture");
        console.log("─".repeat(40));

        if (options.search) {
            console.log(`🔍 Searching: "${insight}"\n`);
            const results = await knowledge.searchLearnings(insight);

            if (results.length === 0) {
                console.log("No matching learnings found.\n");
            } else {
                console.log(`Found ${results.length} learning(s):\n`);
                for (const r of results.slice(0, 5)) {
                    if (r.insight) {
                        console.log(`💡 ${r.insight}`);
                        console.log(`   Category: ${r.category} | ${r.timestamp?.split("T")[0]}\n`);
                    } else if (r.content) {
                        console.log(r.content.substring(0, 300) + "...\n");
                    }
                }
            }
            return;
        }

        // Capture learning
        console.log("💾 Capturing insight...");
        await knowledge.captureLearning(insight, {
            project: projectName,
            category: options.category || "general",
        });
        console.log("✅ Learning captured!\n");
        console.log(`💡 "${insight}"`);
        console.log(`   Category: ${options.category || "general"}`);
        console.log("\nSearch later with: ai learned --search \"keyword\"\n");
    });

// ============================================
// ai snippet - Code Snippet Library
// ============================================
program
    .command("snippet <action> [name]")
    .description("Save or find code snippets")
    .option("-c, --code <code>", "The code snippet")
    .option("-l, --lang <language>", "Programming language", "javascript")
    .option("-d, --desc <description>", "Description")
    .action(async (action, name, options) => {
        const knowledge = require("../core/agent/knowledge");

        console.log("\n📦 Code Snippet Library");
        console.log("─".repeat(40));

        if (action === "save" && name) {
            if (!options.code) {
                console.log("❌ Please provide code with --code flag");
                console.log('   ai snippet save "debounce" --code "function debounce..."');
                return;
            }

            console.log("💾 Saving snippet...");
            await knowledge.saveSnippet(name, options.code, {
                language: options.lang,
                description: options.desc || "",
            });
            console.log(`✅ Snippet "${name}" saved!\n`);
            return;
        }

        if (action === "find" && name) {
            console.log(`🔍 Searching: "${name}"\n`);
            const results = await knowledge.findSnippets(name);

            if (results.length === 0) {
                console.log("No matching snippets found.\n");
            } else {
                console.log(`Found ${results.length} snippet(s):\n`);
                for (const r of results.slice(0, 3)) {
                    if (r.name) {
                        console.log(`📌 ${r.name} (${r.language})`);
                        console.log(`   ${r.description || "No description"}`);
                        console.log(`\`\`\`${r.language}`);
                        console.log(r.code.substring(0, 200));
                        console.log("```\n");
                    } else if (r.content) {
                        console.log(r.content.substring(0, 400) + "...\n");
                    }
                }
            }
            return;
        }

        if (action === "list") {
            const cache = knowledge.loadCache();
            console.log(`📊 ${cache.snippets.length} snippets stored\n`);
            for (const s of cache.snippets.slice(-10)) {
                console.log(`   • ${s.name} (${s.language})`);
            }
            return;
        }

        // Show help
        console.log("Commands:");
        console.log('   ai snippet save "name" --code "code" --lang js');
        console.log('   ai snippet find "debounce"');
        console.log("   ai snippet list\n");
    });

// ============================================
// ai remind - Smart Reminders
// ============================================
program
    .command("remind <message>")
    .description("Create context-aware reminders")
    .option("-w, --when <context>", "Trigger context (what you're working on)")
    .option("-f, --file <pattern>", "Trigger when editing files matching pattern")
    .option("-p, --project <name>", "Trigger when in specific project")
    .option("-l, --list", "List all reminders")
    .option("--clear", "Clear all reminders")
    .action(async (message, options) => {
        const reminders = require("../core/agent/reminders");

        console.log("\n⏰ Smart Reminders");
        console.log("─".repeat(40));

        if (options.list || message === "list") {
            const all = reminders.listReminders();
            if (all.length === 0) {
                console.log("No reminders set.\n");
                return;
            }
            console.log(`📌 ${all.length} reminder(s):\n`);
            for (const r of all) {
                console.log(reminders.formatReminder(r));
                console.log("");
            }
            return;
        }

        if (options.clear || message === "clear") {
            reminders.clearReminders();
            console.log("✅ All reminders cleared.\n");
            return;
        }

        // Determine trigger
        let trigger;
        if (options.file) {
            trigger = { type: "file", value: options.file };
        } else if (options.project) {
            trigger = { type: "project", value: options.project };
        } else if (options.when) {
            trigger = { type: "context", value: options.when };
        } else {
            console.log("❌ Please specify when to remind:");
            console.log('   --when "working on auth"');
            console.log('   --file "api/routes"');
            console.log('   --project "my-app"\n');
            return;
        }

        const reminder = reminders.createReminder(message, trigger);
        console.log("✅ Reminder created!\n");
        console.log(reminders.formatReminder(reminder));
        console.log("\nI'll remind you when the context matches.\n");
    });

// ============================================
// ai knowledge - Knowledge Base Stats
// ============================================
program
    .command("knowledge")
    .description("View your personal knowledge base statistics")
    .action(async () => {
        const knowledge = require("../core/agent/knowledge");
        const config = require("../core/config");

        console.log("\n🧠 Personal Knowledge Base");
        console.log("─".repeat(40));

        const stats = knowledge.getStats();
        const supermemoryKey = config.get("supermemory.apiKey");

        console.log(`📊 Local Cache:`);
        console.log(`   🐛 Error Solutions: ${stats.errors}`);
        console.log(`   📋 Decisions: ${stats.decisions}`);
        console.log(`   📚 Learnings: ${stats.learnings}`);
        console.log(`   📦 Snippets: ${stats.snippets}`);
        console.log(`   ─────────────────`);
        console.log(`   Total: ${stats.total} items\n`);

        if (supermemoryKey) {
            console.log("☁️  Supermemory: Connected");
            console.log("   All items synced to cloud for cross-device access.\n");
        } else {
            console.log("☁️  Supermemory: Not configured");
            console.log("   Run 'ai init' to enable cloud sync.\n");
        }

        console.log("Commands:");
        console.log("   ai error      - Error solutions database");
        console.log("   ai decide     - Decision log");
        console.log("   ai learned    - Learning capture");
        console.log("   ai snippet    - Code snippet library");
        console.log("   ai remind     - Smart reminders\n");
    });

// ============================================
// ai init - First time setup wizard
// ============================================
program
    .command("init")
    .description("Initialize mnex with your API keys")
    .action(async () => {
        const readline = require("readline");
        const configDir = path.join(os.homedir(), ".config", "mnex");
        const configFile = path.join(configDir, ".env");

        console.log("\n🧠 mnex Setup Wizard");
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

            let envContent = "# mnex Configuration\n\n";

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

            console.log("\n(Optional) GitHub for knowledge expansion: https://github.com/settings/tokens");
            const githubToken = await question("Enter GitHub Personal Access Token (or press Enter to skip): ");
            if (githubToken.trim()) {
                envContent += `GITHUB_TOKEN=${githubToken.trim()}\n`;
            }

            // Create config directory and file
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            fs.writeFileSync(configFile, envContent);

            console.log("\n✅ Configuration saved to: " + configFile);
            console.log("\n🎉 Setup complete! Try:");
            console.log('   mnex ask "hello, what can you do?"');
            if (githubToken.trim()) {
                console.log('   ai github --index  # Index your GitHub repos\n');
            } else {
                console.log("");
            }

        } catch (error) {
            console.error("Setup failed:", error.message);
        } finally {
            rl.close();
        }
    });

// ============================================
// ai focus - Set/show the currently focused file/project
// ============================================
program
    .command("focus [path]")
    .description("Set or show the currently focused file/project")
    .action(async (focusPath) => {
        const filewatcher = require("../core/monitor/filewatcher");

        console.log("\n🎯 AI Agent Focus");
        console.log("─".repeat(40));

        if (focusPath) {
            // Set focus
            const resolvedPath = path.resolve(focusPath);
            if (!fs.existsSync(resolvedPath)) {
                console.log(`❌ Path does not exist: ${resolvedPath}`);
                return;
            }

            const focus = filewatcher.setFocus(resolvedPath);
            console.log(`✅ Focus set to:`);
            console.log(`   📁 Project: ${focus.project}`);
            console.log(`   📄 File: ${path.basename(focus.file)}`);
            console.log(`   🕐 Since: ${new Date(focus.timestamp).toLocaleTimeString()}`);
            console.log("\n💡 Notifications will now prioritize this project.\n");
        } else {
            // Show current focus
            const focus = filewatcher.getFocus();
            if (focus) {
                console.log(`📁 Currently focused on:`);
                console.log(`   Project: ${focus.project}`);
                console.log(`   File: ${path.basename(focus.file)}`);
                console.log(`   Since: ${new Date(focus.timestamp).toLocaleTimeString()}`);
                console.log("\n💡 Focus auto-updates when you edit files.\n");
            } else {
                console.log("No focus set yet.");
                console.log("\n💡 Focus is auto-set when you:");
                console.log("   • Edit and save a file");
                console.log("   • Run: ai focus <path>");
                console.log("   • Change directory in terminal\n");
            }
        }
    });

// ============================================
// ai service - Manage background services
// ============================================
program
    .command("service <action>")
    .description("Manage background services (start/stop/status/logs)")
    .option("--clear", "Clear logs (with logs action)")
    .action(async (action, options) => {
        const serviceManager = require("../core/service/manager");
        const readline = require("readline");

        console.log("\n🔧 AI Agent Service Manager");
        console.log("─".repeat(40));

        switch (action) {
            case "start":
                try {
                    // First check config
                    const configCheck = serviceManager.checkRequiredConfig();
                    
                    // Check if config is missing
                    if (!configCheck.configured) {
                        console.log("❌ Missing required configuration:\n");
                        for (const missing of configCheck.missing) {
                            console.log(`   • ${missing}`);
                        }
                        console.log("\n💡 Run 'ai init' to configure your API keys first.");
                        
                        // Prompt user
                        const rl = readline.createInterface({
                            input: process.stdin,
                            output: process.stdout
                        });
                        
                        const answer = await new Promise(resolve => {
                            rl.question("\nWould you like to run 'ai init' now? (y/n): ", resolve);
                        });
                        rl.close();
                        
                        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
                            console.log("\n");
                            const initCommand = program.commands.find(c => c.name() === 'init');
                            if (initCommand) {
                                await initCommand.parseAsync([], { from: 'user' });
                            }
                        }
                        return;
                    }

                    // 🔐 ASK FOR PERMISSION BEFORE ACCESSING SENSITIVE KEYS
                    const sensitiveKeys = serviceManager.getSensitiveKeys(configCheck.envVars);
                    
                    if (sensitiveKeys.length > 0) {
                        console.log("🔐 Permission Required");
                        console.log("─".repeat(40));
                        console.log("\nTo run background services, AI Agent needs to embed");
                        console.log("the following credentials in the LaunchAgent config:\n");
                        
                        for (const key of sensitiveKeys) {
                            const maskedValue = serviceManager.maskKey(configCheck.envVars[key]);
                            console.log(`   • ${key}: ${maskedValue}`);
                        }
                        
                        console.log("\n⚠️  These will be stored in:");
                        console.log(`   ${serviceManager.PLIST_PATH}`);
                        console.log("\n   This file is only readable by your user account.");
                        
                        const rl = readline.createInterface({
                            input: process.stdin,
                            output: process.stdout
                        });
                        
                        const consent = await new Promise(resolve => {
                            rl.question("\nAllow access to these credentials? (y/n): ", resolve);
                        });
                        rl.close();
                        
                        if (consent.toLowerCase() !== 'y' && consent.toLowerCase() !== 'yes') {
                            console.log("\n❌ Permission denied. Services not started.");
                            console.log("   You can still use 'ai watch --proactive' manually.\n");
                            return;
                        }
                        
                        console.log("\n✅ Permission granted.\n");
                    }

                    console.log("Starting all services...\n");
                    const results = await serviceManager.startAllServices();

                    console.log("📊 Service Status:");
                    console.log("─".repeat(30));

                    // Terminal Monitor
                    const tm = results.terminalMonitor;
                    console.log(`  Terminal Monitor: ${tm.success ? "✅ " + tm.message : "❌ " + tm.message}`);
                    if (tm.note) console.log(`    ↳ ${tm.note}`);

                    // File Watcher
                    const fw = results.fileWatcher;
                    console.log(`  File Watcher:     ${fw.success ? "✅ " + fw.message : "❌ " + fw.message}`);

                    // Proactive Analyzer
                    const pa = results.proactiveAnalyzer;
                    console.log(`  Proactive Mode:   ${pa.success ? "✅ " + pa.message : "❌ " + pa.message}`);

                    console.log("\n💡 Services are configured to auto-start on login.");
                    console.log("   View logs: ai service logs");
                    console.log("");
                } catch (e) {
                    console.error("❌ Failed to start services:", e.message);
                }
                break;

            case "stop":
                console.log("Stopping all services...\n");
                try {
                    const results = await serviceManager.stopAllServices();

                    console.log("📊 Service Status:");
                    console.log("─".repeat(30));
                    console.log(`  Terminal Monitor: ${results.terminalMonitor.success ? "✅ Stopped" : "❌ " + results.terminalMonitor.message}`);
                    if (results.terminalMonitor.note) console.log(`    ↳ ${results.terminalMonitor.note}`);
                    console.log(`  File Watcher:     ${results.fileWatcher.success ? "✅ Stopped" : "❌ " + results.fileWatcher.message}`);
                    console.log(`  Proactive Mode:   ✅ Stopped`);
                    console.log("");
                } catch (e) {
                    console.error("❌ Failed to stop services:", e.message);
                }
                break;

            case "status":
                try {
                    const status = await serviceManager.getServiceStatus();
                    const filewatcher = require("../core/monitor/filewatcher");
                    const focus = filewatcher.getFocus();

                    console.log("📊 Current Service Status:\n");

                    // Terminal Monitor
                    const tm = status.terminalMonitor;
                    const tmIcon = tm.running ? "🟢" : "🔴";
                    console.log(`  ${tmIcon} Terminal Monitor`);
                    console.log(`     Type: ${tm.type}`);
                    console.log(`     Status: ${tm.running ? "Running" : "Not configured"}`);
                    console.log(`     Description: Tracks commands you run in terminal`);
                    console.log("");

                    // File Watcher
                    const fw = status.fileWatcher;
                    const fwIcon = fw.running ? "🟢" : "🔴";
                    console.log(`  ${fwIcon} File Watcher`);
                    console.log(`     Type: ${fw.type}`);
                    console.log(`     Status: ${fw.running ? "Running" : "Stopped"}`);
                    console.log(`     Description: Monitors file changes in watched directories`);
                    console.log("");

                    // Proactive Analyzer
                    const pa = status.proactiveAnalyzer;
                    const paIcon = pa.running ? "🟢" : "🔴";
                    console.log(`  ${paIcon} Proactive Analyzer (Spidey Sense)`);
                    console.log(`     Type: ${pa.type}`);
                    console.log(`     Status: ${pa.running ? "Running" : "Stopped"}`);
                    console.log(`     Description: Real-time code suggestions & notifications`);
                    console.log("");

                    // Current Focus
                    console.log("  🎯 Current Focus");
                    if (focus) {
                        console.log(`     Project: ${focus.project}`);
                        console.log(`     File: ${path.basename(focus.file)}`);
                        console.log(`     Since: ${new Date(focus.timestamp).toLocaleTimeString()}`);
                    } else {
                        console.log(`     No focus set (auto-sets when you edit files)`);
                    }
                    console.log("");

                    // Summary
                    const runningCount = [tm.running, fw.running, pa.running].filter(Boolean).length;
                    console.log("─".repeat(40));
                    console.log(`  ${runningCount}/3 services running\n`);

                    if (runningCount < 3) {
                        console.log("💡 Start all services: ai service start\n");
                    }
                } catch (e) {
                    console.error("❌ Failed to get status:", e.message);
                }
                break;

            case "logs":
                if (options.clear) {
                    serviceManager.clearLogs();
                    console.log("✅ Logs cleared\n");
                } else {
                    console.log("📜 Recent Service Logs:\n");
                    console.log("─".repeat(40));
                    const logs = serviceManager.getLogs(100);
                    if (logs) {
                        console.log(logs);
                    } else {
                        console.log("No logs yet. Service may not have started.");
                    }
                    console.log("\n" + "─".repeat(40));
                    console.log("Clear logs: ai service logs --clear\n");
                }
                break;

            case "restart":
                console.log("Restarting all services...\n");
                try {
                    await serviceManager.stopAllServices();
                    console.log("⏳ Stopped. Starting...\n");
                    const results = await serviceManager.startAllServices();
                    console.log("✅ All services restarted\n");
                } catch (e) {
                    console.error("❌ Failed to restart:", e.message);
                }
                break;

            default:
                console.log("Unknown action. Available actions:");
                console.log("  ai service start    - Start all background services");
                console.log("  ai service stop     - Stop all services");
                console.log("  ai service status   - Show service status");
                console.log("  ai service logs     - View service logs");
                console.log("  ai service restart  - Restart all services");
                console.log("");
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
        const configFile = require("../core/paths").ENV_FILE;

        console.log("\n🔧 AI Agent Setup");
        console.log("─".repeat(40));

        // Check API key status
        if (process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) {
            console.log("✅ API Key: Configured");
        } else {
            console.log("❌ API Key: Not configured");
            console.log("   Run: ai init\n");
        }

        console.log("\n🚀 Quick Start (Recommended):");
        console.log("   Run this single command to enable everything:\n");
        console.log("   ai service start\n");
        console.log("   This will:");
        console.log("   • Install terminal monitoring (zsh hook)");
        console.log("   • Start file watcher (auto-starts on login)");
        console.log("   • Enable proactive suggestions with notifications");
        console.log("");

        console.log("─".repeat(40));
        console.log("\n📖 Manual Setup (Alternative):\n");

        console.log("1️⃣  Terminal Monitoring (shell hook):");
        console.log("   Add this line to your ~/.zshrc:\n");
        console.log(`   source "${hookPath}"\n`);
        console.log("   Then run: source ~/.zshrc\n");

        console.log("2️⃣  Editor Monitoring (file watcher):");
        console.log("   Run in your project directory:\n");
        console.log("   ai watch .\n");

        console.log("─".repeat(40));
        console.log("Config file: " + configFile);
        console.log("\nCommands:");
        console.log("   ai init            # Setup API keys");
        console.log("   ai service start   # Start all background services");
        console.log("   ai service status  # Check service status");
        console.log("   ai status          # Show current context");
        console.log('   ai ask "question"  # Ask the AI\n');
    });

// ============================================
// ai profile — Developer DNA
// ============================================
program
    .command("profile")
    .description("Generate a Developer DNA profile from your work history")
    .option("--json", "Output machine-readable JSON")
    .action((options) => {
        const profile = require("../core/agent/profile");
        if (options.json) {
            console.log(JSON.stringify(profile.build(), null, 2));
        } else {
            console.log(profile.format());
        }
    });

// ============================================
// ai eval — Eval harness
// ============================================
const evalCmd = program.command("eval").description("Run regression evals on the agent");

evalCmd
    .command("run")
    .description("Run the eval suite")
    .option("--baseline", "Save this run as the new baseline")
    .action(async (options) => {
        const runner = require("../core/eval/runner");
        console.log("Running eval suite…\n");
        const report = await runner.runSuite({ project: getProjectName() });
        const baseline = runner.loadBaseline();
        const diff = runner.diffBaseline(report, baseline);
        console.log(runner.formatReport(report, diff));
        if (options.baseline) {
            runner.saveBaseline(report);
            console.log("\n📌 Saved as new baseline.");
        }
    });

evalCmd
    .command("add <question>")
    .description("Add a case (uses a default min_length expectation)")
    .option("--contains <text>", "Require answer to contain this substring")
    .action((question, options) => {
        const runner = require("../core/eval/runner");
        const expect = options.contains
            ? { contains_any: [options.contains], min_length: 10 }
            : { min_length: 10 };
        const id = runner.addCase(question, expect);
        console.log(`Added case ${id}`);
    });

evalCmd
    .command("baseline")
    .description("Re-run the suite and store results as the new baseline")
    .action(async () => {
        const runner = require("../core/eval/runner");
        const report = await runner.runSuite({ project: getProjectName() });
        runner.saveBaseline(report);
        console.log("📌 Baseline updated.");
    });

// ============================================
// ai graph — Causal work graph
// ============================================
const graphCmd = program.command("graph").description("Query the causal work graph");

graphCmd
    .command("stats")
    .description("Show graph stats (nodes, edges, types)")
    .action(() => {
        const causal = require("../core/memory/causal");
        const s = causal.stats();
        console.log(`Nodes: ${s.totalNodes}   Edges: ${s.totalEdges}`);
        console.log("\nBy type:");
        for (const t of s.byType) console.log(`  ${t.type.padEnd(14)} ${t.c}`);
        console.log("\nBy relation:");
        for (const r of s.byRelation) console.log(`  ${r.relation.padEnd(14)} ${r.c}`);
    });

graphCmd
    .command("search <query>")
    .description("Full-text search across the work graph")
    .option("--project <name>", "Limit to a project")
    .action((query, options) => {
        const causal = require("../core/memory/causal");
        const rows = causal.search(query, { project: options.project, limit: 20 });
        if (!rows.length) return console.log("No matches.");
        for (const r of rows) console.log(`[${r.type}] ${r.label} (${r.ts.slice(0, 16)})`);
    });

graphCmd
    .command("ask <question>")
    .description("Natural-language query against the graph (LLM → SQL)")
    .action(async (question) => {
        const causal = require("../core/memory/causal");
        try {
            const { sql, rows } = await causal.askGraph(question, {
                project: getProjectName(),
            });
            console.log(`\nSQL: ${sql}\n`);
            if (!rows.length) return console.log("(no rows)");
            for (const r of rows.slice(0, 20)) {
                console.log(JSON.stringify(r, null, 0));
            }
        } catch (e) {
            console.error("Graph query failed:", e.message);
            process.exit(1);
        }
    });

// ============================================
// ai stats — Observability
// ============================================
program
    .command("stats")
    .description("LLM call telemetry: cost, latency, routing")
    .option("--days <n>", "Window in days", "7")
    .option("--project <name>", "Limit to a project")
    .option("--recent <n>", "Show the last N calls", "0")
    .action((options) => {
        const obs = require("../core/obs/tracker");
        const days = parseInt(options.days) || 7;
        const project = options.project || null;

        if (parseInt(options.recent) > 0) {
            const rows = obs.recent(parseInt(options.recent), project);
            for (const r of rows) {
                console.log(
                    `${r.ts.slice(0, 19)} | ${(r.route || "").padEnd(14)} | ` +
                    `${(r.model || "").padEnd(18)} | ${String(r.latency_ms).padStart(6)}ms | ` +
                    `$${(r.cost_usd || 0).toFixed(5)} | ${r.success ? "✓" : "✗"}`
                );
            }
            return;
        }

        const s = obs.summary({ days, project });
        console.log(`\n═══ LLM telemetry (last ${days}d${project ? ` · ${project}` : ""}) ═══`);
        console.log(`Calls:       ${s.totals.calls || 0}`);
        console.log(`Tokens:      ${s.totals.tokens || 0}`);
        console.log(`Cost:        $${(s.totals.cost || 0).toFixed(4)}`);
        console.log(`Avg latency: ${Math.round(s.totals.avg_latency || 0)}ms`);
        console.log(`Failures:    ${s.totals.failures || 0}`);
        console.log("\nBy route:");
        for (const r of s.byRoute) console.log(`  ${r.route.padEnd(14)} ${String(r.calls).padStart(5)} calls   $${(r.cost || 0).toFixed(4)}`);
        console.log("\nBy model:");
        for (const r of s.byModel) console.log(`  ${(r.model || "?").padEnd(22)} ${String(r.calls).padStart(5)} calls   ${r.tokens || 0} tok   $${(r.cost || 0).toFixed(4)}`);
        console.log("\nBy day:");
        for (const r of s.byDay) console.log(`  ${r.day}   ${String(r.calls).padStart(5)} calls   $${(r.cost || 0).toFixed(4)}`);
    });

// ============================================
// ai review — Multi-agent code review
// ============================================
program
    .command("review")
    .description("Run reviewer + tester + docsmith in parallel on the current diff")
    .option("-t, --target <ref>", "Diff target (default: HEAD)", "HEAD")
    .action(async (options) => {
        const review = require("../core/agent/review");
        console.log(`\n🔎 Reviewing vs ${options.target}…\n`);
        const t0 = Date.now();
        const result = await review.run({ target: options.target });
        console.log(result.report);
        console.log(`\n(elapsed ${result.elapsed_ms || Date.now() - t0}ms)`);
    });

// ============================================
// ai suggest — Preference learning feedback
// ============================================
const suggestCmd = program.command("suggest").description("Manage suggestion feedback");

suggestCmd
    .command("feedback <id> <verdict> [reason...]")
    .description("Record accept|reject on a suggestion id (shown after `ai ask --agent`)")
    .action((id, verdict, reason) => {
        const pref = require("../core/agent/preferences");
        try {
            pref.recordFeedback(id, verdict, (reason || []).join(" "));
            const s = pref.stats();
            console.log(`Recorded. Totals: ${s.accepted} accepted, ${s.rejected} rejected (${s.dpoPairs} DPO pairs).`);
        } catch (e) {
            console.error(e.message);
            process.exit(1);
        }
    });

suggestCmd
    .command("stats")
    .description("Preference learning stats")
    .action(() => {
        const pref = require("../core/agent/preferences");
        console.log(JSON.stringify(pref.stats(), null, 2));
    });

suggestCmd
    .command("export")
    .description("Export DPO-style (chosen, rejected) pairs as JSONL")
    .action(() => {
        const pref = require("../core/agent/preferences");
        for (const p of pref.exportPairs()) console.log(JSON.stringify(p));
    });

// ============================================
// ai plugin — Plugin system
// ============================================
const pluginCmd = program.command("plugin").description("Manage agent plugins");

pluginCmd
    .command("list")
    .description("List installed plugins")
    .action(() => {
        const loader = require("../core/plugins/loader");
        const plugins = loader.list();
        if (!plugins.length) {
            console.log("No plugins installed.");
            console.log(`\nInstall by dropping a .js file into: ${loader.USER_PLUGIN_DIR}`);
            console.log("Or scaffold one with: ai plugin scaffold <name>");
            return;
        }
        for (const p of plugins) {
            console.log(`\n📦 ${p.name} v${p.version}`);
            console.log(`   file:   ${p.file}`);
            if (p.tools.length) console.log(`   tools:  ${p.tools.join(", ")}`);
            if (p.hasMemory)    console.log(`   memory: yes`);
            if (p.hooks.length) console.log(`   hooks:  ${p.hooks.join(", ")}`);
        }
    });

pluginCmd
    .command("scaffold <name>")
    .description("Create a starter plugin file")
    .action((name) => {
        const loader = require("../core/plugins/loader");
        try {
            const file = loader.scaffold(name);
            console.log(`Created ${file}`);
        } catch (e) {
            console.error(e.message);
            process.exit(1);
        }
    });

// ============================================
// WORKFLOW — inspect and resume durable runs
// ============================================
program
    .command("workflow [action]")
    .description("Inspect durable runs: list | show <id> | resume | prune")
    .option("--id <runId>", "Target a specific run")
    .option("--days <n>", "Retention window for prune", "30")
    .option("--json", "Machine-readable output")
    .action(async (action = "list", options) => {
        const engine = require("../core/orchestration/engine");

        if (action === "prune") {
            const res = engine.prune({ days: parseInt(options.days) });
            console.log(`\n🧹 Pruned ${res.runs} finished run(s), ${res.steps} step(s).\n`);
            return;
        }

        if (action === "show") {
            const runId = options.id;
            if (!runId) return console.log("Usage: mnex workflow show --id <runId>");
            const run = engine.getRun(runId);
            if (!run) return console.log(`No such run: ${runId}`);
            const steps = engine.getSteps(runId);

            if (options.json) {
                console.log(JSON.stringify({ run, steps }, null, 2));
                return;
            }
            console.log(`\n🔁 ${run.workflow}  ${run.run_id}   [${run.status}]`);
            console.log("─".repeat(60));
            for (const s of steps) {
                const icon = { done: "✅", failed: "❌", in_flight: "⏳", pending: "•" }[s.status] || "•";
                const attempts = s.attempt > 0 ? `  (attempt ${s.attempt + 1})` : "";
                console.log(`${icon} ${s.step_name}${attempts}`);
                if (s.error) console.log(`     ${s.error.split("\n")[0].slice(0, 100)}`);
            }
            console.log("");
            return;
        }

        if (action === "resume") {
            // Resuming is workflow-specific; point at the command that owns it
            // rather than guessing how to rebuild the unit list here.
            const run = options.id ? engine.getRun(options.id) : engine.findResumableRun("github-index");
            if (!run) return console.log("\nNothing to resume.\n");
            console.log(`\nInterrupted run: ${run.run_id} (${run.workflow})`);
            const p = engine.runProgress(run.run_id);
            console.log(`Progress: ${p.done} done, ${p.failed} failed, ${p.total} recorded`);
            console.log(`\nResume it with:\n   mnex github --resume\n`);
            return;
        }

        // default: list
        const runs = engine.listRuns({ limit: 20 });
        if (options.json) {
            console.log(JSON.stringify(runs, null, 2));
            return;
        }
        if (!runs.length) {
            console.log("\nNo durable runs recorded yet.");
            console.log("Long operations such as `mnex github --index` create them.\n");
            return;
        }
        console.log("\n🔁 Durable runs");
        console.log("─".repeat(72));
        for (const r of runs) {
            const p = engine.runProgress(r.run_id);
            const when = new Date(r.updated_at).toISOString().replace("T", " ").slice(0, 16);
            const icon = { completed: "✅", failed: "❌", running: "⏳" }[r.status] || "•";
            console.log(`${icon} ${r.run_id}  ${r.workflow.padEnd(16)} ${when}  ${p.done}/${p.total} steps`);
        }
        console.log("\nInspect one:  mnex workflow show --id <runId>");
        console.log("Clean up:     mnex workflow prune --days 30\n");
    });

program.parse(process.argv);