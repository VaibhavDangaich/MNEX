/**
 * Diff scoping for the mutation gate.
 *
 * The mutation score is only meaningful if the line set underneath it is right.
 * Both failure directions are silent: over-scope and the tool reports on code
 * the change never touched; under-scope and it reports a perfect score on
 * lines it simply never looked at. Neither shows up as an error.
 *
 * parseUnifiedDiff is pure string -> object, so every hunk-header shape git can
 * emit is pinned here against a fixture rather than discovered in production.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { parseUnifiedDiff, isSourceFile, isTestFile, scopeChanges } = require("../core/mutate/diff");

const added = (patch, file) => {
    const f = parseUnifiedDiff(patch).find((x) => x.path === file);
    return f ? [...f.addedLines].sort((a, b) => a - b) : null;
};

test("added lines are numbered against the post-image, not the pre-image", () => {
    // -U0: the hunk body is only +/- lines. The +11 in the header is where the
    // additions land in the NEW file; the -10 side is irrelevant to us.
    const patch = [
        "diff --git core/a.js core/a.js",
        "index 111..222 100644",
        "--- core/a.js",
        "+++ core/a.js",
        "@@ -10,0 +11,2 @@",
        "+const x = 1;",
        "+const y = 2;",
        "",
    ].join("\n");
    assert.deepStrictEqual(added(patch, "core/a.js"), [11, 12]);
});

test("an omitted hunk count means exactly one line", () => {
    // `@@ -20 +22 @@` is git's shorthand for `@@ -20,1 +22,1 @@`. Defaulting the
    // count to 0 instead of 1 drops single-line edits — the most common kind.
    const patch = [
        "diff --git core/a.js core/a.js",
        "--- core/a.js",
        "+++ core/a.js",
        "@@ -20 +22 @@",
        "-const old = 1;",
        "+const now = 2;",
        "",
    ].join("\n");
    assert.deepStrictEqual(added(patch, "core/a.js"), [22]);
});

test("deleted lines consume no post-image line number", () => {
    // If a `-` line advanced the counter, every addition after it in the same
    // hunk would be attributed one line too low.
    const patch = [
        "diff --git core/a.js core/a.js",
        "--- core/a.js",
        "+++ core/a.js",
        "@@ -5,3 +5,2 @@",
        "-gone one",
        "-gone two",
        "-gone three",
        "+kept",
        "",
    ].join("\n");
    assert.deepStrictEqual(added(patch, "core/a.js"), [5]);
});

test("multiple hunks in one file each reset the counter from their own header", () => {
    const patch = [
        "diff --git core/a.js core/a.js",
        "--- core/a.js",
        "+++ core/a.js",
        "@@ -1,0 +2,1 @@",
        "+first",
        "@@ -40,0 +50,2 @@",
        "+second",
        "+third",
        "",
    ].join("\n");
    assert.deepStrictEqual(added(patch, "core/a.js"), [2, 50, 51]);
});

test("a new file is every line added, and is reported as added", () => {
    const patch = [
        "diff --git core/new.js core/new.js",
        "new file mode 100644",
        "index 000000..abcdef",
        "--- /dev/null",
        "+++ core/new.js",
        "@@ -0,0 +1,3 @@",
        "+line one",
        "+line two",
        "+line three",
        "",
    ].join("\n");
    const f = parseUnifiedDiff(patch)[0];
    assert.strictEqual(f.path, "core/new.js");
    assert.strictEqual(f.status, "added");
    assert.deepStrictEqual([...f.addedLines], [1, 2, 3]);
});

test("a deleted file resolves to its old path and contributes nothing", () => {
    // The +++ side is /dev/null. Taking the path from there yields "/dev/null"
    // as a filename, which would then fail every downstream file read.
    const patch = [
        "diff --git core/gone.js core/gone.js",
        "deleted file mode 100644",
        "--- core/gone.js",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-a",
        "-b",
        "",
    ].join("\n");
    const f = parseUnifiedDiff(patch)[0];
    assert.strictEqual(f.path, "core/gone.js");
    assert.strictEqual(f.status, "deleted");
    assert.strictEqual(f.addedLines.size, 0);
});

test("binary files are flagged rather than parsed as text", () => {
    const patch = [
        "diff --git assets/logo.png assets/logo.png",
        "index 111..222 100644",
        "Binary files assets/logo.png and assets/logo.png differ",
        "",
    ].join("\n");
    const f = parseUnifiedDiff(patch)[0];
    assert.strictEqual(f.binary, true);
    assert.strictEqual(f.addedLines.size, 0);
});

test("a rename with no content change yields no added lines", () => {
    const patch = [
        "diff --git core/old.js core/new.js",
        "similarity index 100%",
        "rename from core/old.js",
        "rename to core/new.js",
        "",
    ].join("\n");
    const f = parseUnifiedDiff(patch)[0];
    assert.strictEqual(f.status, "renamed");
    assert.strictEqual(f.path, "core/new.js");
    assert.strictEqual(f.addedLines.size, 0);
});

test("several files in one patch are kept separate", () => {
    const patch = [
        "diff --git core/a.js core/a.js",
        "--- core/a.js",
        "+++ core/a.js",
        "@@ -1,0 +1,1 @@",
        "+a",
        "diff --git core/b.js core/b.js",
        "--- core/b.js",
        "+++ core/b.js",
        "@@ -1,0 +9,1 @@",
        "+b",
        "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    assert.strictEqual(files.length, 2);
    assert.deepStrictEqual(added(patch, "core/a.js"), [1]);
    assert.deepStrictEqual(added(patch, "core/b.js"), [9]);
});

test("content that looks like a diff header is not mistaken for one", () => {
    // This file's own fixtures are literal diff text. A parser that scans for
    // "+++ " anywhere would reattribute the rest of the hunk to another file.
    const patch = [
        "diff --git test/fixture.js test/x.js",
        "--- core/a.js",
        "+++ core/a.js",
        "@@ -1,0 +1,3 @@",
        '+const patch = "--- core/decoy.js";',
        '+const other = "+++ core/decoy.js";',
        "+const hunk = \"@@ -1 +1 @@\";",
        "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    assert.strictEqual(files.length, 1, "decoy header lines must not open a new file");
    assert.strictEqual(files[0].path, "core/a.js");
    assert.deepStrictEqual([...files[0].addedLines], [1, 2, 3]);
});

test('"\\ No newline at end of file" does not advance the line counter', () => {
    const patch = [
        "diff --git core/a.js core/a.js",
        "--- core/a.js",
        "+++ core/a.js",
        "@@ -1 +1,2 @@",
        "+first",
        "\\ No newline at end of file",
        "+second",
        "",
    ].join("\n");
    assert.deepStrictEqual(added(patch, "core/a.js"), [1, 2]);
});

test("an empty or malformed patch yields no files rather than throwing", () => {
    // `git diff` legitimately returns "" when nothing changed. That is the
    // common case on a clean tree, not an error.
    assert.deepStrictEqual(parseUnifiedDiff(""), []);
    assert.deepStrictEqual(parseUnifiedDiff(null), []);
    assert.deepStrictEqual(parseUnifiedDiff("not a diff at all\njust text\n"), []);
});

test("test files are recognised across the layouts people actually use", () => {
    for (const p of [
        "test/foo.test.js", "tests/foo.js", "src/__tests__/foo.js",
        "core/foo.spec.js", "core/foo.test.mjs", "a/b/test/c.js",
    ]) {
        assert.ok(isTestFile(p), `${p} should be a test file`);
    }
    for (const p of ["core/latest.js", "core/contest.js", "core/testing-utils.js"]) {
        assert.ok(!isTestFile(p), `${p} is source, not a test`);
    }
});

test("source detection excludes tests, vendored code and non-JS", () => {
    for (const p of ["core/a.js", "bin/ai.js", "lib/x.mjs", "lib/y.cjs"]) {
        assert.ok(isSourceFile(p), `${p} should be source`);
    }
    for (const p of [
        "test/a.test.js",                 // tests are the thing being judged
        "node_modules/pkg/index.js",      // not ours
        "dist/bundle.js", "coverage/lcov-report/x.js",
        "package.json", "README.md", "core/style.css",
    ]) {
        assert.ok(!isSourceFile(p), `${p} should not be source`);
    }
});

// --------------------------------------------------------- against real git ---
// parseUnifiedDiff can be pinned with fixtures, but the whitespace filter is a
// set intersection across two separate `git diff` invocations. Only real git
// can prove those two passes agree on line numbering.

function tmpRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnex-mutate-"));
    const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("config", "commit.gpgsign", "false");
    return { dir, g };
}

test("whitespace-only edits are excluded, real edits on the same file survive", () => {
    const { dir, g } = tmpRepo();
    try {
        // Two functions. Only the second gets a semantic change.
        fs.writeFileSync(path.join(dir, "a.js"),
            "function one() {\n    return 1;\n}\nfunction two() {\n    return 2;\n}\n");
        g("add", "."); g("commit", "-qm", "base");

        // Line 2 is re-indented (no semantic change); line 5 genuinely changes.
        fs.writeFileSync(path.join(dir, "a.js"),
            "function one() {\n        return 1;\n}\nfunction two() {\n    return 22;\n}\n");

        const s = scopeChanges("HEAD", { cwd: dir });
        const f = s.files.find((x) => x.path === "a.js");

        assert.ok(f, "the file must still be scoped — it has a real change");
        assert.deepStrictEqual(f.addedLines, [5], "only the semantic edit should survive");
        assert.strictEqual(s.excluded.formattingOnly, 1, "the re-indent must be excluded");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a file changed only in whitespace drops out of scope entirely", () => {
    const { dir, g } = tmpRepo();
    try {
        fs.writeFileSync(path.join(dir, "a.js"), "const x = 1;\nconst y = 2;\n");
        g("add", "."); g("commit", "-qm", "base");
        fs.writeFileSync(path.join(dir, "a.js"), "const x   =   1;\nconst y = 2;\n");

        const s = scopeChanges("HEAD", { cwd: dir });
        assert.strictEqual(s.files.length, 0, "no mutants should be generated for a reformat");
        assert.strictEqual(s.changedLines, 0);
        assert.ok(s.excluded.formattingOnly > 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("untracked source files are scoped as fully added", () => {
    // An agent that writes a new file leaves it untracked until `git add`.
    // Reporting "nothing to mutate" there would be the most confusing possible
    // answer, so untracked files are read directly.
    const { dir, g } = tmpRepo();
    try {
        fs.writeFileSync(path.join(dir, "seed.js"), "module.exports = 1;\n");
        g("add", "."); g("commit", "-qm", "base");

        fs.writeFileSync(path.join(dir, "fresh.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
        fs.writeFileSync(path.join(dir, "fresh.test.js"), "// a test, must be skipped\n");
        fs.writeFileSync(path.join(dir, "notes.md"), "# not source\n");

        const s = scopeChanges("HEAD", { cwd: dir });
        const f = s.files.find((x) => x.path === "fresh.js");

        assert.ok(f, "a brand new untracked source file must be scoped");
        assert.strictEqual(f.untracked, true);
        assert.deepStrictEqual(f.addedLines, [1, 2, 3], "trailing newline must not add a 4th line");
        assert.ok(s.excluded.tests.includes("fresh.test.js"));
        assert.ok(s.excluded.nonSource.includes("notes.md"));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("an unresolvable ref fails loudly and names the CI cause", () => {
    // The shallow-clone footgun: actions/checkout defaults to depth 1, so
    // `git diff origin/main` fails. Returning an empty scope there would make
    // the gate silently pass on every pull request.
    const { dir, g } = tmpRepo();
    try {
        fs.writeFileSync(path.join(dir, "a.js"), "const x = 1;\n");
        g("add", "."); g("commit", "-qm", "base");
        assert.throws(
            () => scopeChanges("origin/nonexistent-branch", { cwd: dir }),
            /fetch-depth|cannot resolve/,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("the module tree loads without acorn installed", () => {
    // scripts/smoke.js require()s every file under core/ on a bare clone, and
    // acorn is an optionalDependency. A top-level require would turn a fresh
    // `npm run smoke` red.
    const mutate = require("../core/mutate");
    assert.strictEqual(typeof mutate.scope, "function");
    assert.strictEqual(typeof mutate.acornAvailable, "function");
    if (!mutate.acornAvailable()) {
        assert.throws(() => mutate.assertAcorn(), /acorn/);
    }
});
