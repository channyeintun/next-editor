// A port that holds messages in JS for its next listener (one with only a
// 'close' listener, one whose last 'message' listener was removed, one whose
// once listener has had its message) is transferred, every way there is: with
// a port's postMessage, structuredClone, Worker.postMessage, workerData, and
// from a thread to its parent. As in Node, the receiving side gets what the
// port held first, in order, and then what was posted after the transfer.
"use strict";
const { MessageChannel, Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hold(port, mode, log) {
  if (mode === "close-only") port.on("close", () => {});
  if (mode === "off") {
    const f = () => {};
    port.on("message", f);
    port.off("message", f);
  }
  if (mode === "once") port.once("message", (m) => log.push("once:" + m));
}

function listen(port, done, log) {
  port.on("message", (m) => {
    log.push(m);
    if (m === 3) {
      port.close();
      done();
    }
  });
}

if (!isMainThread) {
  const log = [];
  const report = () => parentPort.postMessage(log.join(" "));
  if (workerData && workerData.port) listen(workerData.port, report, log);
  parentPort.on("message", async (msg) => {
    if (msg.port) listen(msg.port, report, log);
    if (msg.back) {
      const { port1, port2 } = new MessageChannel();
      hold(port1, msg.back, log);
      port2.postMessage(1);
      port2.postMessage(2);
      await pause(50);
      parentPort.postMessage({ port: port1, log: log.slice() }, [port1]);
      port2.postMessage(3);
      port2.close();
    }
    if (msg.done) parentPort.close();
  });
} else {
  (async () => {
    for (const mode of ["close-only", "off", "once"]) {
      for (const way of [
        "port",
        "structuredClone",
        "Worker.postMessage",
        "workerData",
        "from the thread",
      ]) {
        const log = [];
        const finished = new Promise((resolve) => {
          if (way === "from the thread") {
            const worker = new Worker(__filename);
            worker.on("message", (msg) => {
              log.push(...msg.log);
              listen(
                msg.port,
                () => {
                  worker.postMessage({ done: true });
                },
                log,
              );
            });
            worker.on("exit", resolve);
            worker.postMessage({ back: mode });
            return;
          }
          const { port1, port2 } = new MessageChannel();
          hold(port1, mode, log);
          port2.postMessage(1);
          port2.postMessage(2);
          pause(50).then(() => {
            if (way === "port") {
              const other = new MessageChannel();
              other.port2.once("message", (p) => {
                listen(
                  p,
                  () => {
                    other.port2.close();
                    resolve();
                  },
                  log,
                );
              });
              other.port1.postMessage(port1, [port1]);
            } else if (way === "structuredClone") {
              const moved = structuredClone({ port1 }, { transfer: [port1] }).port1;
              listen(moved, resolve, log);
            } else {
              const options =
                way === "workerData" ? { workerData: { port: port1 }, transferList: [port1] } : {};
              const worker = new Worker(__filename, options);
              worker.on("message", (m) => {
                log.push("thread:" + m);
                worker.postMessage({ done: true });
              });
              worker.on("exit", resolve);
              if (way === "Worker.postMessage") worker.postMessage({ port: port1 }, [port1]);
            }
            port2.postMessage(3);
          });
        });
        await Promise.race([finished, pause(1500).then(() => log.push("timed out"))]);
        console.log(`${mode} ${way}: ${log.join(" ")}`);
      }
    }
    process.exit(0);
  })();
}
