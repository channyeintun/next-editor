// npm and what it runs, as npm 10 and 11 end: a failed script's status is
// passed on without a word; a script (or an `npm exec` / `npx` command, or a
// bin in node_modules/.bin) that a signal ended makes npm die of that signal,
// so its parent sees the signal; a signal Node survives (SIGUSR1) is reported
// and npm exits 1; and a failed install script is reported, with no summary.
const { spawn } = require("child_process");
const fs = require("fs");

const node = (code) => `node -e "${code}"`;
fs.writeFileSync(
  "package.json",
  JSON.stringify({
    name: "case",
    version: "1.0.0",
    scripts: {
      fail: "exit 3",
      term: node("process.kill(process.pid, 'SIGTERM')"),
      int: node("process.kill(process.pid, 'SIGINT')"),
      usr1: "kill -USR1 $$",
    },
  }),
);
fs.mkdirSync("node_modules/.bin", { recursive: true });
fs.writeFileSync(
  "node_modules/.bin/selfterm",
  "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n",
  { mode: 0o755 },
);
fs.mkdirSync("inst");
fs.writeFileSync(
  "inst/package.json",
  JSON.stringify({
    name: "inst",
    version: "1.0.0",
    scripts: { preinstall: "echo PRE", postinstall: "exit 7", prepare: "echo PREPARE" },
  }),
);

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) => {
      console.log(`$ ${command} ${args.join(" ")}`);
      // npm's own report; the path it names is the directory the command ran in.
      for (const line of stderr.split("\n")) {
        if (line.startsWith("npm error path ")) {
          console.log("npm error path <cwd>");
        } else if (line.startsWith("npm error ") && !line.includes("complete log")) {
          console.log(line);
        }
      }
      console.log("exit", code, signal);
      resolve(stdout);
    });
  });
}

(async () => {
  await run("npm", ["run", "fail"]);
  await run("npm", ["run", "term"]);
  await run("npm", ["run", "int"]);
  await run("npm", ["run", "usr1"]);
  await run("npm", ["exec", "-c", node("process.kill(process.pid, 'SIGTERM')")]);
  await run("npx", ["-c", node("process.kill(process.pid, 'SIGINT')")]);
  await run("npx", ["selfterm"]);
  const installed = await run("npm", ["install", "--no-audit", "--no-fund"], "inst");
  console.log(
    "ran:",
    installed.split("\n").filter((line) => /^[A-Z]+$/.test(line)),
  );
  console.log("summary printed:", /up to date|added \d+ package/.test(installed));
})();
