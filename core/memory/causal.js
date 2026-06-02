/**
 * Causal Work Graph
 *
 * Models the user's work as a graph of nodes and edges:
 *   Nodes:  commit, edit, command, conversation, error, test_run
 *   Edges:  caused_by, preceded_by, referenced_in, resolved, failed
 *
 * Backed by SQLite with FTS5 for full-text search and structured queries.
 * Unlike the flat episodic log, this captures *why* things happened.
 */

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_FILE = path.join(__dirname, "../../storage/causal.db");

let db = null;

function getDb() {
    if (db) return db;
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_FILE);
    db.pragma("journal_mode = WAL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            project TEXT,
            label TEXT,
            data TEXT,
            ts TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
        CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
        CREATE INDEX IF NOT EXISTS idx_nodes_ts ON nodes(ts);

        CREATE TABLE IF NOT EXISTS edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            src INTEGER NOT NULL,
            dst INTEGER NOT NULL,
            relation TEXT NOT NULL,
            data TEXT,
            ts TEXT NOT NULL,
            FOREIGN KEY (src) REFERENCES nodes(id),
            FOREIGN KEY (dst) REFERENCES nodes(id)
        );
        CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
        CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
        CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);

        CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
            label, data, project, type,
            content='nodes', content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
            INSERT INTO nodes_fts(rowid, label, data, project, type)
            VALUES (new.id, new.label, new.data, new.project, new.type);
        END;
        CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, label, data, project, type)
            VALUES('delete', old.id, old.label, old.data, old.project, old.type);
        END;
    `);
    return db;
}

function addNode({ type, project = null, label = "", data = {}, ts = null }) {
    const d = getDb();
    const res = d.prepare(
        `INSERT INTO nodes (type, project, label, data, ts) VALUES (?,?,?,?,?)`
    ).run(type, project, label, JSON.stringify(data), ts || new Date().toISOString());
    return res.lastInsertRowid;
}

function addEdge({ src, dst, relation, data = {} }) {
    const d = getDb();
    const res = d.prepare(
        `INSERT INTO edges (src, dst, relation, data, ts) VALUES (?,?,?,?,?)`
    ).run(src, dst, relation, JSON.stringify(data), new Date().toISOString());
    return res.lastInsertRowid;
}

/**
 * High-level ingestion helpers. Called by filewatcher/terminal hooks/agent.
 */
function recordEdit({ project, file, action }) {
    const id = addNode({
        type: "edit",
        project,
        label: `${action} ${file}`,
        data: { file, action },
    });
    linkToPrevious(id, project);
    return id;
}

function recordCommand({ project, command, exitCode, cwd }) {
    const id = addNode({
        type: "command",
        project,
        label: command,
        data: { command, exitCode, cwd },
    });
    linkToPrevious(id, project);
    if (exitCode !== 0) {
        addNode({
            type: "error",
            project,
            label: `failed: ${command}`,
            data: { command, exitCode },
        });
    }
    return id;
}

function recordCommit({ project, hash, message, files = [] }) {
    const id = addNode({
        type: "commit",
        project,
        label: message,
        data: { hash, message, files },
    });
    // Link commit to the recent edits of these files
    const d = getDb();
    const recent = d.prepare(
        `SELECT id FROM nodes WHERE type='edit' AND project=?
         AND ts > datetime('now', '-6 hours') ORDER BY ts DESC LIMIT 20`
    ).all(project);
    for (const r of recent) {
        addEdge({ src: id, dst: r.id, relation: "includes" });
    }
    return id;
}

function recordConversation({ project, question, answer }) {
    const id = addNode({
        type: "conversation",
        project,
        label: question.slice(0, 140),
        data: { question, answer: (answer || "").slice(0, 4000) },
    });
    linkToPrevious(id, project);
    return id;
}

function linkToPrevious(newId, project) {
    const d = getDb();
    const prev = d.prepare(
        `SELECT id FROM nodes WHERE project=? AND id<? ORDER BY id DESC LIMIT 1`
    ).get(project, newId);
    if (prev) addEdge({ src: newId, dst: prev.id, relation: "preceded_by" });
}

/**
 * Full-text search across all nodes.
 */
function search(query, { project = null, limit = 20 } = {}) {
    const d = getDb();
    // Sanitise FTS query — quote to avoid operator parsing issues
    const safe = `"${String(query).replace(/"/g, '""')}"`;
    const rows = project
        ? d.prepare(
              `SELECT n.* FROM nodes_fts f JOIN nodes n ON f.rowid=n.id
               WHERE nodes_fts MATCH ? AND n.project=? LIMIT ?`
          ).all(safe, project, limit)
        : d.prepare(
              `SELECT n.* FROM nodes_fts f JOIN nodes n ON f.rowid=n.id
               WHERE nodes_fts MATCH ? LIMIT ?`
          ).all(safe, limit);
    return rows.map(parseNode);
}

