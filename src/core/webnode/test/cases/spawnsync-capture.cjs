// spawnSync, execSync and execFileSync return once the child has exited and
// the pipes they capture have ended: a descendant that still holds one keeps
// the call waiting (up to its timeout), and its output is part of the result.
// Over maxBuffer the read that crossed the limit is kept whole.
const { spawnSync, execSync, execFileSync } = require("child_process");
const fs = require("fs");

const node = process.execPath;
// Prints "early", leaves a child that prints "late" 1.5 s later on the same stdout, and exits.
fs.writeFileSync(
  "leaver.js",
  `const { spawn } = require("child_process");
spawn(process.execPath, ["-e", "setTimeout(() => console.log('late'), 1500)"], { stdio: "inherit" }).unref();
console.log("early");
`,
);
// The same, with the child's output on stderr.
fs.writeFileSync(
  "leaver-err.js",
  `const { spawn } = require("child_process");
spawn(process.execPath, ["-e", "setTimeout(() => console.error('late'), 1500)"], { stdio: "inherit" }).unref();
console.log("early");
`,
);
const about = (start, step) => Math.round((Date.now() - start) / step) * step;

{
  const start = Date.now();
  const r = spawnSync(node, ["leaver.js"], { encoding: "utf8" });
  console.log(
    "spawnSync:",
    JSON.stringify(r.stdout),
    r.status,
    r.signal,
    r.error && r.error.code,
    about(start, 500) >= 1500,
  );
}
{
  const r = spawnSync(node, ["leaver-err.js"], { encoding: "utf8" });
  console.log("stderr held:", JSON.stringify(r.stdout), JSON.stringify(r.stderr), r.status);
}
{
  console.log(
    "execFileSync:",
    JSON.stringify(execFileSync(node, ["leaver.js"], { encoding: "utf8" })),
  );
  console.log("execSync:", JSON.stringify(execSync("node leaver.js", { encoding: "utf8" })));
}
{
  const r = spawnSync(node, ["leaver.js"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  console.log("stdout only:", JSON.stringify(r.stdout));
}
{
  const r = spawnSync(node, ["leaver.js"], { encoding: "utf8", timeout: 700 });
  console.log("timeout:", JSON.stringify(r.stdout), r.status, r.signal, r.error && r.error.code);
}
try {
  execSync("node leaver.js", { encoding: "utf8", timeout: 700 });
  console.log("execSync timeout: returned");
} catch (error) {
  console.log(
    "execSync timeout:",
    error.code,
    JSON.stringify(error.stdout),
    error.status,
    error.signal,
  );
}
{
  const r = spawnSync(
    node,
    ["-e", "process.stdout.write('a'.repeat(1027)); process.stdout.write('b'.repeat(5000))"],
    { maxBuffer: 1000 },
  );
  console.log("maxBuffer one write:", r.error && r.error.code, r.stdout.length, r.status, r.signal);
}
try {
  execSync(
    `node -e "process.stdout.write('a'.repeat(1027)); process.stdout.write('b'.repeat(5000))"`,
    { maxBuffer: 1000 },
  );
} catch (error) {
  console.log("execSync maxBuffer:", error.code, error.stdout.length, error.signal);
}
// Let the children the timeouts left behind finish before the case ends.
setTimeout(() => console.log("done"), 1700);
