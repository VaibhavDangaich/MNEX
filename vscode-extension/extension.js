const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

let isEnabled = true;
let statusBarItem;
let eventQueue = [];
let syncTimer = null;

// Default storage path (will be updated from config)
let storagePath = "";

/**
 * Activate the extension
 */
function activate(context) {
    console.log("AI Agent Monitor activated");

    // Load config
    const config = vscode.workspace.getConfiguration("aiAgent");
    isEnabled = config.get("enabled", true);
    storagePath = config.get("storagePath") || findStoragePath();

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = "aiAgent.toggleMonitoring";
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand("aiAgent.toggleMonitoring", toggleMonitoring),
        vscode.commands.registerCommand("aiAgent.showStatus", showStatus),
        vscode.commands.registerCommand("aiAgent.syncNow", syncNow)
    );

    // Register event listeners
    if (config.get("trackFiles", true)) {
        // Track active editor changes
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(onActiveEditorChange)
        );

        // Track file save
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(onFileSave)
        );

        // Track file open
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(onFileOpen)
        );
    }

    // Track diagnostics (errors/warnings)
    if (config.get("trackErrors", true)) {
        context.subscriptions.push(
            vscode.languages.onDidChangeDiagnostics(onDiagnosticsChange)
        );
    }

    // Track selection changes (optional, can be noisy)
    if (config.get("trackSelection", false)) {
        context.subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection(onSelectionChange)
        );
    }

    // Start sync timer (batch events every 5 seconds)
    syncTimer = setInterval(syncEvents, 5000);

    // Log initial state
    logEvent({
        type: "editor",
        action: "activated",
        workspace: getWorkspaceName(),
        timestamp: new Date().toISOString(),
    });
}

/**
 * Find the AI Agent storage path
 */
function findStoragePath() {
    // Try to find cli_agent in common locations
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const possiblePaths = [
        path.join(homeDir, "Desktop", "cli_agent", "storage"),
        path.join(homeDir, "cli_agent", "storage"),
        path.join(homeDir, ".ai-agent", "storage"),
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }

    // Default to home directory
    const defaultPath = path.join(homeDir, ".ai-agent", "storage");
    if (!fs.existsSync(defaultPath)) {
        fs.mkdirSync(defaultPath, { recursive: true });
    }
    return defaultPath;
}

/**
 * Get workspace/project name
 */
function getWorkspaceName() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return path.basename(folders[0].uri.fsPath);
    }
    return "unknown";
}

/**
 * Get relative file path
 */
function getRelativePath(uri) {
    if (!uri) return "";
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return path.relative(folders[0].uri.fsPath, uri.fsPath);
    }
    return path.basename(uri.fsPath);
}

/**
 * Toggle monitoring on/off
 */
function toggleMonitoring() {
    isEnabled = !isEnabled;
    updateStatusBar();
    vscode.window.showInformationMessage(
        `AI Agent monitoring: ${isEnabled ? "ON" : "OFF"}`
    );
}

/**
 * Update status bar
 */
function updateStatusBar() {
    if (isEnabled) {
        statusBarItem.text = "$(eye) AI";
        statusBarItem.tooltip = "AI Agent: Monitoring (click to toggle)";
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = "$(eye-closed) AI";
        statusBarItem.tooltip = "AI Agent: Paused (click to toggle)";
        statusBarItem.backgroundColor = new vscode.ThemeColor(
            "statusBarItem.warningBackground"
        );
    }
}

/**
 * Show status
 */
function showStatus() {
    const project = getWorkspaceName();
    vscode.window.showInformationMessage(
        `AI Agent | Project: ${project} | Events queued: ${eventQueue.length} | Storage: ${storagePath}`
    );
}

/**
 * Log an event to the queue
 */
function logEvent(event) {
    if (!isEnabled) return;

    eventQueue.push({
        ...event,
        project: getWorkspaceName(),
        timestamp: event.timestamp || new Date().toISOString(),
    });
}

/**
 * Sync events to storage
 */
function syncEvents() {
    if (eventQueue.length === 0) return;

    const events = [...eventQueue];
    eventQueue = [];

    try {
        const episodicFile = path.join(storagePath, "episodic.json");

        // Load existing
        let data = { events: [] };
        if (fs.existsSync(episodicFile)) {
            data = JSON.parse(fs.readFileSync(episodicFile, "utf-8"));
        }

        // Add new events
        for (const event of events) {
            data.events.unshift({
                id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                ...event,
            });
        }

        // Keep only last 200 events
        data.events = data.events.slice(0, 200);

        // Save
        fs.writeFileSync(episodicFile, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error("AI Agent sync failed:", error);
    }
}

/**
 * Force sync now
 */
function syncNow() {
    syncEvents();
    vscode.window.showInformationMessage("AI Agent: Context synced");
}

// ============================================
// Event Handlers
// ============================================

function onActiveEditorChange(editor) {
    if (!editor) return;

    logEvent({
        type: "editor",
        action: "focus",
        file: getRelativePath(editor.document.uri),
        language: editor.document.languageId,
    });
}

function onFileSave(document) {
    logEvent({
        type: "editor",
        action: "save",
        file: getRelativePath(document.uri),
        language: document.languageId,
        lineCount: document.lineCount,
    });
}

function onFileOpen(document) {
    // Ignore non-file schemes (git, output, etc)
    if (document.uri.scheme !== "file") return;

    logEvent({
        type: "editor",
        action: "open",
        file: getRelativePath(document.uri),
        language: document.languageId,
    });
}

function onDiagnosticsChange(event) {
    for (const uri of event.uris) {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        const errors = diagnostics.filter(
            (d) => d.severity === vscode.DiagnosticSeverity.Error
        );

        if (errors.length > 0) {
            logEvent({
                type: "editor",
                action: "error",
                file: getRelativePath(uri),
                errorCount: errors.length,
                errors: errors.slice(0, 3).map((e) => ({
                    message: e.message,
                    line: e.range.start.line + 1,
                })),
            });
        }
    }
}

function onSelectionChange(event) {
    const editor = event.textEditor;
    const selection = event.selections[0];

    // Only log significant selections (not just cursor moves)
    if (!selection.isEmpty) {
        logEvent({
            type: "editor",
            action: "select",
            file: getRelativePath(editor.document.uri),
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
        });
    }
}

/**
 * Deactivate the extension
 */
function deactivate() {
    if (syncTimer) {
        clearInterval(syncTimer);
    }
    syncEvents(); // Final sync
}

module.exports = {
    activate,
    deactivate,
};
