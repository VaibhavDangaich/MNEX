const { getGitContext } = require("../core/context");

program
    .command("ask <question>")
    .description("Ask the AI agent a question")
    .action((question) => {
        const cwd = process.cwd();
        const gitContext = getGitContext(cwd);

        console.log("\nContext:");

        console.log("• Directory:", cwd.split("/").pop());

        if (gitContext.isGitRepo) {
            console.log("• Git repo: YES");
            console.log("• Project:", gitContext.repoName);
            console.log("• Branch:", gitContext.branch);
        } else {
            console.log("• Git repo: NO");
        }

        console.log("\nQuestion:");
        console.log(question);
    });