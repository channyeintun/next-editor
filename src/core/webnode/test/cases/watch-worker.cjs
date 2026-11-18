// Watch mode with worker threads, as Node runs it: a file that only a worker
// thread loads restarts `node --watch` too. A thread reports what it loads to
// its parent, which passes the report on to the supervisor; the program's own
// listeners get those reports as messages as well. A thread given `--watch`
// among its own options runs its file once: only a process supervises.
const { spawn } = require("child_process");
const fs = require("fs");

fs.writeFileSync("dep.js", "module.exports = 1;");
fs.writeFileSync(
  "w.js",
  "require('worker_threads').parentPort.postMessage('dep ' + require('./dep.js'));",
);
fs.writeFileSync("dep.mjs", "export default 3;");
fs.writeFileSync("w.mjs", "import dep from './dep.mjs'; process.exitCode = dep;");
fs.writeFileSync(
  "main.js",
  `const { Worker } = require('worker_threads');
const show = (message) => console.log('main got', JSON.stringify(message).split(__dirname).join('.'));
const cjs = new Worker(__dirname + '/w.js');
cjs.on('message', show);
cjs.on('exit', () => {
  const esm = new Worker(__dirname + '/w.mjs');
  esm.on('message', show);
  esm.on('exit', (code) => console.log('esm worker exit', code));
});
`,
);

const supervisor = spawn(process.execPath, ["--watch", "main.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1" },
});
let output = "";
const steps = [
  () => fs.writeFileSync("dep.js", "module.exports = 2;"),
  () => fs.writeFileSync("dep.mjs", "export default 4;"),
  () => supervisor.kill("SIGINT"),
];
let runs = 0;
supervisor.stdout.on("data", (chunk) => {
  output += chunk;
  // A moment after each run ends, the next step.
  while (output.split("Completed running").length - 1 > runs) {
    setTimeout(steps[runs], 300);
    runs += 1;
  }
});
supervisor.stderr.on("data", (chunk) => {
  output += chunk;
});
supervisor.on("exit", (code, signal) => {
  console.log(output.split(process.cwd()).join("<cwd>").trimEnd());
  console.log("supervisor exit", code, signal);
  fs.writeFileSync(
    "once.js",
    "console.log('thread ran', require('worker_threads').isMainThread, process.execArgv);",
  );
  const { Worker } = require("worker_threads");
  const thread = new Worker(process.cwd() + "/once.js", { execArgv: ["--watch"] });
  thread.on("exit", (threadCode) => console.log("thread exit", threadCode));
});
