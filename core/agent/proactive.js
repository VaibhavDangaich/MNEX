/**
 * Proactive Agent - "Spidey Sense"
 * Watches your work and proactively suggests improvements
 * Now with real-time syntax error detection!
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec, execSync, spawn } = require("child_process");
const llm = require("../llm");
const config = require("../config");

// Thresholds for triggering suggestions
const THRESHOLDS = {
    duplicateCodeLines: 5,         // Lines repeated across files
    functionComplexity: 15,        // Cyclomatic complexity
    fileStuckMinutes: 20,          // Time stuck on same file
    failingTestsCommits: 2,        // Commits with failing tests
    largeFunctionLines: 50,        // Lines in a function
    todoCount: 5,                  // TODO comments in file
};

// Error detection settings
const ERROR_SETTINGS = {
    checkSyntax: true,             // Check for syntax errors
    checkSecurity: true,           // Check for hardcoded secrets
    checkStyle: true,              // Check for == vs ===
    notifyOnError: true,           // Send macOS notifications
    notifySound: true,             // Play sound with notifications
    debounceMs: 500,               // Debounce time for file changes
};

// Severity icons
const SEVERITY_ICONS = {
    error: "❌",
    warning: "⚠️",
    info: "💡",
    security: "🔐",
    help: "🤔",
    suggestion: "✨",
};

// Track state
let watchState = {
    currentFile: null,
    fileStartTime: null,
    recentChanges: [],
    lastSuggestion: null,
    suggestionsGiven: [],
    recentErrors: [],          // Track recent errors for deduplication
    errorCooldowns: new Map(), // Cooldown per file to avoid spam
};

// ============================================
// SYNTAX ERROR DETECTION
// ============================================

/**
 * Check JavaScript/TypeScript file for syntax errors
 */
function checkJavaScriptSyntax(content, filePath) {
    const errors = [];
    const lines = content.split("\n");
    
    // Track brackets and braces
    let braceStack = [];
    let parenStack = [];
    let bracketStack = [];
    let inString = false;
    let stringChar = null;
    let inComment = false;
    let inMultiLineComment = false;
    let inTemplateLiteral = false;
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        
        for (let col = 0; col < line.length; col++) {
            const char = line[col];
            const prevChar = col > 0 ? line[col - 1] : "";
            const nextChar = col < line.length - 1 ? line[col + 1] : "";
            
            // Handle comments
            if (!inString && !inTemplateLiteral) {
                if (char === "/" && nextChar === "/" && !inMultiLineComment) {
                    break; // Rest of line is comment
                }
                if (char === "/" && nextChar === "*" && !inMultiLineComment) {
                    inMultiLineComment = true;
                    col++;
                    continue;
                }
                if (char === "*" && nextChar === "/" && inMultiLineComment) {
                    inMultiLineComment = false;
                    col++;
                    continue;
                }
            }
            
            if (inMultiLineComment) continue;
            
            // Handle strings
            if (!inString && !inTemplateLiteral && (char === '"' || char === "'")) {
                inString = true;
                stringChar = char;
                continue;
            }
            if (inString && char === stringChar && prevChar !== "\\") {
                inString = false;
                stringChar = null;
                continue;
            }
            
            // Handle template literals
            if (!inString && char === "`") {
                inTemplateLiteral = !inTemplateLiteral;
                continue;
            }
            
            if (inString || inTemplateLiteral) continue;
            
            // Track brackets
            if (char === "{") {
                braceStack.push({ line: lineNum + 1, col: col + 1 });
            } else if (char === "}") {
                if (braceStack.length === 0) {
                    errors.push({
                        type: "syntax_error",
                        message: "Unexpected closing brace '}'",
                        line: lineNum + 1,
                        column: col + 1,
                        severity: "error",
                    });
                } else {
                    braceStack.pop();
                }
            }
            
            if (char === "(") {
                parenStack.push({ line: lineNum + 1, col: col + 1 });
            } else if (char === ")") {
                if (parenStack.length === 0) {
                    errors.push({
                        type: "syntax_error",
                        message: "Unexpected closing parenthesis ')'",
                        line: lineNum + 1,
                        column: col + 1,
                        severity: "error",
                    });
                } else {
                    parenStack.pop();
                }
            }
            
            if (char === "[") {
                bracketStack.push({ line: lineNum + 1, col: col + 1 });
            } else if (char === "]") {
                if (bracketStack.length === 0) {
                    errors.push({
                        type: "syntax_error",
                        message: "Unexpected closing bracket ']'",
                        line: lineNum + 1,
                        column: col + 1,
                        severity: "error",
                    });
                } else {
                    bracketStack.pop();
                }
            }
        }
        
        // Check for unclosed strings at end of line (not template literals)
        if (inString) {
            errors.push({
                type: "syntax_error",
                message: `Unclosed string (missing ${stringChar})`,
                line: lineNum + 1,
                column: line.length,
                severity: "error",
            });
            inString = false;
            stringChar = null;
        }
    }
    
    // Check for unclosed brackets
    for (const brace of braceStack) {
        errors.push({
            type: "syntax_error",
            message: "Unclosed brace '{'",
            line: brace.line,
            column: brace.col,
            severity: "error",
        });
    }
    for (const paren of parenStack) {
        errors.push({
            type: "syntax_error",
            message: "Unclosed parenthesis '('",
            line: paren.line,
            column: paren.col,
            severity: "error",
        });
    }
    for (const bracket of bracketStack) {
        errors.push({
            type: "syntax_error",
            message: "Unclosed bracket '['",
            line: bracket.line,
            column: bracket.col,
            severity: "error",
        });
    }
    
    return errors;
}

