// Exit codes and module detection decided by the `node` program itself, each
// run in a child process: an unsettled top-level await (13), a rejected ES
// module entry caught by an uncaughtException handler, an `--import` preload
// that never settles (the main module never runs; exit 0), and code whose only ES
// module syntax is a top-level await (`--input-type=module`, `-e`, a .js file).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = path.join(process.cwd(), "tmp-loader-exit");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const files = {
  "never.mjs": "console.log('waiting'); await new Promise(() => {});",
  "never-after-timer.mjs":
    "await new Promise((resolve) => setTimeout(resolve, 20)); console.log('timer done'); await new Promise(() => {});",
  "preload-never.mjs": "await new Promise(() => {});",
  "main.mjs": "console.log('main ran');",
  "reject-async.mjs":
    "process.on('uncaughtException', (error) => console.log('caught', error.message)); await Promise.resolve(); throw new Error('later');",
  "reject-sync.mjs":
    "process.on('uncaughtException', (error) => console.log('caught', error.message)); throw new Error('at once');",
  "reject-exit-code.mjs":
    "process.on('uncaughtException', () => { process.exitCode = 4; }); await null; throw new Error('x');",
  "settles.mjs": "await new Promise((resolve) => setTimeout(resolve, 10)); console.log('settled');",
  "tla-only.js": "const value = await Promise.resolve('tla js'); console.log(value);",
  "script-return.js": "console.log('script'); return; console.log('never');",
};
for (const [name, text] of Object.entries(files)) {
  fs.writeFileSync(path.join(dir, name), text);
}

function run(args) {
  const result = spawnSync("node", args, { cwd: dir, encoding: "utf8" });
  console.log(JSON.stringify(args), result.status, JSON.stringify(result.stdout));
}

run(["never.mjs"]);
run(["never-after-timer.mjs"]);
run(["--import", "./preload-never.mjs", "main.mjs"]);
run(["reject-async.mjs"]);
run(["reject-sync.mjs"]);
run(["reject-exit-code.mjs"]);
run(["settles.mjs"]);
run(["tla-only.js"]);
run(["script-return.js"]);
run(["--input-type=module", "-e", "const n = await Promise.resolve(5); console.log(n)"]);
run(["--input-type=module", "-e", "console.log(typeof require, typeof exports)"]);
run(["-e", "console.log(await Promise.resolve(6))"]);
fs.rmSync(dir, { recursive: true, force: true });
