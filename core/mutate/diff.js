/**
 * Diff scoping for the mutation gate.
 *
 * Everything downstream — mutant generation, coverage lookup, scoring — runs on
 * the set of source lines a change actually touched. Get this wrong in one
 * direction and the tool mutates the whole repo (slow, and it scores code the
 * author never wrote); get it wrong in the other and it silently misses the
 * lines the agent just added and reports a perfect score.
 *
 * Three git flags carry most of the correctness:
 *
 *   -U0          Zero context lines. Context lines are indistinguishable from
 *                changed ones once you are counting line numbers by hand, and
 *                mis-counting one puts a mutant on a line the change never
 *                touched. With -U0 a hunk body contains only +/- lines.
 *
 *   --no-prefix  Drops the a/ b/ prefixes, so the +++ line is the real path.
 *
 *   core.quotePath=false
 *                Without it git C-escapes and quotes any non-ASCII path, which
 *                would make those files silently unresolvable.
 *
 * Formatting-only lines are removed by running the diff a second time with
 * -w --ignore-blank-lines and intersecting the two results: a line present in
 * the first pass but absent from the second changed only in whitespace. Both
 * passes number lines against the real post-image file, so the intersection is
 * sound — this is why it is done with git rather than by guessing at the AST.
 *
 * Untracked files count as fully added. An agent that writes a new file leaves
 * it untracked until someone runs `git add`, and answering "nothing to mutate"
 * in that situation is the most confusing thing this tool could do.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SOURCE_EXT = new Set([".js", ".mjs", ".cjs"]);

// Kept deliberately generic. This module has to work on any repository, so it
// must not encode this project's own layout.
const EXCLUDED_DIRS = new Set([
    "node_modules", "dist", "build", "out", "coverage", "vendor",
    "third_party", ".git", ".next", ".nuxt", "bower_components",
]);

const TEST_PATTERNS = [
    /(^|\/)tests?\//,
    /(^|\/)__tests__\//,
    /\.test\.[cm]?js$/,
    /\.spec\.[cm]?js$/,
];

function normalize(p) {
    return String(p || "").replace(/\\/g, "/");
}

function isTestFile(p) {
    const n = normalize(p);
    return TEST_PATTERNS.some((re) => re.test(n));
}

function isSourceFile(p) {
    const n = normalize(p);
    if (!SOURCE_EXT.has(path.extname(n))) return false;
    if (isTestFile(n)) return false;
    return !n.split("/").some((seg) => EXCLUDED_DIRS.has(seg));
}

// ------------------------------------------------------------------- git ---

function git(args, cwd) {
    return execFileSync("git", args, {
        encoding: "utf-8",
        cwd,
        maxBuffer: 32 * 1024 * 1024,
    });
}

/**
 * The raw unified diff for `base`, already flagged for machine parsing.
 *
 * Errors are NOT swallowed. A shallow clone makes `git diff origin/main` fail,
 * and returning "" there would report a clean scope on every CI run — a gate
 * that silently passes is worse than no gate.
 */
