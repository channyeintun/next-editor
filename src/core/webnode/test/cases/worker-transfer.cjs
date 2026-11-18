// workerData with a transferList: a MessagePort handed to a new thread is the
// thread's from its first line, and a transferred buffer leaves the parent.
const { Worker, MessageChannel } = require("worker_threads");

function run(label, source, workerData, transferList, use) {
  return new Promise((resolve) => {
    const worker = new Worker(source, { eval: true, workerData, transferList });
    const lines = [];
    worker.on("message", (message) => lines.push("message " + JSON.stringify(message)));
    worker.on("error", (error) => lines.push("error " + error.name));
    worker.on("exit", (code) => {
      lines.push("exit " + code);
      setTimeout(() => {
        console.log(`${label}: ${lines.join(" | ")}`);
        resolve();
      }, 30);
    });
    use?.(lines, worker);
  });
}

(async () => {
  {
    const { port1, port2 } = new MessageChannel();
    await run(
      "a port as workerData",
      `const { workerData } = require("worker_threads"); let count = 0;
       workerData.on("message", (m) => { workerData.postMessage("echo " + m); if (++count === 3) workerData.close(); });`,
      port2,
      [port2],
      (lines) => {
        port1.on("message", (message) => lines.push(message));
        port1.on("close", () => lines.push("port closed"));
        for (const value of [1, 2, 3]) port1.postMessage(value);
      },
    );
  }
  {
    const first = new MessageChannel();
    const second = new MessageChannel();
    // Two ports deliver in no fixed order against each other or against the
    // thread's exit: the thread waits until both messages have arrived.
    await run(
      "two ports inside workerData",
      `const { workerData, parentPort } = require("worker_threads");
       workerData.ports[0].postMessage(workerData.label + " one"); workerData.ports[1].postMessage(workerData.label + " two");
       workerData.ports[0].close(); workerData.ports[1].close();
       parentPort.once("message", () => process.exit(0));`,
      { label: "from", ports: [first.port2, second.port2] },
      [first.port2, second.port2],
      (lines, worker) => {
        const got = [];
        const arrived = (message) => {
          got.push(message);
          if (got.length === 2) {
            lines.push(...got.sort());
            worker.postMessage("done");
          }
        };
        first.port1.on("message", arrived);
        second.port1.on("message", arrived);
      },
    );
  }
  {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await run(
      "a transferred buffer",
      `const { workerData, parentPort } = require("worker_threads"); parentPort.postMessage([workerData.byteLength, Array.from(workerData)]);`,
      bytes,
      [bytes.buffer],
      (lines) => lines.push("left in the parent: " + bytes.byteLength),
    );
  }
  try {
    const { port2 } = new MessageChannel();
    new Worker("", { eval: true, workerData: port2 });
  } catch (error) {
    console.log("a port that is not in the transferList:", error.name);
  }
})();
