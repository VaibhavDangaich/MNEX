/**
 * Security-relevant invariants that the README states as guarantees.
 *
 * These run without an API key, because the point is to check the guard itself
 * rather than the model that produces the query.
 */

const test = require("node:test");
const assert = require("node:assert");

const { assertReadOnlySql } = require("../core/memory/causal");

test("read-only guard accepts plain SELECT and CTE reads", () => {
    assert.doesNotThrow(() => assertReadOnlySql("SELECT * FROM nodes LIMIT 10"));
    assert.doesNotThrow(() => assertReadOnlySql("  select id from nodes  "));
    assert.doesNotThrow(() =>
        assertReadOnlySql("WITH recent AS (SELECT * FROM nodes) SELECT * FROM recent"));
});

test("read-only guard rejects every mutating statement", () => {
    const mutations = [
        "DELETE FROM nodes",
        "DROP TABLE nodes",
        "INSERT INTO nodes VALUES (1)",
        "UPDATE nodes SET type = 'x'",
        "ALTER TABLE nodes ADD COLUMN x",
        "CREATE TABLE evil (a)",
        "PRAGMA journal_mode = DELETE",
        "ATTACH DATABASE '/etc/passwd' AS pwn",
        "REPLACE INTO nodes VALUES (1)",
        "VACUUM",
        "REINDEX nodes",
        "DETACH DATABASE x",
    ];
    for (const sql of mutations) {
        assert.throws(() => assertReadOnlySql(sql), /SELECT/i, `must reject: ${sql}`);
    }
});

test("read-only guard rejects a mutation smuggled after a leading SELECT", () => {
    // better-sqlite3 also refuses multi-statement strings, but the guard must
    // not rely on that alone.
    assert.throws(() => assertReadOnlySql("SELECT 1; DROP TABLE nodes"), /DROP/i);
    assert.throws(() => assertReadOnlySql("SELECT 1; DELETE FROM nodes"), /DELETE/i);
});

test("read-only guard rejects empty and non-string input", () => {
    for (const bad of ["", "   ", null, undefined]) {
        assert.throws(() => assertReadOnlySql(bad));
    }
});

test("better-sqlite3 refuses multi-statement SQL (defence in depth)", () => {
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (a)");
    assert.throws(
        () => db.prepare("SELECT 1; DROP TABLE t"),
        /more than one statement/i
    );
    db.close();
});
