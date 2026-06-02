/**
 * Service Manager
 * Manages all background services:
 * - Terminal monitoring (zsh hook)
 * - File watcher
 * - Proactive analyzer
 * 
 * Provides macOS notifications for alerts
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec, spawn } = require("child_process");

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".config", "ai-agent");
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const PLIST_NAME = "com.ai-agent.watcher.plist";
const LAUNCH_AGENTS_DIR = path.join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME);
const LOG_PATH = path.join(CONFIG_DIR, "service.log");
const PID_PATH = path.join(CONFIG_DIR, "watcher.pid");

/**
 * Load environment variables from config file
 */
function loadEnvFromConfig() {
    const envVars = {};
    
    // Check multiple possible .env locations
    const envPaths = [
        ENV_FILE,
        path.join(HOME, ".ai-agent.env"),
        path.join(process.cwd(), ".env"),
    ];

    for (const envPath of envPaths) {
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, "utf-8");
            const lines = content.split("\n");
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("#")) {
                    const match = trimmed.match(/^([^=]+)=(.*)$/);
                    if (match) {
                        const key = match[1].trim();
                        let value = match[2].trim();
                        // Remove quotes if present
                        if ((value.startsWith('"') && value.endsWith('"')) ||
                            (value.startsWith("'") && value.endsWith("'"))) {
                            value = value.slice(1, -1);
                        }
                        envVars[key] = value;
                    }
                }
            }
            break; // Use first found .env file
        }
    }

    return envVars;
}

/**
 * Check if required API keys are configured
 * API keys are REQUIRED for the agent to work
 */
