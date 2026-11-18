const fs = require("fs");
const path = require("path");
const dir = path.join(process.cwd(), "bench-tmp");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "small.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
fs.writeFileSync(path.join(dir, "big.js"), "x".repeat(200 * 1024));
function time(label, count, run) {
  const start = performance.now();
  for (let i = 0; i < count; i += 1) run();
  const ms = performance.now() - start;
  console.log(
    `${label.padEnd(28)} ${count} calls  ${ms.toFixed(0).padStart(6)} ms  ${((ms / count) * 1000).toFixed(1).padStart(7)} us/call`,
  );
}
time("statSync (exists)", 20000, () => fs.statSync(path.join(dir, "small.json")));
time("existsSync (missing)", 20000, () => fs.existsSync(path.join(dir, "missing.js")));
time("readFileSync 40 B", 10000, () => fs.readFileSync(path.join(dir, "small.json"), "utf8"));
time("readFileSync 200 KB", 2000, () => fs.readFileSync(path.join(dir, "big.js")));
time("readdirSync", 10000, () => fs.readdirSync(dir));
fs.rmSync(dir, { recursive: true, force: true });
