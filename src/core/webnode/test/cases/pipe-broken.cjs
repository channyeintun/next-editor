// A pipe whose reader goes away: its writers learn of it as Node's do.
// writeFile to it fails with EPIPE, spawnSync reports the input its child
// left, a write to a child's stdin hears EPIPE before the child's exit, a
// killed writer's reader still gets the end, and a write to stdout after its
// reader has gone fails, each one with its own `write EPIPE`, while a console
// and a warning keep a failed write to themselves.
const { spawn, spawnSync, execSync } = require("child_process");
const fs = require("fs");

// Writes 1 MB to /dev/stdout with writeFile (argv[2]: sync, promises or
// callback) and says how that went in writeFile-<mode>.out.
fs.writeFileSync(
  "writefile.js",
  `const fs = require("fs");
const mode = process.argv[2];
const big = Buffer.alloc(1e6, 65);
const report = (text) => fs.writeFileSync("writefile-" + mode + ".out", text);
setTimeout(async () => {
  try {
    if (mode === "sync") fs.writeFileSync("/dev/stdout", big);
    else if (mode === "promises") await fs.promises.writeFile("/dev/stdout", big);
    else await new Promise((res, rej) => fs.writeFile("/dev/stdout", big, (e) => (e ? rej(e) : res())));
    report("ok");
  } catch (e) {
    report("threw " + e.code);
  }
}, 200);
`,
);
// Writes to stdout once its reader has long gone, and says how it ended.
fs.writeFileSync(
  "late.js",
  `const fs = require("fs");
process.on("exit", (code) => fs.writeFileSync("late.out", "exit " + code));
setTimeout(() => process.stdout.write("x\\n"), 300);
`,
);
// Writes nothing, then a line, to stdout once its reader has long gone, and
// says what the line's write heard.
fs.writeFileSync(
  "empty-first.js",
  `const fs = require("fs");
const seen = [];
process.on("exit", (code) => fs.writeFileSync("empty-first.out", seen.concat("exit " + code).join(", ")));
process.stdout.on("error", (e) => seen.push("error event " + e.code));
setTimeout(() => {
  process.stdout.write("");
  process.stdout.write("x\\n", (e) => seen.push("callback " + (e ? e.code : "no error")));
  setTimeout(() => seen.push("end"), 200);
}, 300);
`,
);
// Logs through the console to a reader that has long gone, then writes to
// stdout itself (argv[2] "listen": with an 'error' listener), and says what
// each write heard and how the process ended.
fs.writeFileSync(
  "own-write.js",
  `const fs = require("fs");
const seen = [];
process.on("exit", (code) => fs.writeFileSync("own-write.out", seen.concat("exit " + code).join(", ")));
if (process.argv[2] === "listen") {
  process.stdout.on("error", (e) => seen.push("error event: " + e.message + " (" + [e.code, e.errno, e.syscall] + ")"));
}
setTimeout(() => {
  console.log("via the console");
  setTimeout(() => {
    seen.push("stdout destroyed " + process.stdout.destroyed + ", writable " + process.stdout.writable);
    process.stdout.write("own write\\n", (e) => seen.push("own write: " + (e && e.message)));
    setTimeout(() => seen.push("still running"), 100);
  }, 100);
}, 300);
`,
);
// Emits a warning once the reader of its stderr has long gone, and says
// whether it lived on.
fs.writeFileSync(
  "warn.js",
  `setTimeout(() => {
  process.emitWarning("late warning");
  setTimeout(() => require("fs").writeFileSync("warn.out", "alive after the warning"), 100);
}, 300);
`,
);

function writeFileToGoneReader() {
  for (const mode of ["sync", "promises", "callback"]) {
    execSync(`node writefile.js ${mode} | head -c 1 > /dev/null`);
    console.log(
      `writeFile (${mode}) to a reader that goes:`,
      fs.readFileSync(`writefile-${mode}.out`, "utf8"),
    );
  }
}

