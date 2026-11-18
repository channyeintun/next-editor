// A child that cannot start: as in Node, it still has the stdio streams it
// was asked for and the methods every child has. The streams carry nothing:
// the output streams end and close, a write to stdin fails without an 'error'
// event, and the child's 'close' comes once the output streams have closed.
// Each stream's own events are printed in order (Node interleaves different
// streams' events by when libuv closes their handles, which nothing should
// rely on).
"use strict";
const { spawn, execFile } = require("child_process");

const MISSING = "definitely-not-a-command-xyz";
const shape = (child) =>
  child.stdio.map((stream) => (stream === null ? "null" : "stream")).join(",");

/**
 * Spawns MISSING with `stdio`, runs `use` on it, and reports what each stream
 * saw. After 'close' it writes to stdin once more, unless `use` ended stdin:
 * Node's stdin is a net.Socket, whose late write after end() fails as
 * destroyed, where a plain Writable's (webnode's) fails as written after end.
 */
function attempt(label, stdio, use = () => {}, { lateWrite = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(MISSING, [], stdio === undefined ? undefined : { stdio });
    const seen = { child: [], stdin: [], stdout: [], stderr: [] };
    const order = [];
    for (const name of ["stdin", "stdout", "stderr"]) {
      const stream = child[name];
      if (stream) {
        for (const event of ["end", "close", "error"]) {
          stream.on(event, (error) => {
            seen[name].push(error && error.code ? `${event} ${error.code}` : event);
            order.push(`${name} ${event}`);
          });
        }
      }
    }
    // stdin goes before 'error' is emitted.
    child.on("error", (error) =>
      seen.child.push(
        `error ${error.code} ${error.syscall}` +
          (child.stdin ? ` (stdin destroyed: ${child.stdin.destroyed})` : ""),
      ),
    );
    child.on("exit", (code, signal) => seen.child.push(`exit ${code} ${signal}`));
    const notes = [`pid ${child.pid}`, `stdio ${shape(child)}`];
    use(child, notes);
    child.on("close", (code, signal) => {
      seen.child.push(`close ${code} ${signal}`);
      const ends = order.filter((event) => /^std(out|err) end$/.test(event)).length;
      notes.push(`output streams ended before 'close': ${ends}`);
      if (child.stdout) {
        notes.push(`stdout readable ${child.stdout.readable}`);
      }
      if (child.stdin) {
        notes.push(`stdin writable ${child.stdin.writable}`);
        if (lateWrite) {
          child.stdin.write("late", (error) => notes.push(`late write: ${error && error.code}`));
        }
      }
      setTimeout(() => {
        console.log(`${label}: ${notes.join("; ")}`);
        for (const [name, events] of Object.entries(seen)) {
          if (name === "child" || child[name]) {
            console.log(`  ${name}: ${events.join(", ")}`);
          }
        }
        resolve();
      }, 50);
    });
  });
}

async function main() {
  await attempt("default stdio", undefined, (child) =>
    child.stdout.on("data", (chunk) => console.log("unexpected data", String(chunk))),
  );
  // What a tool does with the child before it hears of the failure: execa
  // binds child.kill, `open` calls child.unref().
  await attempt("its methods", "ignore", (child, notes) => {
    const names = ["kill", "ref", "unref", "send", "disconnect"];
    notes.push(names.map((name) => `${name} ${typeof child[name]}`).join(", "));
    notes.push(`kill() ${child.kill()}`, `ref() ${child.ref()}`, `unref() ${child.unref()}`);
    notes.push(`killed ${child.killed}`, `connected ${child.connected}`);
  });
  // Whether this write fails is a race in Node itself (EPIPE, or no error
  // when the write got in before the pipe's other end was closed), so only
  // its callback and the stream's events are shown.
  await attempt("a write to stdin", undefined, (child, notes) =>
    child.stdin.write("x", () => notes.push("write called back")),
  );
  await attempt("stdin ended", undefined, (child) => child.stdin.end("x"), { lateWrite: false });
  await attempt("only stdout piped", ["ignore", "pipe", "ignore"]);
  await attempt("only stdin piped", ["pipe", "ignore", "ignore"]);
  await attempt("a fourth pipe", ["pipe", "pipe", "pipe", "pipe"]);
  await attempt("stdout read with for await", undefined, (child, notes) => {
    (async () => {
      let chunks = 0;
      for await (const chunk of child.stdout) {
        void chunk;
        chunks++;
      }
      notes.push(`for await ended with ${chunks} chunks`);
    })();
  });
  await new Promise((resolve) =>
    execFile(MISSING, (error, stdout, stderr) => {
      console.log("execFile:", error.code, JSON.stringify(stdout), JSON.stringify(stderr));
      resolve();
    }),
  );
}

main();
