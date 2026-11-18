// Pipes hold a bounded amount: a writer waits for its reader. Output far
// larger than a pipe still arrives whole whoever reads it, and when; a child
// whose output nobody reads waits instead of finishing; a reader that stops
// or ends leaves the rest of the pipe to the next reader.
const { spawn, spawnSync, execSync, exec } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");

const MB = 1 << 20;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
const closed = (child) => new Promise((resolve) => child.on("close", resolve));

// Writes argv[2] bytes of a pattern with blocking writes, 64 KiB at a time,
// then says so on stderr. With argv[3], keeps how far it got in that file.
fs.writeFileSync(
  "writer.js",
  `const fs = require("fs");
const size = Number(process.argv[2]);
const block = Buffer.alloc(65536);
for (let i = 0; i < block.length; i++) block[i] = i % 251;
let written = 0;
while (written < size) {
  written += fs.writeSync(1, block, 0, Math.min(block.length, size - written));
  if (process.argv[3]) fs.writeFileSync(process.argv[3], String(written));
}
fs.writeSync(2, "wrote " + written + "\\n");
`,
);
// Writes "y" lines until its reader goes away.
fs.writeFileSync(
  "yes.js",
  `process.stdout.on("error", () => process.exit(0));
const lines = "y\\n".repeat(1024);
(function more() {
  for (let i = 0; i < 16; i++) process.stdout.write(lines);
  setImmediate(more);
})();
`,
);

// Writes argv[2] bytes of 64-byte lines with blocking writes.
fs.writeFileSync(
  "lines.js",
  `const fs = require("fs");
const size = Number(process.argv[2]);
const block = Buffer.alloc(65536);
for (let i = 0; i < block.length; i++) block[i] = i % 64 === 63 ? 10 : 97 + (i % 26);
let written = 0;
while (written < size) written += fs.writeSync(1, block, 0, Math.min(block.length, size - written));
`,
);
// Counts what it reads on stdin.
fs.writeFileSync(
  "count.js",
  `let n = 0;
process.stdin.on("data", (d) => (n += d.length)).on("end", () => console.log(n));
`,
);
// Reads the first line with readline, closes it, then hands stdin to a child.
fs.writeFileSync(
  "handoff.js",
  `const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const rl = readline.createInterface({ input: process.stdin });
rl.once("line", (line) => {
  rl.close();
  console.log("header", line.length);
  const stdio = ["inherit", "pipe", "inherit"];
  if (process.argv[2] === "sync") {
    const count = Number(spawnSync("node", ["count.js"], { stdio }).stdout);
    console.log("child read the rest", count > 0);
  } else {
    let out = "";
    const child = spawn("node", ["count.js"], { stdio });
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => console.log("child read the rest", Number(out) > 0));
  }
});
`,
);
// Writes argv[2] bytes, 997 at a time from a timer; each byte is its offset mod 251.
fs.writeFileSync(
  "trickle.js",
  `const size = Number(process.argv[2]);
let written = 0;
const timer = setInterval(() => {
  const block = Buffer.alloc(Math.min(997, size - written));
  for (let i = 0; i < block.length; i++) block[i] = (written + i) % 251;
  process.stdout.write(block);
  written += block.length;
  if (written >= size) clearInterval(timer);
}, 1);
`,
);
// Reads up to argv[2] bytes of stdin with one blocking read; prints how many, and their sum.
fs.writeFileSync(
  "take.js",
  `const block = Buffer.alloc(Number(process.argv[2]));
const count = require("fs").readSync(0, block, 0, block.length, null);
let sum = 0;
for (let i = 0; i < count; i++) sum += block[i];
console.log(count + " " + sum);
`,
);
// Streams stdin, and after every third chunk waits (spawnSync) for a child that reads the same pipe.
fs.writeFileSync(
  "mix.js",
  `const { spawnSync } = require("child_process");
let count = 0, sum = 0, chunks = 0, children = 0, childCount = 0, childSum = 0;
process.stdin.on("data", (chunk) => {
  count += chunk.length;
  for (const byte of chunk) sum += byte;
  if (++chunks % 3 === 0 && children < 12) {
    children++;
    const taken = spawnSync("node", ["take.js", "5000"], { stdio: ["inherit", "pipe", "inherit"] });
    const [bytes, total] = String(taken.stdout).trim().split(" ").map(Number);
    childCount += bytes;
    childSum += total;
  }
});
process.stdin.on("end", () =>
  console.log("total", count + childCount, "sum", sum + childSum, "children read some", childCount > 0),
);
`,
);

/** Runs a shell line and returns what it printed, trimmed. */
const sh = (line) => execSync(line, { encoding: "utf8", maxBuffer: 10 * MB }).trim();

function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

async function readsLate() {
  const child = spawn("node", ["writer.js", String(MB)], { stdio: ["ignore", "pipe", "pipe"] });
  const stderr = collect(child.stderr);
  await wait(300);
  console.log("late reader: child still writing", child.exitCode === null && stderr().length === 0);
  const stdout = collect(child.stdout);
  await closed(child);
  const all = stdout();
  console.log("late reader got", all.length, digest(all), String(stderr()).trim(), child.exitCode);
}