/**
 * Check Python file for syntax errors
 */
function checkPythonSyntax(content, filePath) {
    const errors = [];

    try {
        const { spawnSync } = require("child_process");
        // Pass filePath as an argument so it never touches the shell
        const script = "import ast, sys; ast.parse(open(sys.argv[1]).read())";
        const r = spawnSync("python3", ["-c", script, filePath], {
            encoding: "utf-8",
            timeout: 5000,
        });
        if (r.status !== 0 && r.stderr) {
            const match = r.stderr.match(/line (\d+)/i);
            const msgMatch = r.stderr.match(/SyntaxError: (.+)/);
            errors.push({
                type: "syntax_error",
                message: msgMatch ? msgMatch[1] : "Python syntax error",
                line: match ? parseInt(match[1]) : 1,
                severity: "error",
            });
        }
    } catch (e) {
        // Ignore if python3 not available
    }

    return errors;
}

/**
 * Check JSON file for syntax errors
 */
function checkJsonSyntax(content, filePath) {
    const errors = [];
    
    try {
        JSON.parse(content);
    } catch (e) {
        // Parse JSON error message for line/position
        const match = e.message.match(/position (\d+)/);
        let line = 1;
        if (match) {
            const pos = parseInt(match[1]);
            line = content.substring(0, pos).split("\n").length;
        }
        errors.push({
            type: "syntax_error",
            message: e.message.replace(/^JSON\.parse: /, "").replace(/ at position \d+/, ""),
            line,
            severity: "error",
        });
    }
    
    return errors;
}

/**
 * Check for security issues
 */
