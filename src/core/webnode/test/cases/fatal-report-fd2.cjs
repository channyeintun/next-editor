// Node writes the report of an uncaught error to fd 2 itself, so the report
// reaches stderr's reader even when the program had ended or destroyed its
// process.stderr, and it comes after everything the program wrote there:
// through a shell pipe, into a file, for an error from 'exit' listeners and
// for a worker thread's error that the parent does not handle.
const { execSync } = require("child_process");
const fs = require("fs");

fs.writeFileSync(
  "fatal.cjs",
  `const how = process.argv[2];
if (how === "end") {
  process.stderr.write("before\\n");
  process.stderr.end();
  setTimeout(() => process.stderr.write("x\\n"), 20);
} else if (how === "big") {
  process.stderr.write("a".repeat(200000) + "\\n");
  process.stderr.write("last\\n");
  throw new Error("after big");
} else if (how === "worker") {
  const { Worker } = require("worker_threads");
  process.stderr.write("before\\n");
  process.stderr.end();
  new Worker("throw new Error('from the thread')", { eval: true });
} else if (how === "destroy") {
  process.stderr.write("before\\n");
  process.stderr.destroy();
  setTimeout(() => { throw new Error("after destroy"); }, 20);
} else if (how === "exit") {
  process.stderr.write("before\\n");
  process.stderr.end();
  process.on("exit", () => { throw new Error("in exit"); });
}
`,
);
// What came, line by line: a long line by its length, the program's own
// lines, the report's error line and its last line (the version left out).
fs.writeFileSync(
  "show.cjs",
  `let data = "";
process.stdin.on("data", (d) => (data += d));
process.stdin.on("end", () => {
  const shown = [];
  for (const line of data.split("\\n")) {
    if (line.length > 1000) shown.push("(" + line.length + " bytes)");
    else if (/^(before|last|x|Node\\.js v)/.test(line) || /^\\S*Error/.test(line)) shown.push(line.replace(/v\\d+\\.\\d+\\.\\d+/, "vN"));
  }
  console.log(shown.join(" | "));
});
`,
);

const sh = (line) => execSync(line, { encoding: "utf8", shell: "/bin/sh" }).trimEnd();

for (const how of ["end", "worker", "destroy", "exit"]) {
  console.log(`pipe ${how}: ${sh(`node fatal.cjs ${how} 2>&1 >/dev/null | node show.cjs`)}`);
}
for (const how of ["end", "big", "worker", "destroy", "exit"]) {
  const status = sh(`node fatal.cjs ${how} 2>err.txt >/dev/null; echo $?`);
  console.log(`file ${how}: status ${status}: ${sh("node show.cjs < err.txt")}`);
}
