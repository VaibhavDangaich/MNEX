/**
 * Durable outbound queue.
 *
 * cloudsync drops sync events on any failure, so the queue is what makes an
 * offline edit recoverable. The invariants worth pinning down are: nothing is
 * lost on failure, nothing is duplicated, and a poison payload cannot wedge the
 * queue forever.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const queue = require("../core/remote/queue");

function tmpDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnex-queue-"));
    return path.join(dir, "workflows.db");
}

test("enqueued events drain through the handler and are removed", async () => {
    const dbPath = tmpDb();
    queue.enqueue("conversation", { id: 1 }, { dbPath });
    queue.enqueue("task", { id: 2 }, { dbPath });
    assert.strictEqual(queue.size({ dbPath }), 2);

    const handled = [];
    const res = await queue.drain(async (e) => { handled.push(e.kind); }, { dbPath });

    assert.strictEqual(res.sent, 2);
    assert.strictEqual(res.remaining, 0);
    assert.deepStrictEqual(handled.sort(), ["conversation", "task"]);
    queue.close();
});

test("a failed event is retained rather than dropped", async () => {
    const dbPath = tmpDb();
    queue.enqueue("activity", { file: "a.js" }, { dbPath });

    const res = await queue.drain(async () => { throw new Error("offline"); }, { dbPath });

    assert.strictEqual(res.sent, 0);
    assert.strictEqual(res.failed, 1);
    assert.strictEqual(queue.size({ dbPath }), 1, "event must survive a failed drain");
    queue.close();
});

test("a failed event becomes invisible until its backoff elapses", async () => {
    const dbPath = tmpDb();
    queue.enqueue("activity", { file: "a.js" }, { dbPath });
    await queue.drain(async () => { throw new Error("offline"); }, { dbPath, baseDelay: 60000 });

    assert.strictEqual(queue.ready({ dbPath }).length, 0, "should be scheduled for later");
    assert.strictEqual(
        queue.ready({ dbPath, now: Date.now() + 10 * 60000 }).length, 1,
        "should reappear once the delay passes"
    );
    queue.close();
});

test("identical events are de-duplicated instead of piling up", () => {
    const dbPath = tmpDb();
    for (let i = 0; i < 5; i++) queue.enqueue("activity", { file: "same.js" }, { dbPath });
    assert.strictEqual(queue.size({ dbPath }), 1);

    queue.enqueue("activity", { file: "other.js" }, { dbPath });
    assert.strictEqual(queue.size({ dbPath }), 2);
    queue.close();
});

test("a permanently failing event is dropped after maxAttempts", async () => {
    const dbPath = tmpDb();
    queue.enqueue("activity", { file: "poison.js" }, { dbPath });

    for (let i = 0; i < 3; i++) {
        await queue.drain(async () => { throw new Error("nope"); },
            { dbPath, maxAttempts: 3, baseDelay: 0, maxDelay: 0 });
    }

    assert.strictEqual(queue.size({ dbPath }), 0, "poison payload must not wedge the queue");
    queue.close();
});

test("a successful redrive after failure sends exactly once", async () => {
    const dbPath = tmpDb();
    queue.enqueue("conversation", { id: 7 }, { dbPath });

    await queue.drain(async () => { throw new Error("offline"); }, { dbPath, baseDelay: 0, maxDelay: 0 });

    let delivered = 0;
    const res = await queue.drain(async () => { delivered++; }, { dbPath });

    assert.strictEqual(delivered, 1, "must deliver exactly once, not zero or twice");
    assert.strictEqual(res.remaining, 0);
    queue.close();
});

test("queue state survives reopening the database", async () => {
    const dbPath = tmpDb();
    queue.enqueue("task", { id: 99 }, { dbPath });
    queue.close();

    assert.strictEqual(queue.size({ dbPath }), 1, "a new process must see the pending event");
    const res = await queue.drain(async () => {}, { dbPath });
    assert.strictEqual(res.sent, 1);
    queue.close();
});
