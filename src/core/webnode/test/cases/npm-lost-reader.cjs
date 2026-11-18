// npm and pnpm whose output has lost its reader (`| true` takes nothing):
// npm ends at once with 1 and leaves the script it started to run on to its
// end, starting nothing after it; at log level silent it prints nothing, so
// nothing loses its reader and its status is the script's. pnpm survives its
// first lost write and dies (1, Node's report of the unhandled EPIPE) at the
// next one, the header of the script after a pre script.
const { spawnSync } = require("child_process");
const fs = require("fs");

fs.writeFileSync(
  "package.json",
  JSON.stringify({
    name: "case",
    version: "1.0.0",
    scripts: {
      slow: "sleep 2; echo ran >> slow.log",
      prehook: "echo pre >> ran.log",
      hook: "echo hook >> ran.log",
      posthook: "echo post >> ran.log",
      append: "echo ran >> ran.log",
      quiet: "echo quiet >> ran.log; exit 4",
      loud: "echo loud; echo loud >> ran.log",
    },
  }),
);

// No update check: the case reaches no registry.
const env = { ...process.env, npm_config_update_notifier: "false" };

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").join(",") : "-";
}

/**
 * Runs `line` into a pipe nobody reads, under `set -o pipefail`, and returns
 * its status and stderr. A script npm left running holds the stderr pipe
 * open, so this returns once that script has ended too.
 */
function intoClosedPipe(line) {
  fs.rmSync("ran.log", { force: true });
  const result = spawnSync("sh", ["-c", `set -o pipefail; ${line} | true`], {
    env,
    encoding: "utf8",
  });
  return { status: result.status, err: result.stderr };
}

/** Prints the status of `line`, what its scripts logged and its stderr. */
function pipeline(line) {
  const { status, err } = intoClosedPipe(line);
  console.log(`${line}: status ${status}, ran ${read("ran.log")}, stderr ${JSON.stringify(err)}`);
}

// The script outlives npm: its file is missing when the pipeline has ended.
fs.rmSync("slow.log", { force: true });
const slow = spawnSync("sh", ["-c", "set -o pipefail; npm run slow | true"], {
  env,
  stdio: "ignore",
});
console.log(`npm run slow | true: status ${slow.status}, slow.log ${read("slow.log")}`);
spawnSync("sleep", ["3"]);
console.log(`three seconds later: slow.log ${read("slow.log")}`);

pipeline("npm run hook");
pipeline("npm run append");
pipeline("npm run loud");
pipeline("npm run -s loud");
for (const flags of ["-s", "--silent", "--loglevel silent", "--loglevel=silent"]) {
  pipeline(`npm run ${flags} append`);
  pipeline(`npm run ${flags} quiet`);
}
pipeline("npm_config_loglevel=silent npm run quiet");

pipeline("pnpm run append");
// Whether pnpm 9.12 has started the script itself before it dies is a race
// (not in 9 of 10 runs), and Node's report names pnpm's own source: the case
// tells the pre script, the post script and the report's error line.
{
  const { status, err } = intoClosedPipe("pnpm run hook");
  const ran = read("ran.log").split(",");
  console.log(
    `pnpm run hook: status ${status}, first ${ran[0]}, post ran ${ran.includes("post")}, ${
      err.includes("\nError: write EPIPE\n") ? "EPIPE report" : JSON.stringify(err)
    }`,
  );
}