function checkSecurityIssues(content, filePath) {
    const issues = [];
    const lines = content.split("\n");
    
    // Patterns for hardcoded secrets
    const secretPatterns = [
        { regex: /['"]sk-[a-zA-Z0-9]{32,}['"]/, name: "OpenAI API key" },
        { regex: /['"][A-Za-z0-9]{32,}['"].*(?:api[_-]?key|secret|token)/i, name: "API key/secret" },
        { regex: /password\s*[=:]\s*['"][^'"]+['"]/i, name: "hardcoded password" },
        { regex: /(?:aws[_-]?)?secret[_-]?access[_-]?key/i, name: "AWS secret key" },
        { regex: /ghp_[a-zA-Z0-9]{36}/, name: "GitHub token" },
        { regex: /glpat-[a-zA-Z0-9]{20}/, name: "GitLab token" },
    ];
    
    lines.forEach((line, i) => {
        // Skip comments
        if (line.trim().startsWith("//") || line.trim().startsWith("#")) return;
        
        for (const pattern of secretPatterns) {
            if (pattern.regex.test(line)) {
                issues.push({
                    type: "security",
                    message: `Possible ${pattern.name} detected - use environment variables!`,
                    line: i + 1,
                    severity: "security",
                    quickFix: `Move to .env file: ${pattern.name.toUpperCase().replace(/\s+/g, "_")}=<value>`,
                });
                break; // One issue per line
            }
        }
    });
    
    return issues;
}

/**
 * Check for style issues
 */
function checkStyleIssues(content, filePath) {
    const issues = [];
    const lines = content.split("\n");
    const ext = path.extname(filePath);
    
    // Only for JS/TS files
    if (![".js", ".ts", ".jsx", ".tsx"].includes(ext)) return issues;
    
    lines.forEach((line, i) => {
        // Skip comments
        if (line.trim().startsWith("//")) return;
        
        // Check for == instead of ===
        if (/[^=!<>]==[^=]/.test(line) && !/===/.test(line)) {
            // Make sure it's not inside a string
            const quotesRemoved = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""');
            if (/[^=!<>]==[^=]/.test(quotesRemoved)) {
                const col = line.search(/[^=!<>]==[^=]/);
                issues.push({
                    type: "style",
                    message: "Use === instead of == for strict equality",
                    line: i + 1,
                    column: col + 2,
                    severity: "warning",
                    quickFix: "Replace == with ===",
                });
            }
        }
        
        // Check for != instead of !==
        if (/!=[^=]/.test(line) && !/!==/.test(line)) {
            const quotesRemoved = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""');
            if (/!=[^=]/.test(quotesRemoved)) {
                const col = line.search(/!=[^=]/);
                issues.push({
                    type: "style",
                    message: "Use !== instead of != for strict inequality",
                    line: i + 1,
                    column: col + 1,
                    severity: "warning",
                    quickFix: "Replace != with !==",
                });
            }
        }
    });
    
    return issues;
}

/**
 * Run ESLint if available
 */
async function runEslint(filePath) {
    return new Promise((resolve) => {
        // Check if eslint is available in the project
        const dir = path.dirname(filePath);
        const eslintPath = path.join(dir, "node_modules", ".bin", "eslint");
        
        if (!fs.existsSync(eslintPath)) {
            resolve([]);
            return;
        }
        
        exec(`"${eslintPath}" "${filePath}" --format json`, { timeout: 10000 }, (err, stdout) => {
            try {
                const results = JSON.parse(stdout);
                if (results.length > 0 && results[0].messages) {
                    const issues = results[0].messages.map(msg => ({
                        type: "eslint",
                        message: msg.message,
                        line: msg.line,
                        column: msg.column,
                        severity: msg.severity === 2 ? "error" : "warning",
                        ruleId: msg.ruleId,
                    }));
                    resolve(issues);
                } else {
                    resolve([]);
                }
            } catch (e) {
                resolve([]);
            }
        });
    });
}

/**
 * LLM-based deep analysis for logic errors
 * Catches issues that syntax checkers can't find
 */
async function checkLogicErrors(content, filePath) {
    const errors = [];
    const ext = path.extname(filePath).toLowerCase();
    
    // Only analyze code files
    if (![".js", ".ts", ".jsx", ".tsx", ".py"].includes(ext)) {
        return errors;
    }
    
    // Limit to reasonable file size (don't send huge files)
    const lines = content.split("\n");
    if (lines.length > 200) {
        // For large files, only analyze the changed portion or first 200 lines
        content = lines.slice(0, 200).join("\n") + "\n// ... (file truncated for analysis)";
    }
    
    const language = ext === ".py" ? "Python" : "JavaScript/TypeScript";
    
    const prompt = `You are a code reviewer. Analyze this ${language} code for LOGIC ERRORS ONLY.

DO NOT report:
- Syntax errors (already checked)
- Style issues (already checked)  
- Missing semicolons
- Formatting issues

ONLY report actual bugs like:
- Infinite loops
- Off-by-one errors
- Wrong variable used
- Conditions that are always true/false
- Missing return statements in functions
- Unreachable code
- Array index out of bounds risks
- Null/undefined access risks
- Race conditions
- Wrong comparison logic

File: ${path.basename(filePath)}
\`\`\`${ext.slice(1)}
${content}
\`\`\`

Respond in this EXACT JSON format (no markdown, just JSON):
[
  {"line": 10, "severity": "error", "message": "Brief description of the bug"}
]

If no logic errors found, respond with: []
ONLY output the JSON array, nothing else.`;

    try {
        const response = await llm.ask(prompt, { context: {} });
        
        // Parse JSON response
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) {
                return parsed.map(e => ({
                    type: "logic_error",
                    line: e.line || 1,
                    severity: e.severity || "warning",
                    message: e.message || "Potential logic issue",
                    source: "ai",
                }));
            }
        }
    } catch (e) {
        // LLM analysis failed, skip silently
        if (config.get("debug")) {
            console.error("LLM analysis error:", e.message);
        }
    }
    
    return errors;
}

/**
 * Main syntax/error check function
 */
async function checkForErrors(filePath, content, options = {}) {
    const { deepAnalysis = false } = options;
    const ext = path.extname(filePath).toLowerCase();
    let errors = [];
    
    // Check based on file type
    if ([".js", ".ts", ".jsx", ".tsx"].includes(ext)) {
        errors = errors.concat(checkJavaScriptSyntax(content, filePath));
        
        // Also try ESLint if available
        const eslintErrors = await runEslint(filePath);
        errors = errors.concat(eslintErrors);
    } else if (ext === ".py") {
        errors = errors.concat(checkPythonSyntax(content, filePath));
    } else if (ext === ".json") {
        errors = errors.concat(checkJsonSyntax(content, filePath));
    }
    
    // Security checks for all code files
    if (ERROR_SETTINGS.checkSecurity) {
        errors = errors.concat(checkSecurityIssues(content, filePath));
    }
    
    // Style checks
    if (ERROR_SETTINGS.checkStyle) {
        errors = errors.concat(checkStyleIssues(content, filePath));
    }
    
    // LLM-based deep analysis (if enabled and no syntax errors)
    if (deepAnalysis && errors.filter(e => e.severity === "error").length === 0) {
        const logicErrors = await checkLogicErrors(content, filePath);
        errors = errors.concat(logicErrors);
    }
    
    return errors;
}

/**
 * Send macOS notification for errors
 */
function sendErrorNotification(errors, filePath) {
    if (!ERROR_SETTINGS.notifyOnError) return;
    if (errors.length === 0) return;
    
    const fileName = path.basename(filePath);
    const criticalErrors = errors.filter(e => e.severity === "error" || e.severity === "security");
    const warnings = errors.filter(e => e.severity === "warning");
    
    let title, message;
    
    if (criticalErrors.length > 0) {
        title = `🚨 ${criticalErrors.length} Error${criticalErrors.length > 1 ? "s" : ""} in ${fileName}`;
        const firstError = criticalErrors[0];
        message = `Line ${firstError.line}: ${firstError.message}`;
    } else if (warnings.length > 0) {
        title = `⚠️ ${warnings.length} Warning${warnings.length > 1 ? "s" : ""} in ${fileName}`;
        const firstWarning = warnings[0];
        message = `Line ${firstWarning.line}: ${firstWarning.message}`;
    } else {
        return; // Only info, don't notify
    }
    
    // Store errors for click action
    const errorStorePath = require("../paths").configFile("last-errors.json");
    try {
        const dir = path.dirname(errorStorePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(errorStorePath, JSON.stringify({
            file: filePath,
            fileName,
            errors,
            timestamp: new Date().toISOString(),
        }, null, 2));
    } catch (e) {
        // Ignore write errors
    }
    
    // Try terminal-notifier first (supports click action), fallback to osascript
    const terminalNotifierPath = "/opt/homebrew/bin/terminal-notifier";
    const hasTerminalNotifier = fs.existsSync(terminalNotifierPath);
    
    if (hasTerminalNotifier) {
        // Use terminal-notifier with click action to show detailed errors
        const subtitle = errors.length > 1 ? `+${errors.length - 1} more issues` : "";
        const soundParam = ERROR_SETTINGS.notifySound ? "-sound Basso" : "";
        
        // On click, run 'ai errors --show-last' to display details
        const clickCmd = `ai errors --show-last`;
        
        const cmd = `"${terminalNotifierPath}" -title "${title.replace(/"/g, '\\"')}" ` +
            `-message "${message.replace(/"/g, '\\"')}" ` +
            (subtitle ? `-subtitle "${subtitle}" ` : "") +
            `-group "ai-agent-errors" ` +
            `-execute "${clickCmd}" ` +
            soundParam;
        
        exec(cmd, (err) => {
            if (err && config.get("debug")) {
                console.error("Notification error:", err.message);
            }
        });
    } else {
        // Fallback to osascript — use spawn to avoid shell injection
        const soundParam = ERROR_SETTINGS.notifySound ? ' sound name "Basso"' : '';
        // Escape double quotes only; spawn avoids shell, but AppleScript still needs them escaped
        const safeMsg = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `display notification "${safeMsg}" with title "${safeTitle}"${soundParam}`;
        const { spawn: spawnProc } = require("child_process");
        const proc = spawnProc("osascript", ["-e", script]);
        proc.on("error", (err) => {
            if (config.get("debug")) console.error("Notification error:", err.message);
        });
    }
}

/**
 * Show the last stored errors (for notification click action)
 */
function showLastErrors() {
    const errorStorePath = require("../paths").configFile("last-errors.json");
    
    try {
        if (!fs.existsSync(errorStorePath)) {
            console.log("\n❌ No recent errors found.\n");
            return null;
        }
        
        const data = JSON.parse(fs.readFileSync(errorStorePath, "utf-8"));
        const { file, fileName, errors, timestamp } = data;
        
        console.log("\n" + "═".repeat(60));
        console.log("🚨 ERROR DETAILS");
        console.log("═".repeat(60));
        console.log(`📁 File: ${fileName}`);
        console.log(`📍 Path: ${file}`);
        console.log(`🕐 Time: ${new Date(timestamp).toLocaleString()}`);
        console.log("─".repeat(60));
        
        errors.forEach((e, i) => {
            const icon = SEVERITY_ICONS[e.severity] || "•";
            console.log(`\n${icon} Issue ${i + 1}: ${e.severity.toUpperCase()}`);
            console.log(`   Line ${e.line}: ${e.message}`);
            if (e.quickFix) {
                console.log(`   💡 Fix: ${e.quickFix}`);
            }
        });
        
        console.log("\n" + "═".repeat(60));
        console.log(`\n💡 To open file: code "${file}:${errors[0]?.line || 1}"\n`);
        
        return data;
    } catch (e) {
        console.error("Error reading last errors:", e.message);
        return null;
    }
}

/**
 * Format errors for console output
 */
function formatErrors(errors, filePath) {
    if (!errors || errors.length === 0) return null;
    
    const fileName = path.basename(filePath);
    let output = "\n";
    output += "┌─────────────────────────────────────────────────────────┐\n";
    output += "│  🚨 ERRORS DETECTED                                      │\n";
    output += `│  📁 ${fileName.padEnd(51)} │\n`;
    output += "├─────────────────────────────────────────────────────────┤\n";
    
    errors.slice(0, 5).forEach(error => {
        const icon = SEVERITY_ICONS[error.severity] || "•";
        const lineInfo = error.line ? `L${error.line}` : "";
        const msg = `${icon} ${lineInfo}: ${error.message}`.substring(0, 55);
        output += `│  ${msg.padEnd(55)} │\n`;
    });
    
    if (errors.length > 5) {
        output += `│  ... and ${errors.length - 5} more issues                              │\n`;
    }
    
    output += "└─────────────────────────────────────────────────────────┘\n";
    
    return output;
}

/**
 * Analyze a file for potential issues
 */
function analyzeFile(filePath, content) {
    const issues = [];

    // Count lines
    const lines = content.split("\n");

    // Check for large functions (basic heuristic)
    let inFunction = false;
    let functionStart = 0;
    let braceCount = 0;
    let functionName = "";

    lines.forEach((line, i) => {
        // Detect function start (JS/TS style)
        const funcMatch = line.match(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*(?::\s*\w+)?\s*\(.*\)\s*(?:=>|{))/);
        if (funcMatch && !inFunction) {
            inFunction = true;
            functionStart = i;
            functionName = funcMatch[1] || funcMatch[2] || funcMatch[3] || "anonymous";
            braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
        } else if (inFunction) {
            braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
            if (braceCount <= 0) {
                const funcLength = i - functionStart;
                if (funcLength > THRESHOLDS.largeFunctionLines) {
                    issues.push({
                        type: "large_function",
                        message: `Function '${functionName}' is ${funcLength} lines. Consider breaking it down.`,
                        line: functionStart + 1,
                        severity: "warning",
                    });
                }
                inFunction = false;
            }
        }
    });

    // Check for TODO/FIXME comments
    const todoMatches = content.match(/\/\/\s*(TODO|FIXME|HACK|XXX):/gi) || [];
    if (todoMatches.length >= THRESHOLDS.todoCount) {
        issues.push({
            type: "many_todos",
            message: `${todoMatches.length} TODO/FIXME comments found. Time for some cleanup?`,
            severity: "info",
        });
    }

    // Check for console.log statements (in production code)
    const consoleLogs = (content.match(/console\.(log|debug|info)\(/g) || []).length;
    if (consoleLogs > 5) {
        issues.push({
            type: "console_logs",
            message: `${consoleLogs} console.log statements. Remove before production?`,
            severity: "warning",
        });
    }

    // Check for deeply nested code (lots of indentation)
    const deepNesting = lines.filter(line => {
        const indent = line.match(/^(\s*)/)[1].length;
        return indent > 24; // 6+ levels of indentation
    });
    if (deepNesting.length > 3) {
        issues.push({
            type: "deep_nesting",
            message: "Deeply nested code detected. Consider refactoring.",
            severity: "warning",
        });
    }

    // Check for duplicate adjacent lines (copy-paste smell)
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length > 20 && line === lines[i - 1].trim()) {
            issues.push({
                type: "duplicate_line",
                message: `Duplicate code at line ${i + 1}. Intentional?`,
                line: i + 1,
                severity: "info",
            });
            break; // Only report once
        }
    }

    // Check for magic numbers
    const magicNumbers = content.match(/[^a-zA-Z_]\d{3,}[^a-zA-Z_]/g) || [];
    if (magicNumbers.length > 3) {
        issues.push({
            type: "magic_numbers",
            message: "Multiple magic numbers found. Consider using named constants.",
            severity: "info",
        });
    }

    return issues;
}

/**
 * Check if user has been stuck on a file
 */
function checkStuckOnFile(filePath) {
    if (watchState.currentFile !== filePath) {
        watchState.currentFile = filePath;
        watchState.fileStartTime = Date.now();
        return null;
    }

    const minutes = (Date.now() - watchState.fileStartTime) / 60000;
    if (minutes > THRESHOLDS.fileStuckMinutes) {
        // Reset timer after suggesting
        watchState.fileStartTime = Date.now();
        return {
            type: "stuck_on_file",
            message: `You've been on this file for ${Math.round(minutes)} minutes. Need help?`,
            severity: "help",
        };
    }
    return null;
}

/**
 * Detect duplicate code across recent changes
 */
function detectDuplicateCode(recentChanges) {
    const codeBlocks = {};

    for (const change of recentChanges) {
        if (!change.content) continue;

        const lines = change.content.split("\n");
        for (let i = 0; i < lines.length - THRESHOLDS.duplicateCodeLines; i++) {
            const block = lines.slice(i, i + THRESHOLDS.duplicateCodeLines).join("\n").trim();
            if (block.length > 50) {
                if (!codeBlocks[block]) {
                    codeBlocks[block] = [];
                }
                codeBlocks[block].push({ file: change.file, line: i + 1 });
            }
        }
    }

    const duplicates = Object.entries(codeBlocks)
        .filter(([_, locations]) => locations.length > 1)
        .map(([code, locations]) => ({
            code: code.substring(0, 100) + "...",
            files: [...new Set(locations.map(l => l.file))],
        }));

    if (duplicates.length > 0) {
        return {
            type: "duplicate_across_files",
            message: `Similar code found in ${duplicates[0].files.length} files. Extract to a shared utility?`,
            files: duplicates[0].files,
            severity: "suggestion",
        };
    }

    return null;
}

/**
 * Check git status for failing tests
 */
async function checkTestStatus(cwd) {
    return new Promise((resolve) => {
        // Check if there's a test script
        const pkgPath = path.join(cwd, "package.json");
        if (!fs.existsSync(pkgPath)) {
            resolve(null);
            return;
        }

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            if (!pkg.scripts?.test) {
                resolve(null);
                return;
            }

            // Check recent commit messages for test failures
            exec("git log --oneline -5", { cwd }, (err, stdout) => {
                if (err) {
                    resolve(null);
                    return;
                }

                const commits = stdout.toLowerCase();
                if (commits.includes("fix test") || commits.includes("failing")) {
                    resolve({
                        type: "test_issues",
                        message: "Recent commits mention test issues. Run tests to verify?",
                        severity: "warning",
                    });
                } else {
                    resolve(null);
                }
            });
        } catch (e) {
            resolve(null);
        }
    });
}

/**
 * Get smart suggestion using AI
 */
async function getAISuggestion(context) {
    const { file, content, issues } = context;

    if (issues.length === 0) return null;

    const prompt = `You are a proactive code assistant. Based on the following issues detected in the user's code, provide ONE brief, actionable suggestion (max 2 sentences).

File: ${file}
Issues detected:
${issues.map(i => `- ${i.type}: ${i.message}`).join("\n")}

Code snippet (first 50 lines):
${content.split("\n").slice(0, 50).join("\n")}

Provide a helpful, non-annoying suggestion. Be specific and actionable.`;

    try {
        const response = await llm.ask(prompt, { context: {} });
        return response;
    } catch (e) {
        return issues[0].message; // Fallback to first issue
    }
}

/**
 * Main analysis function - called when file changes
 * Now includes real-time error detection!
 */
async function analyze(filePath, content, options = {}) {
    const { cwd = process.cwd(), silent = false, enableErrors = true } = options;

    // Track this change
    watchState.recentChanges.push({
        file: filePath,
        content,
        time: Date.now(),
    });

    // Keep only last 10 changes
    if (watchState.recentChanges.length > 10) {
        watchState.recentChanges.shift();
    }

    const suggestions = [];
    let syntaxErrors = [];

    // 0. Check for syntax/security errors FIRST (real-time)
    if (enableErrors) {
        // Check cooldown to avoid spam on rapid edits
        const lastErrorTime = watchState.errorCooldowns.get(filePath) || 0;
        const now = Date.now();
        
        if (now - lastErrorTime > ERROR_SETTINGS.debounceMs) {
            syntaxErrors = await checkForErrors(filePath, content);
            watchState.errorCooldowns.set(filePath, now);
            
            // Send notification for critical errors
            if (syntaxErrors.length > 0) {
                sendErrorNotification(syntaxErrors, filePath);
            }
        }
    }

    // 1. Analyze current file (code quality)
    const fileIssues = analyzeFile(filePath, content);
    suggestions.push(...fileIssues);

    // 2. Check if stuck
    const stuckIssue = checkStuckOnFile(filePath);
    if (stuckIssue) suggestions.push(stuckIssue);

    // 3. Check for duplicates across files
    const dupIssue = detectDuplicateCode(watchState.recentChanges);
    if (dupIssue) suggestions.push(dupIssue);

    // 4. Check test status
    const testIssue = await checkTestStatus(cwd);
    if (testIssue) suggestions.push(testIssue);

    // Filter out recently given suggestions
    const newSuggestions = suggestions.filter(s => {
        const key = `${s.type}-${s.message}`;
        const wasRecent = watchState.suggestionsGiven.includes(key);
        if (!wasRecent) {
            watchState.suggestionsGiven.push(key);
            // Keep only last 20 suggestions
            if (watchState.suggestionsGiven.length > 20) {
                watchState.suggestionsGiven.shift();
            }
        }
        return !wasRecent;
    });

    // If we have syntax errors, prioritize those
    if (syntaxErrors.length > 0) {
        return {
            issues: newSuggestions,
            errors: syntaxErrors,
            suggestion: null, // Don't suggest when there are errors
            file: filePath,
            hasErrors: true,
        };
    }

    if (newSuggestions.length === 0) {
        return null;
    }

    // Get AI-enhanced suggestion for top issue
    const aiSuggestion = await getAISuggestion({
        file: filePath,
        content,
        issues: newSuggestions.slice(0, 3),
    });

    return {
        issues: newSuggestions,
        errors: [],
        suggestion: aiSuggestion,
        file: filePath,
        hasErrors: false,
    };
}

/**
 * Format suggestion for display (includes errors if present)
 */
function formatSuggestion(result) {
    if (!result) return null;

    const fileName = path.basename(result.file || "");
    let output = "\n";
    
    // Show errors first if present
    if (result.errors && result.errors.length > 0) {
        output += "┌─────────────────────────────────────────────────────────┐\n";
        output += "│  🚨 ERRORS DETECTED                                      │\n";
        if (fileName) {
            output += `│  📁 ${fileName.padEnd(51)} │\n`;
        }
        output += "├─────────────────────────────────────────────────────────┤\n";
        
        result.errors.slice(0, 5).forEach(error => {
            const icon = SEVERITY_ICONS[error.severity] || "•";
            const lineInfo = error.line ? `L${error.line}` : "";
            const msg = `${icon} ${lineInfo}: ${error.message}`.substring(0, 55);
            output += `│  ${msg.padEnd(55)} │\n`;
        });
        
        if (result.errors.length > 5) {
            output += `│  ... and ${(result.errors.length - 5).toString().padEnd(2)} more issues                             │\n`;
        }
        
        output += "└─────────────────────────────────────────────────────────┘\n";
        return output;
    }
    
    // Show Spidey Sense suggestions
    if (result.suggestion) {
        output += "┌─────────────────────────────────────────────────────────┐\n";
        output += "│  🕷️  SPIDEY SENSE                                        │\n";
        output += "├─────────────────────────────────────────────────────────┤\n";
        
        // Wrap long suggestions
        const suggestion = result.suggestion;
        const words = suggestion.split(" ");
        let line = "";
        for (const word of words) {
            if ((line + " " + word).length > 53) {
                output += `│  ${line.trim().padEnd(55)} │\n`;
                line = word;
            } else {
                line += " " + word;
            }
        }
        if (line.trim()) {
            output += `│  ${line.trim().padEnd(55)} │\n`;
        }

        output += "└─────────────────────────────────────────────────────────┘\n";
    }

    return output;
}

/**
 * Reset state (for testing)
 */
function reset() {
    watchState = {
        currentFile: null,
        fileStartTime: null,
        recentChanges: [],
        lastSuggestion: null,
        suggestionsGiven: [],
        recentErrors: [],
        errorCooldowns: new Map(),
    };
}

module.exports = {
    analyze,
    analyzeFile,
    formatSuggestion,
    formatErrors,
    checkStuckOnFile,
    detectDuplicateCode,
    checkForErrors,
    sendErrorNotification,
    showLastErrors,
    reset,
    THRESHOLDS,
    ERROR_SETTINGS,
};
