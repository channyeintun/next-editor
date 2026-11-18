// A Worker's standard streams. With `stdout: true` / `stderr: true` what the
// thread writes arrives in worker.stdout / worker.stderr, all of it before
// 'exit'; with `stdin: true` the parent writes the thread's process.stdin.
const { Worker } = require("worker_threads");

const text = (stream) => {
  let all = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => (all += chunk));
  return () => all;
};

function run(label, source, options = {}) {
  return new Promise((resolve) => {
    const worker = new Worker(source, { eval: true, stdout: true, stderr: true, ...options });
    const out = text(worker.stdout);
    const err = text(worker.stderr);
    const events = [];
    worker.stdout.on("end", () => events.push("stdout end"));
    worker.stderr.on("end", () => events.push("stderr end"));
    worker.on("message", (message) => events.push("message " + JSON.stringify(message)));
    worker.on("error", (error) => events.push("error " + error.message));
    worker.on("exit", (code) => {
      events.push(`exit ${code} out=${JSON.stringify(out())} err=${JSON.stringify(err())}`);
      setTimeout(() => {
        console.log(`${label}: ${events.join(" | ")}`);
        resolve(worker);
      }, 50);
    });
    if (options.stdin) {
      worker.stdin.write("one ");
      setTimeout(() => worker.stdin.end("two"), 30);
    }
  });
}

(async () => {
  const kept = await run(
    "kept",
    `console.log("out line"); console.error("err line"); process.stdout.write("raw");
     require("worker_threads").parentPort.postMessage([process.stdout.isTTY, process.stdout.fd, typeof process.stdout.write]);`,
  );
  console.log("streams:", kept.stdin, typeof kept.stdout.pipe, typeof kept.stderr.pipe);
  await run(
    "writes, then process.exit",
    `for (let i = 0; i < 5; i++) process.stdout.write("w" + i + " "); process.stdout.write("x".repeat(100000).length + ""); process.exit(3);`,
  );
  await run(
    "writes of an 'exit' listener",
    `process.on("exit", () => { process.stdout.write("in exit 1 "); process.stdout.write("in exit 2"); }); process.stdout.write("before ");`,
  );
  await run(
    "an error nothing caught",
    `console.log("a"); setTimeout(() => { throw new Error("late"); }, 10);`,
  );
  await run(
    "the thread ends its stdout",
    `process.stdout.end("bye"); process.stdout.on("finish", () => process.stderr.write("finish"));`,
  );
  await run(
    "a write's callback, with process.nextTick replaced as fake timers replace it",
    `const { parentPort } = require("worker_threads"); const real = process.nextTick; let flushed = 0;
     process.nextTick = () => {};
     for (const stream of [process.stdout, process.stderr]) stream.write("", () => { if (++flushed === 2) parentPort.postMessage("both flushed"); });
     process.stdout.write("text", (error) => parentPort.postMessage("callback " + error));
     process.nextTick = real;`,
  );
  await run(
    "stdin kept",
    `let got = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (got += d));
     process.stdin.on("end", () => console.log("thread read " + JSON.stringify(got)));`,
    { stdin: true },
  );
  await run(
    "stdin not kept",
    `process.stdin.on("data", (d) => console.log("data " + d)); process.stdin.on("end", () => console.log("end at once"));`,
  );
  // A thread that reads a stdin its parent keeps open stays, until the parent ends it.
  await new Promise((resolve) => {
    const worker = new Worker(`process.stdin.on("data", () => {});`, { eval: true, stdin: true });
    let exited = false;
    worker.on("exit", (code) => {
      exited = true;
      console.log("reader of an open stdin: exit", code);
      resolve();
    });
    setTimeout(() => {
      console.log("reader of an open stdin still runs:", !exited);
      worker.stdin.end();
    }, 300);
  });
  // terminate(): what the thread had written is in the stream, which then ends.
  await new Promise((resolve) => {
    const worker = new Worker(`setTimeout(() => {}, 100000); console.log("before terminate");`, {
      eval: true,
      stdout: true,
      stderr: true,
    });
    const out = text(worker.stdout);
    const events = [];
    worker.stdout.on("end", () => events.push("stdout end"));
    worker.stderr.on("end", () => events.push("stderr end"));
    worker.stderr.resume();
    worker.on("exit", (code) => events.push("exit " + code));
    setTimeout(async () => {
      events.push("terminated " + (await worker.terminate()));
      setTimeout(() => {
        console.log(`terminate: ${JSON.stringify(out())} ${events.join(" | ")}`);
        resolve();
      }, 50);
    }, 300);
  });
  // Not kept: the thread's output is the process's, and the Worker's streams end with it.
  await new Promise((resolve) => {
    const worker = new Worker(`console.log("a thread's own line");`, { eval: true });
    worker.stdout.on("end", () => console.log("not kept: stdout end"));
    worker.on("exit", (code) => {
      console.log("not kept: exit", code, worker.stdin, typeof worker.stdout.pipe);
      setTimeout(resolve, 50);
    });
  });
})();
