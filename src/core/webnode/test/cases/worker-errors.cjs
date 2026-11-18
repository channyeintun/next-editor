// What a thread's uncaught error brings to its parent's 'error' event (also
// the error an 'uncaughtException' listener throws), and a thread's own messages to its parent (online, exit) past a spy on
// MessagePort.prototype.postMessage that does not call through.
const { Worker } = require("worker_threads");

function run(label, source) {
  return new Promise((resolve) => {
    const started = Date.now();
    const worker = new Worker(source, { eval: true });
    const lines = [];
    worker.on("online", () => lines.push("online"));
    worker.on("error", (e) =>
      lines.push(
        e instanceof Error
          ? `error ${e.constructor.name} ${e.name}: ${e.message} code=${e.code} errno=${e.errno} syscall=${e.syscall} extra=${JSON.stringify(e.extra)} fn=${typeof e.fn} keys=${Object.keys(e).sort()}`
          : `error ${JSON.stringify(e)}`,
      ),
    );
    worker.on("exit", (code) => {
      lines.push(`exit ${code}`, `promptly ${Date.now() - started < 700}`);
      console.log(`${label}: ${lines.join(" | ")}`);
      resolve();
    });
  });
}

(async () => {
  await run(
    "code and data",
    `const e = new Error("boom"); e.code = "E_X"; e.extra = { a: [1, 2] }; throw e;`,
  );
  await run("a system error", `require("fs").readFileSync("/no/such/file");`);
  await run("a TypeError", `null.x;`);
  await run(
    "a class of the program's own",
    `class Mine extends TypeError { constructor(m) { super(m); this.name = "Mine"; this.code = "C"; } } throw new Mine("m");`,
  );
  await run(
    "a property that cannot be cloned",
    `const e = new RangeError("r"); e.code = "E_R"; e.fn = () => 1; throw e;`,
  );
  await run("not an error", `throw { code: "plain", n: 1 };`);
  await run(
    "a listener that throws, from a timer",
    `process.on("exit", () => console.log("not run")); process.on("uncaughtException", () => { throw new Error("listener threw"); }); setTimeout(() => { throw new Error("first"); }, 1);`,
  );
  await run(
    "a listener that throws, from the script",
    `process.on("uncaughtException", () => { throw new TypeError("sync listener threw"); }); throw new Error("first");`,
  );
  await run(
    "a listener that throws, from a rejection",
    `process.on("uncaughtException", (e, origin) => { throw new RangeError("from " + origin); }); Promise.reject(new Error("r"));`,
  );
  await run(
    "a spy on postMessage",
    `MessagePort.prototype.postMessage = function () {}; setTimeout(() => {}, 20);`,
  );
  await run(
    "an error under the spy",
    `MessagePort.prototype.postMessage = function () {}; throw new Error("seen");`,
  );
})();