async function pausesAndResumes() {
  const child = spawn("node", ["writer.js", String(MB)]);
  const chunks = [];
  let paused = false;
  child.stdout.on("data", (chunk) => {
    chunks.push(chunk);
    if (!paused) {
      paused = true;
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 300);
    }
  });
  await closed(child);
  const all = Buffer.concat(chunks);
  console.log("paused reader got", all.length, digest(all));
}

async function neverReads() {
  const child = spawn("node", ["writer.js", String(MB), "unread.out"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = collect(child.stderr);
  await wait(500);
  console.log("unread: child waits", child.exitCode === null && stderr().length === 0);
  // It got as far as its pipe holds and its parent's stream took before it
  // filled (64 KiB each): past the first, and no further than a block more.
  const reached = Number(fs.readFileSync("unread.out", "utf8"));
  console.log("unread: child wrote its pipe and the parent's buffer full", [
    reached > 65536,
    reached <= 3 * 65536,
  ]);
  const ended = new Promise((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
  child.kill();
  console.log("unread: ended by", await ended);
}

async function readsAfterExit() {
  const child = spawn("node", ["-e", "process.stdout.write('small output')"]);
  const got = await new Promise((resolve) =>
    child.on("exit", () => {
      const stdout = collect(child.stdout);
      child.stdout.on("end", () => resolve(String(stdout())));
    }),
  );
  console.log("after exit:", got);
}

async function stdinBothWays() {
  const child = spawn("node", ["-e", "process.stdin.pipe(process.stdout)"]);
  const stdout = collect(child.stdout);
  child.stdin.end(Buffer.alloc(2 * MB, 99));
  await closed(child);
  const all = stdout();
  console.log("through a child:", all.length, digest(all));
}

/** Readers that stop, or end, part of the way through a pipe others read after them. */
function readersInTurn() {
  // A shell read takes one line, and the command after it gets the rest, to
  // the byte: bash reads a pipe a byte at a time and takes nothing past the
  // line. The lines of lines.js are 64 bytes; `seq 1 100000` prints 588895.
  console.log("read, then a command:", sh("node lines.js 1000000 | { read -r x; node count.js; }"));
  console.log("seq, read, then a command:", sh("seq 1 100000 | { read -r x; node count.js; }"));
  console.log(
    "three reads, then a command:",
    sh("node lines.js 1000000 | { read -r a; read -r b; read -r c; node count.js; }"),
  );
  // head takes the ten bytes it prints and, with them, no more than a buffer
  // of its own (BSD head reads 16 KiB at a time, GNU head ten bytes).
  const afterHead = Number(
    sh("node lines.js 1000000 | { head -c 10 > /dev/null; node count.js; }"),
  );
  console.log("head, then a command:", [afterHead <= 1000000 - 10, afterHead >= 1000000 - 16384]);
  console.log("readline, then a child:", sh("node lines.js 1000000 | node handoff.js"));
  console.log("readline, then spawnSync:", sh("node lines.js 1000000 | node handoff.js sync"));
  // A process whose stdin is flowing waits for children that read the same
  // pipe: while it waits the bytes are theirs, afterwards its own again, and
  // every byte reaches one of them once.
  console.log(
    "a stream, and spawnSync children on its pipe:",
    sh("node trickle.js 200000 | node mix.js"),
  );
  // A reader that ends after its first chunk leaves the rest in the pipe.
  console.log(
    "first chunk, then exit:",
    sh(
      "node lines.js 1000000 | { node -e \"process.stdin.once('data', (d) => { console.log(d.length); process.exit(0) })\"; node count.js; }",
    ).split("\n"),
  );
}

async function main() {
  // A yes-style writer into head: the writer ends once head has gone.
  console.log(
    "yes | head:",
    JSON.stringify(execSync("node yes.js | head -1", { encoding: "utf8" })),
  );
  console.log(
    "builtin loop | head:",
    JSON.stringify(execSync("while :; do echo y; done | head -2", { encoding: "utf8" })),
  );
  // Blocking writes of large buffers, to a reader that reads all along.
  const sync = spawnSync(
    "node",
    [
      "-e",
      "const n = require('fs').writeSync(1, Buffer.alloc(3 * 1048576, 97)); require('fs').writeSync(2, 'returned ' + n)",
    ],
    { maxBuffer: 10 * MB },
  );
  console.log("sync write:", sync.stdout.length, String(sync.stderr), sync.status);
  const big = execSync(`node -e "process.stdout.write('x'.repeat(5e6))" | wc -c`, {
    encoding: "utf8",
  });
  console.log("stdout.write 5e6 | wc -c:", big.trim());
  const captured = execSync("node writer.js 3000000", { maxBuffer: 10 * MB, stdio: "pipe" });
  console.log("execSync captured", captured.length, digest(captured));
  const echoed = spawnSync("node", ["-e", "process.stdin.pipe(process.stdout)"], {
    input: Buffer.alloc(2 * MB, 98),
    maxBuffer: 10 * MB,
  });
  console.log("spawnSync input and output", echoed.stdout.length, digest(echoed.stdout));
  const collected = await new Promise((resolve) =>
    exec("node writer.js 500000", { encoding: "buffer" }, (error, stdout, stderr) =>
      resolve([error, stdout.length, digest(stdout), String(stderr).trim()]),
    ),
  );
  console.log("exec collected", ...collected);
  await readsLate();
  await pausesAndResumes();
  await neverReads();
  await readsAfterExit();
  await stdinBothWays();
  readersInTurn();
}

main();