function spawnSyncInputLeft() {
  const head = spawnSync("head", ["-c", "10"], { input: Buffer.alloc(1e6, 66) });
  const error = head.error;
  console.log(
    "head -c 10:",
    String(head.stdout),
    head.status,
    error && [error.code, error.errno, error.syscall],
  );
  const unread = spawnSync("node", ["-e", "0"], { input: Buffer.alloc(1e6) });
  console.log("node -e 0:", unread.status, unread.error && unread.error.code);
  const small = spawnSync("head", ["-c", "10"], { input: Buffer.alloc(1000, 66) });
  console.log("input that fits:", String(small.stdout), small.status, small.error);
  try {
    execSync("head -c 10", { input: Buffer.alloc(1e6, 65) });
    console.log("execSync returned");
  } catch (e) {
    console.log("execSync threw", e.code, e.status, String(e.stdout));
  }
}

function heard(child, out) {
  child.on("exit", (code, signal) => out.push(`exit ${signal ?? code}`));
  return new Promise((resolve) =>
    child.on("close", (code) => {
      out.push(`close ${code}`);
      resolve(out.join(", "));
    }),
  );
}

async function stdinOfAChildThatEnds() {
  const exits = "process.stdin.once('data', () => process.exit(0))";
  let out = [];
  let child = spawn("node", ["-e", exits]);
  child.stdin.on("error", (e) => out.push(`error ${e.code}`));
  child.stdin.write(Buffer.alloc(1e6), (e) => out.push(`callback ${e && e.code}`));
  console.log("write to stdin:", await heard(child, out));
  out = [];
  child = spawn("node", ["-e", exits]);
  child.stdin.on("error", (e) => out.push(`error ${e.code}`));
  child.stdin.end(Buffer.alloc(1e6));
  console.log("end stdin:", await heard(child, out), Boolean(child.stdin.errored));
}

async function killedWriter() {
  const child = spawn(
    "node",
    ["-e", "require('fs').writeFileSync('/dev/stdout', Buffer.alloc(1e6, 65))"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  setTimeout(() => child.kill("SIGKILL"), 500);
  console.log("killed while writing to /dev/stdout:", await heard(child, []));
}

// A console keeps a failed write to itself: logging to a reader that has gone
// is silent, and the program goes on (Node's Console swallows EPIPE).
function consoleToGoneReader(how) {
  const program = `const out = ${how}; setTimeout(() => { for (let i = 0; i < 3; i++) out.log("l" + i); process.stderr.write("alive\\n"); }, 300);`;
  const result = spawnSync(
    "sh",
    ["-c", `{ node -e '${program}'; echo "node exit $?" >&2; } | true`],
    { encoding: "utf8" },
  );
  console.log(
    `${how}.log to a reader that has gone:`,
    JSON.stringify(result.stderr),
    result.status,
  );
}

async function main() {
  consoleToGoneReader("console");
  consoleToGoneReader("new console.Console(process.stdout, process.stderr)");
  writeFileToGoneReader();
  spawnSyncInputLeft();
  await stdinOfAChildThatEnds();
  await killedWriter();
  execSync("node late.js 2>/dev/null | true");
  console.log("stdout written after its reader went:", fs.readFileSync("late.out", "utf8"));
  execSync("node empty-first.js | true");
  console.log(
    "an empty write, then a line, after the reader went:",
    fs.readFileSync("empty-first.out", "utf8"),
  );
  // The console kept its own failed write quiet, not the program's: stdout
  // is writable again, and the program's write fails with its own EPIPE.
  for (const mode of ["", "listen"]) {
    execSync(`node own-write.js ${mode} 2>/dev/null | true`);
    console.log(
      `the program's own write after the console's${mode && ", with a listener"}:`,
      fs.readFileSync("own-write.out", "utf8"),
    );
  }
  execSync('(node warn.js; echo "exit $?" > warn.code) 2>&1 >/dev/null | true');
  console.log(
    "a warning to a stderr whose reader went:",
    fs.existsSync("warn.out") ? fs.readFileSync("warn.out", "utf8") : "the process died",
    fs.readFileSync("warn.code", "utf8").trim(),
  );
}

main();
