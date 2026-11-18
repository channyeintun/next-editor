// A new descriptor takes the lowest number free, as POSIX says: once a
// program has closed fd 2, the next open is fd 2, and the report of an
// uncaught error, which Node writes to fd 2, lands in that file.
const { spawnSync } = require("child_process");
const fs = require("fs");

fs.writeFileSync(
  "lowest.cjs",
  `const fs = require("fs");
const how = process.argv[2];
if (how === "numbers") {
  fs.closeSync(2);
  const first = fs.openSync("lowest-a.txt", "w");
  const second = fs.openSync("lowest-b.txt", "w");
  fs.closeSync(first);
  const again = fs.openSync("lowest-c.txt", "w");
  // Node holds descriptors of its own above 2, so only 2 is the same number everywhere.
  fs.writeSync(1, \`first \${first}, then a higher one: \${second > first}, again \${again}\\n\`);
} else {
  fs.closeSync(2);
  fs.openSync("lowest-report.txt", "w");
  null.x;
}
`,
);

const numbers = spawnSync(process.execPath, ["lowest.cjs", "numbers"], { encoding: "utf8" });
console.log("numbers:", numbers.stdout.trim(), "status", numbers.status);

const crash = spawnSync(process.execPath, ["lowest.cjs", "crash"], { encoding: "utf8" });
const report = fs.readFileSync("lowest-report.txt", "utf8");
console.log("crash status", crash.status, "stderr", JSON.stringify(crash.stderr));
console.log(
  "report:",
  report.split("\n").find((line) => line.startsWith("TypeError")),
);

for (const name of [
  "lowest.cjs",
  "lowest-a.txt",
  "lowest-b.txt",
  "lowest-c.txt",
  "lowest-report.txt",
]) {
  fs.rmSync(name, { force: true });
}
