// A thread started by a thread: the thread that started it hears its
// messages, its exit code and its error, and it ends with that thread
// (process.exit, terminate()). Three levels deep the exits travel up one
// level at a time.
const { Worker } = require("worker_threads");
const fs = require("fs");

// The source of a middle thread that starts `inner` and reports to its parent
// what it hears of it.
const middle = (inner, more = "") =>
  `const { Worker, parentPort } = require("worker_threads");
   const inner = new Worker(${JSON.stringify(inner)}, { eval: true });
   inner.on("message", (m) => parentPort.postMessage("inner said " + m));
   inner.on("exit", (c) => parentPort.postMessage("inner exit " + c));
   ${more}`;

function run(label, source, during) {
  return new Promise((resolve) => {
    const started = Date.now();
    const worker = new Worker(source, { eval: true });
    const lines = [];
    worker.on("message", (m) => {
      lines.push(String(m));
      during?.(worker, m);
    });
    worker.on("error", (e) => lines.push(`error ${e.constructor.name} ${e.message}`));
    worker.on("exit", (code) => {
      lines.push(`exit ${code}`, `promptly ${Date.now() - started < 3000}`);
      console.log(`${label}: ${lines.join(" | ")}`);
      resolve();
    });
  });
}

// Whether the thread that appends to tick.txt stopped: nothing more is
// appended once the thread above it ended.
function tickerStopped() {
  return new Promise((resolve) => {
    const before = fs.readFileSync("tick.txt", "utf8").length;
    setTimeout(() => {
      const after = fs.readFileSync("tick.txt", "utf8").length;
      fs.unlinkSync("tick.txt");
      resolve(after - before <= 1);
    }, 200);
  });
}
const ticker = `require("fs").writeFileSync("tick.txt", ""); setInterval(() => require("fs").appendFileSync("tick.txt", "x"), 10); require("worker_threads").parentPort.postMessage("up");`;

(async () => {
  await run("an exit code", middle(`process.exitCode = 5;`));
  await run(
    "messages",
    middle(
      `const { parentPort } = require("worker_threads"); parentPort.postMessage("a"); parentPort.postMessage("b");`,
    ),
  );
  await run(
    "an error the middle thread listens for",
    middle(
      `throw new TypeError("inner threw");`,
      `inner.on("error", (e) => parentPort.postMessage("inner error " + e.constructor.name + " " + e.message));`,
    ),
  );
  await run(
    "an error nobody in the middle listens for",
    middle(`throw new RangeError("unheard");`),
  );
  await run(
    "an inner 'exit' listener",
    middle(
      `process.on("exit", (c) => require("worker_threads").parentPort.postMessage("own exit " + c)); setTimeout(() => {}, 20);`,
    ),
  );
  await run(
    "the middle thread exits while the inner one runs",
    middle(ticker, `inner.on("message", () => setTimeout(() => process.exit(3), 30));`),
  );
  console.log("inner stopped with it", await tickerStopped());
  await run(
    "the middle thread is terminated while the inner one runs",
    middle(ticker),
    (worker, m) => {
      if (m === "inner said up") {
        setTimeout(
          () => worker.terminate().then((code) => console.log("terminate resolved", code)),
          30,
        );
      }
    },
  );
  console.log("inner stopped with it", await tickerStopped());
  await run(
    "three levels",
    middle(
      middle(`require("worker_threads").parentPort.postMessage("deep"); process.exitCode = 7;`),
    ),
  );
})();
