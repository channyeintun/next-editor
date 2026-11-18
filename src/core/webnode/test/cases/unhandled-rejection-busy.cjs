// A rejection nobody handles, made while the process is busy with macrotasks
// whose promise jobs queue ticks, is reported while it is still busy, not when
// the work is over.
"use strict";
const { MessageChannel } = require("worker_threads");
const { port1, port2 } = new MessageChannel();
const start = Date.now();
let messages = 0;
process.on("unhandledRejection", (reason) => {
  console.log(
    "reported:",
    reason.message,
    Date.now() - start < 1000 ? "while busy" : "after the work",
  );
  port1.close();
});
port1.on("message", () => {
  messages += 1;
  // Two rounds: tick, promise job, tick.
  Promise.resolve().then(() =>
    process.nextTick(() => Promise.resolve().then(() => process.nextTick(() => {}))),
  );
  if (messages === 50) {
    Promise.resolve().then(() =>
      process.nextTick(() => {
        Promise.reject(new Error("boom"));
      }),
    );
  }
  if (Date.now() - start < 2000) {
    port2.postMessage(0);
  } else {
    port1.close();
  }
});
port2.postMessage(0);
port2.postMessage(0);
port2.postMessage(0);
process.on("exit", (code) => console.log("exit", code));
