const { Worker, isMainThread, parentPort, workerData, threadId } = require("worker_threads");
if (isMainThread) {
  const worker = new Worker(__filename, { workerData: { base: 10 } });
  worker.on("message", (message) => {
    console.log("from worker", message);
    if (message.done) worker.postMessage("stop");
  });
  worker.on("exit", (code) => console.log("worker exit", code, threadId));
  worker.postMessage({ add: 5 });
} else {
  parentPort.on("message", (message) => {
    if (message === "stop") {
      process.exit(0);
    }
    parentPort.postMessage({ sum: workerData.base + message.add, done: true, main: isMainThread });
  });
}