function checkRequiredConfig() {
    const envVars = loadEnvFromConfig();
    const missing = [];
    
    // Check for at least one LLM API key - REQUIRED
    const hasLLMKey = !!(envVars.OPENAI_API_KEY || envVars.GEMINI_API_KEY || 
                      process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
    
    if (!hasLLMKey) {
        missing.push("LLM API Key (OPENAI_API_KEY or GEMINI_API_KEY)");
    }

    const hasSupermemory = !!(envVars.SUPERMEMORY_API_KEY || process.env.SUPERMEMORY_API_KEY);

    return {
        configured: missing.length === 0,
        missing,
        hasLLMKey,
        hasSupermemory,
        envVars,
    };
}

/**
 * Get list of sensitive keys that would be embedded
 */
function getSensitiveKeys(envVars) {
    const sensitivePatterns = ['API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'CREDENTIAL'];
    const sensitiveKeys = [];
    
    for (const key of Object.keys(envVars)) {
        if (sensitivePatterns.some(pattern => key.toUpperCase().includes(pattern))) {
            sensitiveKeys.push(key);
        }
    }
    
    return sensitiveKeys;
}

/**
 * Mask a key for display (show first 8 and last 4 chars)
 */
function maskKey(value) {
    if (!value || value.length < 16) return "***";
    return value.substring(0, 8) + "..." + value.substring(value.length - 4);
}

/**
 * Get the path to the ai.js binary
 */
function getAIPath() {
    // First check if we're running from npm global
    const npmGlobal = process.env.npm_config_prefix || "/usr/local";
    const possiblePaths = [
        path.join(npmGlobal, "lib", "node_modules", "@vaibhav_dangaich", "ai-agent", "bin", "ai.js"),
        path.join(HOME, ".npm-global", "lib", "node_modules", "@vaibhav_dangaich", "ai-agent", "bin", "ai.js"),
        path.join(__dirname, "..", "bin", "ai.js"),
        // For local development
        path.join(process.cwd(), "bin", "ai.js"),
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) return p;
    }

    // Fallback: use 'which' to find it
    return null;
}

/**
 * Send macOS notification
 */
function notify(title, message, options = {}) {
    const { sound = "default", subtitle = "" } = options;

    // Escape quotes in message
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedMessage = message.replace(/"/g, '\\"');
    const escapedSubtitle = subtitle.replace(/"/g, '\\"');

    const script = `display notification "${escapedMessage}" with title "${escapedTitle}"${subtitle ? ` subtitle "${escapedSubtitle}"` : ""}${sound ? ` sound name "${sound}"` : ""}`;

    exec(`osascript -e '${script}'`, (err) => {
        if (err) {
            console.error("Notification failed:", err.message);
        }
    });
}

/**
 * Generate LaunchAgent plist content
 */
function generatePlist(watchPaths = [], envVars = {}) {
    const aiPath = getAIPath();
    const nodePath = process.execPath;

    // Default to watching home directory - but we limit depth and use smart ignores
    const defaultPaths = [
        path.join(HOME, "Desktop"),
        path.join(HOME, "Documents"),
        path.join(HOME, "Projects"),
        path.join(HOME, "code"),
        path.join(HOME, "dev"),
        path.join(HOME, "workspace"),
        path.join(HOME, "src"),
    ].filter(p => fs.existsSync(p));

    // Use only the first available path to prevent EMFILE
    // The watcher will still track focus across all projects
    const pathToWatch = watchPaths.length > 0 ? watchPaths[0] : (defaultPaths[0] || HOME);

    // Build environment variables XML
    let envXml = `
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>`;
    
    // Add custom environment variables
    for (const [key, value] of Object.entries(envVars)) {
        if (value) {
            envXml += `
        <key>${key}</key>
        <string>${value}</string>`;
        }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ai-agent.watcher</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${aiPath}</string>
        <string>watch</string>
        <string>${pathToWatch}</string>
        <string>--proactive</string>
        <string>--service</string>
    </array>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
    
    <key>WorkingDirectory</key>
    <string>${HOME}</string>
    
    <key>EnvironmentVariables</key>
    <dict>${envXml}
    </dict>
    
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;
}

/**
 * Install the LaunchAgent
 */
async function installLaunchAgent(watchPaths = [], envVars = {}) {
    // Ensure directories exist
    if (!fs.existsSync(LAUNCH_AGENTS_DIR)) {
        fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Generate and write plist with environment variables
    const plist = generatePlist(watchPaths, envVars);
    fs.writeFileSync(PLIST_PATH, plist);

    console.log("✅ LaunchAgent installed at:", PLIST_PATH);
    return true;
}

/**
 * Start the LaunchAgent service
 */
async function startService() {
    return new Promise((resolve, reject) => {
        // First unload if already loaded
        exec(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, () => {
            // Then load
            exec(`launchctl load "${PLIST_PATH}"`, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`Failed to start service: ${stderr}`));
                } else {
                    resolve(true);
                }
            });
        });
    });
}

/**
 * Stop the LaunchAgent service
 */
async function stopService() {
    return new Promise((resolve, reject) => {
        exec(`launchctl unload "${PLIST_PATH}"`, (err, stdout, stderr) => {
            if (err && !stderr.includes("Could not find")) {
                reject(new Error(`Failed to stop service: ${stderr}`));
            } else {
                resolve(true);
            }
        });
    });
}

/**
 * Check if service is running
 */
async function isServiceRunning() {
    return new Promise((resolve) => {
        exec(`launchctl list | grep com.ai-agent`, (err, stdout) => {
            resolve(!err && stdout.includes("com.ai-agent"));
        });
    });
}

/**
 * Get service status
 */
async function getServiceStatus() {
    const running = await isServiceRunning();
    const plistExists = fs.existsSync(PLIST_PATH);
    const hookInstalled = await isZshHookInstalled();

    return {
        fileWatcher: {
            enabled: plistExists,
            running,
            type: "LaunchAgent",
        },
        terminalMonitor: {
            enabled: hookInstalled,
            running: hookInstalled, // If hook is installed, it's always "running"
            type: "zsh hook",
        },
        proactiveAnalyzer: {
            enabled: plistExists,
            running,
            type: "LaunchAgent",
        },
    };
}

/**
 * Check if zsh hook is installed
 */
async function isZshHookInstalled() {
    const zshrcPath = path.join(HOME, ".zshrc");
    if (!fs.existsSync(zshrcPath)) return false;

    const content = fs.readFileSync(zshrcPath, "utf-8");
    return content.includes("ai-agent") || content.includes("zsh-hook.sh");
}

/**
 * Install zsh hook
 */
async function installZshHook() {
    const zshrcPath = path.join(HOME, ".zshrc");
    
    // Find the hook file
    const aiPath = getAIPath();
    if (!aiPath) {
        throw new Error("Could not find ai-agent installation");
    }

    const hookPath = path.join(path.dirname(aiPath), "..", "hooks", "zsh-hook.sh");
    
    if (!fs.existsSync(hookPath)) {
        throw new Error(`Hook file not found: ${hookPath}`);
    }

    // Check if already installed
    if (await isZshHookInstalled()) {
        return { alreadyInstalled: true, hookPath };
    }

    // Append to .zshrc
    const hookLine = `\n# AI Agent - Terminal Monitoring\nsource "${hookPath}"\n`;
    fs.appendFileSync(zshrcPath, hookLine);

    return { alreadyInstalled: false, hookPath };
}

/**
 * Uninstall zsh hook
 */
async function uninstallZshHook() {
    const zshrcPath = path.join(HOME, ".zshrc");
    if (!fs.existsSync(zshrcPath)) return;

    let content = fs.readFileSync(zshrcPath, "utf-8");
    
    // Remove AI Agent lines
    content = content
        .split("\n")
        .filter(line => !line.includes("ai-agent") && !line.includes("zsh-hook.sh") && !line.includes("AI Agent"))
        .join("\n");

    fs.writeFileSync(zshrcPath, content);
}

/**
 * Start all services with one command
 */
async function startAllServices(options = {}) {
    const results = {
        terminalMonitor: { success: false, message: "" },
        fileWatcher: { success: false, message: "" },
        proactiveAnalyzer: { success: false, message: "" },
        configCheck: { success: true, message: "" },
    };

    // Check if required config is present
    const configCheck = checkRequiredConfig();
    if (!configCheck.configured) {
        results.configCheck = {
            success: false,
            message: "Missing configuration",
            missing: configCheck.missing,
        };
        return results;
    }

    // 1. Install zsh hook for terminal monitoring
    try {
        const hookResult = await installZshHook();
        if (hookResult.alreadyInstalled) {
            results.terminalMonitor = { 
                success: true, 
                message: "Already installed",
                note: "Run 'source ~/.zshrc' to activate in current terminal"
            };
        } else {
            results.terminalMonitor = { 
                success: true, 
                message: "Installed",
                note: "Run 'source ~/.zshrc' to activate in current terminal"
            };
        }
    } catch (e) {
        results.terminalMonitor = { success: false, message: e.message };
    }

    // 2. Install and start LaunchAgent for file watcher + proactive
    // Pass environment variables to the LaunchAgent
    try {
        await installLaunchAgent(options.watchPaths || [], configCheck.envVars);
        await startService();
        results.fileWatcher = { success: true, message: "Running" };
        results.proactiveAnalyzer = { success: true, message: "Running" };
    } catch (e) {
        results.fileWatcher = { success: false, message: e.message };
        results.proactiveAnalyzer = { success: false, message: e.message };
    }

    // Send notification
    const allSuccess = Object.values(results).every(r => r.success);
    if (allSuccess) {
        notify("AI Agent", "All services started successfully", { subtitle: "Monitoring enabled" });
    }

    return results;
}

/**
 * Stop all services
 */
async function stopAllServices() {
    const results = {
        terminalMonitor: { success: false, message: "" },
        fileWatcher: { success: false, message: "" },
    };

    // 1. Uninstall zsh hook
    try {
        await uninstallZshHook();
        results.terminalMonitor = { 
            success: true, 
            message: "Removed",
            note: "Run 'source ~/.zshrc' to apply in current terminal"
        };
    } catch (e) {
        results.terminalMonitor = { success: false, message: e.message };
    }

    // 2. Stop LaunchAgent
    try {
        await stopService();
        // Also remove the plist
        if (fs.existsSync(PLIST_PATH)) {
            fs.unlinkSync(PLIST_PATH);
        }
        results.fileWatcher = { success: true, message: "Stopped" };
    } catch (e) {
        results.fileWatcher = { success: false, message: e.message };
    }

    notify("AI Agent", "All services stopped", { subtitle: "Monitoring disabled" });

    return results;
}

/**
 * View service logs
 */
function getLogs(lines = 50) {
    if (!fs.existsSync(LOG_PATH)) {
        return "No logs yet. Service may not have started.";
    }

    const content = fs.readFileSync(LOG_PATH, "utf-8");
    const allLines = content.split("\n");
    return allLines.slice(-lines).join("\n");
}

/**
 * Clear logs
 */
function clearLogs() {
    if (fs.existsSync(LOG_PATH)) {
        fs.writeFileSync(LOG_PATH, "");
    }
}

module.exports = {
    notify,
    installLaunchAgent,
    startService,
    stopService,
    isServiceRunning,
    getServiceStatus,
    installZshHook,
    uninstallZshHook,
    isZshHookInstalled,
    startAllServices,
    stopAllServices,
    getLogs,
    clearLogs,
    getAIPath,
    loadEnvFromConfig,
    checkRequiredConfig,
    getSensitiveKeys,
    maskKey,
    PLIST_PATH,
    LOG_PATH,
};
