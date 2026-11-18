// A BroadcastChannel a thread opens gets every message posted to its name
// after the thread said so on another port: the main thread posts as soon as
// the thread's 'ready' arrives. Many threads at once, round after round.
const {
  Worker,
  isMainThread,
  BroadcastChannel,
  parentPort,
  workerData,
} = require("worker_threads");

const ROUNDS = 12;
const THREADS = 8;

if (isMainThread) {
  const thread = (name) =>
    new Promise((resolve) => {
      const sender = new BroadcastChannel(name);
      const worker = new Worker(__filename, { workerData: name });
      let got = "";
      worker.on("message", (message) => {
        if (message === "ready") {
          sender.postMessage("m");
        } else {
          got = message;
        }
      });
      worker.on("exit", (code) => {
        sender.close();
        resolve(`exit ${code} ${got}`);
      });
    });
  (async () => {
    const results = new Map();
    for (let round = 0; round < ROUNDS; round += 1) {
      const names = Array.from({ length: THREADS }, (_, index) => `round ${round} thread ${index}`);
      for (const result of await Promise.all(names.map(thread))) {
        results.set(result, (results.get(result) ?? 0) + 1);
      }
    }
    for (const [result, count] of results) {
      console.log(`${count} threads: ${result}`);
    }
  })();
} else {
  const channel = new BroadcastChannel(workerData);
  channel.onmessage = (event) => {
    parentPort.postMessage(`got ${event.data}`);
    channel.close();
  };
  parentPort.postMessage("ready");
  // A channel that missed its message would hold the thread open for ever.
  setTimeout(() => {
    parentPort.postMessage("missed");
    process.exit(4);
  }, 1000).unref();
}
