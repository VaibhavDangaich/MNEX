/**
 * mnex mutate — a diff-scoped mutation gate.
 *
 * The question this answers about a change: did it raise the coverage number
 * without raising the safety net? Coverage measures execution, not verification,
 * and a test suite can execute every changed line while asserting nothing about
 * any of them. Mutation testing settles it empirically — break the code on
 * purpose, re-run the tests, and count how many breakages nobody noticed.
 *
 * It reads `git diff` and nothing else, so it is indifferent to what produced
 * the change: an agent, a teammate, or you at 2am.
 *
 * Build phases (see the plan): this file grows one export per phase.
 *   0  scope    — which source lines did this change touch          [here]
 *   1  generate — the mutants those lines admit
 *   2  execute  — run the suite against each mutant
 *   3  select   — run only the tests that cover the mutated offset
 *   4  score    — the verdict, thresholds and the baseline ratchet
 */

const diff = require("./diff");

/**
 * `acorn` is an optionalDependency: mutant generation needs a real parser, but
 * scoping does not, so a missing parser must degrade rather than crash. Mirrors
 * the availability pattern in core/orchestration/temporal/adapter.js.
 */
function acornAvailable() {
    try {
        require.resolve("acorn");
        return true;
    } catch {
        return false;
    }
}

function assertAcorn() {
    if (acornAvailable()) return;
    throw new Error(
        "mutant generation needs `acorn`, which is not installed.\n" +
        "  npm i -g acorn     (alongside a global mnex)\n" +
        "  npm i -D acorn     (project-local)\n" +
        "`mnex mutate --dry-run` works without it."
    );
}

/** Phase 0: report the scope without generating or running anything. */
function scope({ target = "HEAD", cwd = process.cwd() } = {}) {
    return diff.scopeChanges(target, { cwd });
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function formatScope(s) {
    const out = [];
    out.push(`\nScope — vs ${s.base}\n`);

    if (!s.files.length) {
        out.push("  nothing to mutate — no changed source lines\n");
    } else {
        const width = Math.max(...s.files.map((f) => f.path.length));
        for (const f of s.files) {
            const n = f.addedLines.length;
            const count = String(n).padStart(5);
            const word = (n === 1 ? "line" : "lines").padEnd(5);
            out.push(`  ${f.path.padEnd(width)} ${count} ${word}${f.untracked ? "  (untracked)" : ""}`);
        }
        out.push("");
        out.push(`  ${plural(s.changedLines, "changed source line")} across ${plural(s.files.length, "file")}`);
    }

    const ex = s.excluded;
    const notes = [];
    if (ex.formattingOnly) notes.push([`${ex.formattingOnly} formatting-only`, ""]);
    if (ex.tests.length) notes.push([`${plural(ex.tests.length, "test file")}`, ex.tests.join(", ")]);
    if (ex.nonSource.length) notes.push([`${plural(ex.nonSource.length, "non-source")}`, ex.nonSource.join(", ")]);
    if (ex.binary.length) notes.push([`${plural(ex.binary.length, "binary")}`, ex.binary.join(", ")]);
    if (ex.deleted.length) notes.push([`${plural(ex.deleted.length, "deleted")}`, ex.deleted.join(", ")]);

    if (notes.length) {
        out.push("");
        const label = "  Excluded  ";
        notes.forEach(([what, detail], i) => {
            out.push(`${i === 0 ? label : " ".repeat(label.length)}${what.padEnd(22)}${detail}`);
        });
    }
    out.push("");
    return out.join("\n");
}

module.exports = {
    scope,
    formatScope,
    acornAvailable,
    assertAcorn,
    // re-exported so callers never need to reach past the package entry point
    scopeChanges: diff.scopeChanges,
    parseUnifiedDiff: diff.parseUnifiedDiff,
    isSourceFile: diff.isSourceFile,
    isTestFile: diff.isTestFile,
};
