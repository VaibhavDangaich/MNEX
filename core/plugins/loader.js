/**
 * Plugin Loader
 *
 * Discovers plugins from:
 *   1. ~/.mnex/plugins/*.js       (user plugins)
 *   2. ~/.ai-agent/plugins/*.js   (legacy, pre-rename — still loaded)
 *   3. ./plugins/*.js             (project-local plugins)
 *
 * Each plugin is a CommonJS module exporting:
 *   module.exports = {
 *     name: "my-plugin",
 *     version: "1.0.0",
 *     // Add tools callable by the agent
 *     tools: {
 *       my_tool: {
 *         description: "...",
 *         run(args) { return { ok: true, result: "..." }; }
 *       }
 *     },
 *     // Memory hook: called during `memory.recall(...)` to inject extra context
 *     memorySource: async (projectName, query) => "extra context string",
 *     // Lifecycle hooks
 *     hooks: {
 *       onStart(ctx) {}, onCommand(event) {}, onQuestion(q) {}
 *     }
 *   };
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const paths = require("../paths");

const USER_PLUGIN_DIR = paths.PLUGIN_DIR;
const LOCAL_PLUGIN_DIR = path.join(process.cwd(), "plugins");

let loaded = null;

function discover() {
    const dirs = paths.pluginDirs();
    const files = [];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".js")) continue;
            files.push(path.join(dir, f));
        }
    }
    return files;
}

function loadPlugin(filePath) {
    try {
        const mod = require(filePath);
        if (!mod || !mod.name) return null;
        return { ...mod, __file: filePath };
    } catch (e) {
        console.warn(`[plugin] failed to load ${filePath}: ${e.message}`);
        return null;
    }
}

function loadAll({ force = false } = {}) {
    if (loaded && !force) return loaded;
    const plugins = discover().map(loadPlugin).filter(Boolean);
    loaded = plugins;
    return plugins;
}

function list() {
    return loadAll().map((p) => ({
        name: p.name,
        version: p.version || "?",
        file: p.__file,
        tools: Object.keys(p.tools || {}),
        hasMemory: !!p.memorySource,
        hooks: Object.keys(p.hooks || {}),
    }));
}

function pluginTools() {
    const out = {};
    for (const p of loadAll()) {
        if (!p.tools) continue;
        for (const [name, def] of Object.entries(p.tools)) {
            // Namespace with plugin name to avoid collisions
            const key = `${p.name}.${name}`;
            out[key] = {
                name: key,
                description: def.description || `[${p.name}] ${name}`,
                run: def.run.bind(def),
            };
        }
    }
    return out;
}

async function collectMemorySources(projectName, query) {
    const parts = [];
    for (const p of loadAll()) {
        if (!p.memorySource) continue;
        try {
            const out = await p.memorySource(projectName, query);
            if (out) parts.push(`[plugin:${p.name}] ${out}`);
        } catch (e) {
            // Ignore individual plugin failures
        }
    }
    return parts.join("\n");
}

async function fireHook(name, payload) {
    for (const p of loadAll()) {
        const fn = p.hooks?.[name];
        if (typeof fn !== "function") continue;
        try { await fn(payload); } catch (e) { /* ignore */ }
    }
}

function ensureUserDir() {
    if (!fs.existsSync(USER_PLUGIN_DIR)) fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
    return USER_PLUGIN_DIR;
}

function scaffold(name) {
    ensureUserDir();
    const file = path.join(USER_PLUGIN_DIR, `${name}.js`);
    if (fs.existsSync(file)) throw new Error(`Plugin already exists: ${file}`);
    const template = `/**
 * Plugin: ${name}
 * Auto-loaded by the agent at startup.
 */
module.exports = {
    name: "${name}",
    version: "0.1.0",

    tools: {
        hello: {
            description: "Demo tool. Args: { name: string }",
            run({ name = "world" } = {}) {
                return { ok: true, result: \`Hello, \${name}!\` };
            }
        }
    },

    memorySource: async (project, query) => {
        // Return a string to inject into the agent's context, or null
        return null;
    },

    hooks: {
        onStart(ctx) { /* fires when agent boots */ },
        onQuestion(q) { /* fires on every 'ai ask' */ }
    }
};
`;
    fs.writeFileSync(file, template);
    return file;
}

module.exports = {
    loadAll,
    list,
    pluginTools,
    collectMemorySources,
    fireHook,
    scaffold,
    USER_PLUGIN_DIR,
};
