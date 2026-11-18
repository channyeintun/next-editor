// `tsx watch --include views`: an entry of views that was there before tsx
// started is reported, as it goes, as what it was: a folder by `unlinkDir`,
// a file by `unlink`.
//
// Real Node has no `tsx` command, so there this case prints EXPECTED: what
// tsx 4.23.1 printed for the same steps. To check that record against a real
// tsx, name one: WEBNODE_CASE_TSX=<path to tsx> node watch-tsx-folders.cjs
const { spawn } = require("child_process");
const fs = require("fs");

const EXPECTED = `run
<time> [tsx] unlinkDir in ./views/empty Restarting...
run
<time> [tsx] unlinkDir in ./views/full/deep Restarting...
run
<time> [tsx] unlink in ./views/f.html Restarting...
run
supervisor exit 130 null`;

// webnode's own tsx is the command in /bin.
const tsx = process.env.WEBNODE_CASE_TSX || (fs.existsSync("/bin/tsx") ? "tsx" : null);

function watchSteps() {
  // A folder of its own: the cases share a working directory.
  process.chdir(fs.mkdtempSync("tsx-folders-"));
  fs.mkdirSync("views/empty", { recursive: true });
  fs.mkdirSync("views/full/deep", { recursive: true });
  fs.writeFileSync("views/full/a.html", "a\n");
  fs.writeFileSync("views/f.html", "f\n");
  fs.writeFileSync(
    "server.ts",
    "const word: string = 'run';\nconsole.log(word);\nsetInterval(() => {}, 1000);\n",
  );
  const supervisor = spawn(
    tsx,
    ["watch", "--clear-screen=false", "--include", "views", "server.ts"],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
  );
  // Each step waits for the program to have started once more, then a moment more.
  const steps = [
    () => fs.rmdirSync("views/empty"),
    () => fs.rmdirSync("views/full/deep"),
    () => fs.unlinkSync("views/f.html"),
    () => supervisor.kill("SIGINT"),
  ];
  let output = "";
  let next = 0;
  const collect = (chunk) => {
    output += chunk;
    while (next < steps.length && output.split("run\n").length - 1 > next) {
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
  });
}

if (tsx === null) {
  console.log(EXPECTED);
} else {
  watchSteps();
}
