// A port that posts and then closes, from an immediate (outside a delivery of
// its own): as in Node, its 'close' comes first, then the other end gets what
// was posted, then the other end's 'close'. The caller's ticks and promise
// jobs come before either.
"use strict";
const { MessageChannel } = require("worker_threads");

const run = (label, body) =>
  new Promise((resolve) => {
    const log = [];
    const { port1, port2 } = new MessageChannel();
    port1.on("message", (m) => log.push(`p1:${m}`));
    port1.on("close", () => {
      log.push("p1 close");
      setTimeout(() => {
        console.log(`${label}: ${log.join(" ")}`);
        resolve();
      }, 20);
    });
    port2.on("close", () => log.push("p2 close"));
    body(port1, port2, log);
  });

(async () => {
  await run("both ends listen", (port1, port2, log) => {
    port2.on("message", (m) => log.push(`p2:${m}`));
    setImmediate(() => {
      port2.postMessage("d");
      port2.close();
    });
  });
  await run("the closing end only has 'close'", (port1, port2) => {
    setImmediate(() => {
      port2.postMessage("d");
      port2.postMessage("e");
      port2.close();
    });
  });
  await run("ticks and promise jobs of the caller", (port1, port2, log) => {
    setImmediate(() => {
      port2.postMessage("d");
      port2.close();
      process.nextTick(() => log.push("tick"));
      Promise.resolve().then(() => log.push("promise"));
    });
  });
})();
