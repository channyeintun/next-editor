const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
  threadId,
  getEnvironmentData,
  setEnvironmentData,
} = require("worker_threads");
if (isMainThread) {
  console.log("main workerData", workerData);
  setEnvironmentData("shared", { from: "main" });
  const worker = new Worker(__filename, { workerData: { base: 10 } });
  worker.on("message", (message) => {
    console.log("from worker", message);
    if (message.done) worker.postMessage("stop");
  });
  worker.on("exit", (code) => {
    console.log("worker exit", code, threadId);
    // No workerData: the thread sees undefined, where the main thread sees null.
    const plain = new Worker(
      `const { parentPort, workerData, getEnvironmentData } = require("worker_threads");
       parentPort.postMessage([typeof workerData, getEnvironmentData("shared"), getEnvironmentData("late")]);`,
      { eval: true },
    );
    setEnvironmentData("late", "set after the thread started");
    plain.on("message", (message) => console.log("a thread without workerData", message));
  });
  worker.postMessage({ add: 5 });
} else {
  parentPort.on("message", (message) => {
    if (message === "stop") {
      process.exit(0);
    }
    parentPort.postMessage({
      sum: workerData.base + message.add,
      done: true,
      main: isMainThread,
      environment: getEnvironmentData("shared"),
    });
  });
}
