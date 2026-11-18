// `tsx watch` through the real kernel: the supervisor runs a TypeScript
// program, reruns it when a file the program loaded changes, when Enter is
// typed, when a folder appears under --include and when the --include folder
// itself goes and comes back, ends with 130 on SIGINT, and refuses to start
// without a script.
//
// Real Node has no `tsx` command, so there this case prints EXPECTED: what
// tsx 4.23.13 printed for the same steps. To check that record against a real
// tsx, name one: WEBNODE_CASE_TSX=<path to tsx> node watch-tsx.cjs
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");

const EXPECTED = `one run
<time> [tsx] change in ./src/dep.ts Restarting...
two run
<time> [tsx] Return key Restarting...
two run
<time> [tsx] addDir in ./views/partials Restarting...
two run
<time> [tsx] unlinkDir in ./views Restarting...
two run
<time> [tsx] addDir in ./views Restarting...
two run
supervisor exit 130 null
no script: exit 1
stderr: Error: Missing required parameter "script path"
stdout: tsx watch | Run the script and watch for changes | USAGE: |   tsx watch [flags...] <script path> | FLAGS:`;

// webnode's own tsx is the command in /bin.
const tsx = process.env.WEBNODE_CASE_TSX || (fs.existsSync("/bin/tsx") ? "tsx" : null);

function watchSteps(done) {
  fs.mkdirSync("src");
  fs.mkdirSync("views");
  fs.writeFileSync("src/dep.ts", "export const greeting: string = 'one';\n");
  fs.writeFileSync(
    "src/server.ts",
    "import { greeting } from './dep';\nconst word: string = 'run';\nconsole.log(greeting, word);\nsetInterval(() => {}, 1000);\n",
  );
  const supervisor = spawn(
    tsx,
    ["watch", "--clear-screen=false", "--include", "views", "src/server.ts"],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
  );
  // Each step waits for the program to have started `runs` times, then a moment more.
  const steps = [
    () => fs.writeFileSync("src/dep.ts", "export const greeting: string = 'two';\n"),
    () => supervisor.stdin.write("\n"),
    () => fs.mkdirSync("views/partials"),
    () => fs.rmSync("views", { recursive: true }),
    () => fs.mkdirSync("views"),
    () => supervisor.kill("SIGINT"),
  ];
  let output = "";
  let next = 0;
  const collect = (chunk) => {
    output += chunk;
    while (next < steps.length && output.split(" run\n").length - 1 > next) {
      setTimeout(steps[next], 500);
      next += 1;
    }
  };
  supervisor.stdout.on("data", collect);
  supervisor.stderr.on("data", collect);
  supervisor.on("exit", (code, signal) => {
    // tsx's lines start with the time of day.
    console.log(output.replace(/^.*(?=\[tsx\])/gm, "<time> ").trimEnd());
    console.log("supervisor exit", code, signal);
    done();
  });
}

function noScript() {
  const result = spawnSync(tsx, ["watch"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  console.log("no script: exit", result.status);
  console.log("stderr:", result.stderr.trim());
  console.log("stdout:", result.stdout.split("\n").filter(Boolean).slice(0, 5).join(" | "));
}

if (tsx === null) {
  console.log(EXPECTED);
} else {
  watchSteps(noScript);
}
