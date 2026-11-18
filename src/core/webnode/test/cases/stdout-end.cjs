// process.stdout.end() (or stderr's) on a pipe shuts the pipe down, as libuv
// does for Node: 'finish' and 'close' come at once, and a later write fails
// with EPIPE (errno -32, syscall write), reaching nobody; uncaught, it ends
// the process with code 1.
// destroy() changes nothing: later writes still reach the reader. A file
// stays writable after end().
const { spawn } = require("child_process");
const fs = require("fs");

fs.writeFileSync(
  "ender.cjs",
  `const fs = require("fs");
const [which, how, listen] = process.argv.slice(2);
const stream = process[which];
const note = (text) => fs.writeSync(which === "stdout" ? 2 : 1, "w: " + text + "\\n");
if (listen === "listen") stream.on("error", (e) => note("error " + e.message + " " + e.code + " " + e.errno + " " + e.syscall));
stream.on("finish", () => note("finish"));
stream.on("close", () => note("close"));
stream.write("before\\n");
if (how === "destroy") stream.destroy();
else stream.end(() => note("end callback"));
setTimeout(() => {
  note("probe");
  setTimeout(() => {
    const returned = stream.write("x\\n", (e) => note("write callback " + (e ? e.code : "ok")));
    note("write returned " + returned);
  }, 20);
}, 20);
setTimeout(() => note("still alive"), 100);
process.on("exit", (code) => note("exit " + code));
`,
);

function run(which, how, listen) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["ender.cjs", which, how, listen], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const read = child[which];
    const notes = which === "stdout" ? child.stderr : child.stdout;
    let data = "";
    const lines = [];
    let pending = "";
    read.on("data", (chunk) => (data += chunk));
    notes.on("data", (chunk) => {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop();
      for (const line of parts) {
        if (line.startsWith("w: ") && line !== "w: probe") lines.push(line.slice(3));
      }
    });
    child.on("close", (code) => {
      console.log(
        `${which} ${how} ${listen}: ${lines.join(" | ")} | reader got ${JSON.stringify(data)} | status ${code}`,
      );
      resolve();
    });
  });
}

(async () => {
  await run("stdout", "end", "listen");
  await run("stdout", "end", "uncaught");
  await run("stderr", "end", "listen");
  await run("stdout", "destroy", "listen");
  // A file: end() does not stop the writes.
  fs.writeFileSync(
    "file-ender.cjs",
    `const fs = require("fs");
process.stdout.end("one\\n");
setTimeout(() => process.stdout.write("two\\n", (e) => fs.writeSync(2, "callback " + (e ? e.code : "ok") + "\\n")), 20);
`,
  );
  const fd = fs.openSync("file.txt", "w");
  const child = spawn(process.execPath, ["file-ender.cjs"], { stdio: ["ignore", fd, "pipe"] });
  let notes = "";
  child.stderr.on("data", (chunk) => (notes += chunk));
  child.on("close", (code) => {
    fs.closeSync(fd);
    console.log(
      `file: ${notes.trim()} | ${JSON.stringify(fs.readFileSync("file.txt", "utf8"))} | status ${code}`,
    );
  });
})();
