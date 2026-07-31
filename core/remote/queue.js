/**
 * Durable outbound sync queue.
 *
 * core/memory/cloudsync.js swallows every failure ("silent fail — don't break
 * the user experience"). That is the right instinct for UX and the wrong one for
 * data: if Supermemory is unreachable — no network, expired key, rate limit —
 * the conversation, task or activity being synced is gone for good, and the
 * cross-device story quietly stops working with no error anywhere.
 *
 * This queue keeps that non-blocking feel while making the loss recoverable.
 * Failed syncs are appended to a SQLite-backed queue and drained later: on the
 * next CLI invocation, on the next daemon tick, or explicitly via `mnex sync`.
 *
 * Storage is a plain table rather than the workflow step log, because these are
 * independent events with no ordering contract between them, and each needs its
 * own attempt counter and visibility deadline.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_DB = path.join(__dirname, "..", "..", "storage", "workflows.db");

let _db = null;
let _dbPath = null;

function db(dbPath = process.env.MNEX_WORKFLOW_DB || DEFAULT_DB) {
    if (_db && _dbPath === dbPath) return _db;
    if (_db) {
        try { _db.close(); } catch { /* noop */ }
        _db = null;
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = require("better-sqlite3");
    const d = new Database(dbPath);
    d.pragma("journal_mode = WAL");
    d.pragma("synchronous = NORMAL");
    d.pragma("busy_timeout = 5000");
    d.exec(`
        CREATE TABLE IF NOT EXISTS outbox (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            kind         TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            dedupe_key   TEXT UNIQUE,
            attempts     INTEGER NOT NULL DEFAULT 0,
            last_error   TEXT,
            visible_at   INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_ready ON outbox(visible_at, id);
    `);
    _db = d;
    _dbPath = dbPath;
    return d;
}

function close() {
    if (_db) {
        try { _db.close(); } catch { /* noop */ }
        _db = null;
        _dbPath = null;
    }
}

/**
 * Append an event.
 *
 * `dedupe_key` collapses repeats: the file watcher can fire many times for the
 * same save while offline, and replaying all of them on reconnect would be
 * noise. Re-enqueuing an existing key makes the event visible again rather than
 * inserting a duplicate.
 */
function enqueue(kind, payload, opts = {}) {
    const d = db(opts.dbPath);
    const dedupeKey = opts.dedupeKey
        || crypto.createHash("sha256").update(`${kind} ${JSON.stringify(payload)}`).digest("hex");
    const now = Date.now();

    const info = d.prepare(`
        INSERT INTO outbox (kind, payload_json, dedupe_key, attempts, visible_at, created_at)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET visible_at = excluded.visible_at
    `).run(kind, JSON.stringify(payload), dedupeKey, now, now);

    return { id: info.lastInsertRowid, dedupeKey };
}

/** Events whose visibility deadline has passed. */
function ready({ limit = 50, now = Date.now(), dbPath } = {}) {
    return db(dbPath).prepare(
        "SELECT * FROM outbox WHERE visible_at <= ? ORDER BY id ASC LIMIT ?"
    ).all(now, limit);
}

function size(opts = {}) {
    return db(opts.dbPath).prepare("SELECT COUNT(*) AS n FROM outbox").get().n;
}

function remove(id, opts = {}) {
    db(opts.dbPath).prepare("DELETE FROM outbox WHERE id = ?").run(id);
}

/**
 * Drain the queue through `handler`.
 *
 * A successful handler call removes the event. A failure re-schedules it with
 * full-jitter backoff, and after `maxAttempts` the event is dropped so a
 * permanently poisonous payload cannot block the queue forever.
 *
 * @param {Function} handler async ({ kind, payload }) => any
 */
async function drain(handler, opts = {}) {
    const { maxAttempts = 5, limit = 50, dbPath } = opts;
    const engine = require("../orchestration/engine");
    const d = db(dbPath);
    const batch = ready({ limit, dbPath });

    let sent = 0;
    let failed = 0;
    let dropped = 0;

    for (const row of batch) {
        let payload;
        try {
            payload = JSON.parse(row.payload_json);
        } catch {
            // Unparseable rows can never succeed — drop rather than retry forever.
            remove(row.id, { dbPath });
            dropped++;
            continue;
        }

        try {
            await handler({ kind: row.kind, payload });
            remove(row.id, { dbPath });
            sent++;
        } catch (err) {
            const attempts = row.attempts + 1;
            if (attempts >= maxAttempts) {
                d.prepare("DELETE FROM outbox WHERE id = ?").run(row.id);
                dropped++;
            } else {
                const delay = engine.serverRequestedDelayMs(err)
                    ?? engine.fullJitterDelay(attempts, opts.baseDelay ?? 1000, opts.maxDelay ?? 300000);
                d.prepare("UPDATE outbox SET attempts = ?, last_error = ?, visible_at = ? WHERE id = ?")
                    .run(attempts, String(err?.message || err), Date.now() + delay, row.id);
                failed++;
            }
        }
    }

    return { sent, failed, dropped, remaining: size({ dbPath }) };
}

/** Drop everything. Used by `mnex sync --reset` and by tests. */
function clear(opts = {}) {
    const n = size(opts);
    db(opts.dbPath).prepare("DELETE FROM outbox").run();
    return n;
}

module.exports = {
    db,
    close,
    enqueue,
    ready,
    drain,
    size,
    remove,
    clear,
};