function parseNode(n) {
    try { n.data = JSON.parse(n.data || "{}"); } catch {}
    return n;
}

/**
 * Walk neighbours of a node (both directions).
 */
function neighbours(nodeId, { relation = null, depth = 1 } = {}) {
    const d = getDb();
    const visited = new Set([nodeId]);
    const frontier = [nodeId];
    const collected = [];
    for (let i = 0; i < depth; i++) {
        const next = [];
        for (const id of frontier) {
            const rows = relation
                ? d.prepare(
                      `SELECT n.*, e.relation FROM edges e JOIN nodes n ON n.id=e.dst
                       WHERE e.src=? AND e.relation=?
                       UNION
                       SELECT n.*, e.relation FROM edges e JOIN nodes n ON n.id=e.src
                       WHERE e.dst=? AND e.relation=?`
                  ).all(id, relation, id, relation)
                : d.prepare(
                      `SELECT n.*, e.relation FROM edges e JOIN nodes n ON n.id=e.dst WHERE e.src=?
                       UNION
                       SELECT n.*, e.relation FROM edges e JOIN nodes n ON n.id=e.src WHERE e.dst=?`
                  ).all(id, id);
            for (const r of rows) {
                if (!visited.has(r.id)) {
                    visited.add(r.id);
                    collected.push(parseNode(r));
                    next.push(r.id);
                }
            }
        }
        frontier.splice(0, frontier.length, ...next);
    }
    return collected;
}

function stats() {
    const d = getDb();
    const total = d.prepare(`SELECT COUNT(*) c FROM nodes`).get().c;
    const byType = d.prepare(
        `SELECT type, COUNT(*) c FROM nodes GROUP BY type ORDER BY c DESC`
    ).all();
    const edges = d.prepare(`SELECT COUNT(*) c FROM edges`).get().c;
    const byRelation = d.prepare(
        `SELECT relation, COUNT(*) c FROM edges GROUP BY relation ORDER BY c DESC`
    ).all();
    return { totalNodes: total, totalEdges: edges, byType, byRelation };
}

/**
 * Natural-language query: uses the LLM to translate the question into a
 * constrained SQL query (read-only, whitelisted tables).
 */
async function askGraph(question, { project = null } = {}) {
    const llm = require("../llm");
    const schema = `
Schema:
  nodes(id, type, project, label, data, ts)
    type IN ('edit','command','commit','conversation','error','test_run')
  edges(id, src, dst, relation, data, ts)
    relation IN ('preceded_by','caused_by','referenced_in','resolved','failed','includes')

Rules:
- Return ONLY a single SELECT statement, no comments, no markdown.
- Never use INSERT/UPDATE/DELETE/DROP/ATTACH.
- Always LIMIT 50 or fewer.
- For text search on label or data, use LIKE '%term%'.
${project ? `- Filter by project='${project}' unless the question says otherwise.` : ""}
`;

    const prompt = `You translate natural-language questions about a developer's work history into SQL.
${schema}

Question: ${question}

SQL:`;

    const sql = await llm.ask(prompt, { node: "graph.nl2sql" });
    const cleaned = sql.replace(/```sql|```/gi, "").trim();

    // Enforce read-only
    if (!/^\s*SELECT/i.test(cleaned)) {
        throw new Error("Query must start with SELECT");
    }
    if (/\b(INSERT|UPDATE|DELETE|DROP|ATTACH|PRAGMA|ALTER|CREATE)\b/i.test(cleaned)) {
        throw new Error("Only SELECT queries are allowed");
    }

    const d = getDb();
    const rows = d.prepare(cleaned).all();
    return { sql: cleaned, rows: rows.slice(0, 50).map(parseNode) };
}

/**
 * Format recent graph slice for prompt injection.
 */
function formatRecentForPrompt(project, limit = 10) {
    const d = getDb();
    const rows = d.prepare(
        `SELECT type, label, ts FROM nodes
         WHERE project=? ORDER BY id DESC LIMIT ?`
    ).all(project, limit);
    if (rows.length === 0) return "";
    return rows.map((r) => `[${r.type}] ${r.label}`).join("\n");
}

module.exports = {
    addNode,
    addEdge,
    recordEdit,
    recordCommand,
    recordCommit,
    recordConversation,
    search,
    neighbours,
    stats,
    askGraph,
    formatRecentForPrompt,
};
