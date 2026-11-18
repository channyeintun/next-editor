// 'exit' listeners when an error ends a thread or the process. A thread that
// an uncaught error ends runs its own 'exit' listeners first, with code 1
// (a listener's throw stops the listeners after it and changes nothing; a
// listener's process.exit(n) ends the thread with n and sends no error),
// then the error reaches the parent. An 'uncaughtException' listener that
// throws runs none. A Worker 'error' event nobody listens for ends the
// process: the main thread's 'exit' listeners run first, with code 1.
const { Worker } = require("worker_threads");
const { spawnSync } = require("child_process");
const fs = require("fs");

// The thread's listeners write what they saw to this file as they run: what
// it holds when the parent's 'error' event comes is what ran before the error
// was sent. (A message on parentPort and the error travel on different ports
// in Node, so their order is not fixed.)
const SAID = "said.txt";
const said = () => (fs.existsSync(SAID) ? fs.readFileSync(SAID, "utf8") : "-");

function run(label, source) {
  return new Promise((resolve) => {
    fs.rmSync(SAID, { force: true });
    const worker = new Worker(source, { eval: true });
    const lines = [];
    worker.on("error", (e) =>
      lines.push(`error ${e.constructor.name} ${e.message} after "${said()}"`),
    );
    worker.on("exit", (code) => {
      lines.push(`exit ${code} after "${said()}"`);
      fs.rmSync(SAID, { force: true });
      console.log(`${label}: ${lines.join(" | ")}`);
      resolve();
    });
  });
}

// What a thread's 'exit' listener saw.
const say = `const say = (m) => require("fs").appendFileSync(${JSON.stringify(SAID)}, m + ";");`;

(async () => {
  await run(
    "from a timer",
    `${say} process.on("exit", (c) => say("exit listener " + c + " " + process.exitCode)); setTimeout(() => { throw new Error("t"); }, 1);`,
  );
  await run(
    "from the script, with an exit code set",
    `${say} process.exitCode = 4; process.on("exit", (c) => say("exit listener " + c + " " + process.exitCode)); throw new Error("s");`,
  );
  await run(
    "from a rejection",
    `${say} process.on("exit", (c) => say("exit listener " + c)); Promise.reject(new Error("r"));`,
  );
  await run(
    "a listener that throws",
    `${say} process.on("exit", (c) => { say("first " + c); throw new Error("from the listener"); }); process.on("exit", () => say("second")); throw new Error("original");`,
  );
  await run(
    "a listener that calls process.exit",
    `${say} process.on("exit", (c) => { say("first " + c); process.exit(6); }); process.on("exit", () => say("second")); throw new Error("original");`,
  );
  await run(
    "an 'uncaughtException' listener that throws",
    `${say} process.on("exit", () => say("not run")); process.on("uncaughtException", () => { throw new Error("listener threw"); }); throw new Error("original");`,
  );

  // The main thread, in a process of its own: its 'exit' listener writes to
  // stderr, so the order against the error report shows.
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const { Worker } = require("worker_threads");
       new Worker("setTimeout(() => { throw new Error('unheard'); }, 1);", { eval: true });
       process.on("exit", (c) => console.error("main exit", c));`,
    ],
    { encoding: "utf8" },
  );
  const told = child.stderr.split("\n").filter((line) => /^(main exit|Error:)/.test(line));
  console.log("an 'error' event nobody listens for:", told.join(" | "), "| status", child.status);
})();
