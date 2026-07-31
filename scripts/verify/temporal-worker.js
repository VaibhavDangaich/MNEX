// A worker running the REAL mnex workflow file, but with stubbed activities that
// record every invocation to disk. That lets us prove Temporal's resume
// semantics against the actual workflow code without touching GitHub.
const fs = require("fs");
const { Worker, NativeConnection } = require("@temporalio/worker");
const LOG = process.env.VERIFY_LOG;
const REPOS = Number(process.env.VERIFY_REPOS || 6);

const record = (line) => fs.appendFileSync(LOG, line + "\n");

(async () => {
  const connection = await NativeConnection.connect({ address: "localhost:7233" });
  const bundlePath = process.env.VERIFY_BUNDLE;
  const worker = await Worker.create({
    ...(bundlePath
        ? { workflowBundle: { codePath: bundlePath } }
        : { workflowsPath: require.resolve("../../core/orchestration/temporal/workflows.js") }),
    taskQueue: "mnex-verify",
    connection,
    activities: {
      listRepos: async () =>
        Array.from({ length: REPOS }, (_, i) => ({
          full_name: `acme/repo${i}`, owner: "acme", name: `repo${i}`,
        })),
      indexRepo: async ({ repo }) => {
        record(`${process.pid} ${repo}`);
        await new Promise((r) => setTimeout(r, 700)); // long enough to interrupt
        return { indexed: 1 };
      },
      indexStarred: async () => ({ count: 0 }),
      echo: async ({ value }) => ({ echoed: value }),
    },
  });
  process.on("SIGTERM", () => worker.shutdown());
  await worker.run();
})().catch((e) => { console.error("worker error:", e.message); process.exit(1); });