function rawDiff(base = "HEAD", { ignoreWhitespace = false, cwd = process.cwd() } = {}) {
    const args = [
        "-c", "core.quotePath=false",
        "diff", "--no-color", "--no-prefix", "--no-ext-diff", "-U0",
    ];
    if (ignoreWhitespace) args.push("-w", "--ignore-blank-lines");
    args.push(base, "--", ":!*lock*", ":!*.lock");

    try {
        return git(args, cwd);
    } catch (e) {
        const stderr = String(e.stderr || "");
        if (/unknown revision|bad revision|ambiguous argument|not a valid object/i.test(stderr)) {
            const ref = base.replace(/^origin\//, "");
            throw new Error(
                `git cannot resolve "${base}".\n` +
                `  In CI: actions/checkout clones at depth 1 by default — set fetch-depth: 0.\n` +
                `  Locally: git fetch --no-tags origin ${ref}`
            );
        }
        if (/not a git repository/i.test(stderr)) {
            throw new Error("not a git repository — the mutation gate scopes work by diff");
        }
        throw new Error(`git diff failed: ${stderr.trim() || e.message}`);
    }
}

function untrackedFiles(cwd = process.cwd()) {
    try {
        return git(["ls-files", "--others", "--exclude-standard"], cwd)
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

// ----------------------------------------------------------------- parse ---

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// git writes `--- path`; some producers append a tab and a timestamp.
function headerPath(s) {
    const tab = s.indexOf("\t");
    return (tab >= 0 ? s.slice(0, tab) : s).trim();
}

/**
 * Split the two paths out of a `diff --git <old> <new>` line.
 *
 * Needed because a binary file's entry has no ---/+++ lines at all, so this is
 * the only place its name appears. Under --no-prefix the two halves are byte
 * identical for a normal edit, which disambiguates paths containing spaces:
 * check for a separator exactly in the middle before falling back to the first
 * space (renames, where the halves genuinely differ).
 */
function pathsFromDiffGit(rest) {
    const mid = (rest.length - 1) / 2;
    if (Number.isInteger(mid) && rest[mid] === " ") {
        const a = rest.slice(0, mid);
        if (a === rest.slice(mid + 1)) return { old: a, next: a };
    }
    const i = rest.indexOf(" ");
    if (i < 0) return { old: rest, next: rest };
    return { old: rest.slice(0, i), next: rest.slice(i + 1) };
}

/**
 * Parse a unified diff into per-file post-image line sets.
 *
 * Pure string -> object: no git, no filesystem. That is deliberate — it is the
 * one piece of this subsystem that can be exhaustively unit-tested against
 * fixture patches, and every later phase depends on it being right.
 *
 * @returns {Array<{path, oldPath, status, addedLines: Set<number>, binary: boolean}>}
 */
function parseUnifiedDiff(patch) {
    const files = [];
    let cur = null;
    let newLine = 0;
    let inHunk = false;

    const flush = () => { if (cur) files.push(cur); };

    for (const line of String(patch || "").split("\n")) {
        if (line.startsWith("diff --git ")) {
            flush();
            const p = pathsFromDiffGit(line.slice(11).trim());
            // Seeded from the header so binary entries — which carry no ---/+++
            // lines — still resolve to a name. Overwritten below when they do.
            cur = {
                path: p.next, oldPath: p.old, status: "modified",
                addedLines: new Set(), binary: false,
            };
            inHunk = false;
            continue;
        }
        if (!cur) continue;

        // File header. Only meaningful before the first hunk — after that an
        // identical-looking line is content, and content is claimed below by
        // its +/- prefix.
        if (!inHunk) {
            if (line.startsWith("new file mode")) { cur.status = "added"; continue; }
            if (line.startsWith("deleted file mode")) { cur.status = "deleted"; continue; }
            if (line.startsWith("rename from ")) { cur.oldPath = line.slice(12).trim(); cur.status = "renamed"; continue; }
            if (line.startsWith("rename to ")) { cur.path = line.slice(10).trim(); cur.status = "renamed"; continue; }
            if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { cur.binary = true; continue; }
            if (line.startsWith("--- ")) { cur.oldPath = headerPath(line.slice(4)); continue; }
            if (line.startsWith("+++ ")) { cur.path = headerPath(line.slice(4)); continue; }
        }

        const m = HUNK.exec(line);
        if (m) {
            inHunk = true;
            newLine = parseInt(m[3], 10);
            continue;
        }
        if (!inHunk) continue;

        if (line === "") continue;                   // artifact of the final split
        if (line.startsWith("\\")) continue;         // "\ No newline at end of file"
        if (line.startsWith("-")) continue;          // consumes no post-image line
        if (line.startsWith("+")) { cur.addedLines.add(newLine); newLine++; continue; }
        newLine++;                                   // context (absent under -U0)
    }
    flush();

    for (const f of files) {
        if (f.path === "/dev/null") { f.path = f.oldPath; f.status = "deleted"; }
        if (f.oldPath === "/dev/null") f.status = "added";
    }
    return files.filter((f) => f.path);
}

// ----------------------------------------------------------------- scope ---

function everyLineOf(abs) {
    const src = fs.readFileSync(abs, "utf-8");
    if (!src) return [];
    const parts = src.split("\n");
    const total = src.endsWith("\n") ? parts.length - 1 : parts.length;
    return Array.from({ length: total }, (_, i) => i + 1);
}

/**
 * The changed source lines a mutation run should target.
 *
 * @returns {{
 *   base: string,
 *   files: Array<{path: string, addedLines: number[], untracked?: boolean}>,
 *   changedLines: number,
 *   excluded: {formattingOnly: number, tests: string[], nonSource: string[],
 *              binary: string[], deleted: string[]}
 * }}
 */
function scopeChanges(base = "HEAD", { cwd = process.cwd(), includeUntracked = true } = {}) {
    const tracked = parseUnifiedDiff(rawDiff(base, { cwd }));
    const meaningful = parseUnifiedDiff(rawDiff(base, { cwd, ignoreWhitespace: true }));
    const meaningfulByPath = new Map(meaningful.map((f) => [f.path, f.addedLines]));

    const excluded = { formattingOnly: 0, tests: [], nonSource: [], binary: [], deleted: [] };
    const files = [];

    for (const f of tracked) {
        if (f.binary) { excluded.binary.push(f.path); continue; }
        if (f.status === "deleted") { excluded.deleted.push(f.path); continue; }
        if (isTestFile(f.path)) { excluded.tests.push(f.path); continue; }
        if (!isSourceFile(f.path)) { excluded.nonSource.push(f.path); continue; }

        const kept = meaningfulByPath.get(f.path);
        const before = f.addedLines.size;
        // A file absent from the -w pass changed only in whitespace throughout.
        const lines = kept ? [...f.addedLines].filter((n) => kept.has(n)) : [];
        excluded.formattingOnly += before - lines.length;

        if (lines.length) files.push({ path: f.path, addedLines: lines.sort((a, b) => a - b) });
    }

    if (includeUntracked) {
        for (const p of untrackedFiles(cwd)) {
            if (isTestFile(p)) { excluded.tests.push(p); continue; }
            if (!isSourceFile(p)) { excluded.nonSource.push(p); continue; }
            try {
                const lines = everyLineOf(path.join(cwd, p));
                if (lines.length) files.push({ path: p, addedLines: lines, untracked: true });
            } catch {
                // unreadable (raced deletion, permissions) — not worth failing a run over
            }
        }
    }

    return {
        base,
        files,
        changedLines: files.reduce((n, f) => n + f.addedLines.length, 0),
        excluded,
    };
}

module.exports = {
    rawDiff,
    parseUnifiedDiff,
    scopeChanges,
    untrackedFiles,
    isSourceFile,
    isTestFile,
};
