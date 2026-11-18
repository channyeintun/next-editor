// 'beforeExit': the ticks and promise jobs of its listeners run before the
// process decides; it is emitted again once work a listener started has
// finished; and when a listener leaves nothing that holds the process, the
// process ends without running what does not hold it.
"use strict";
const { MessageChannel } = require("worker_threads");
const { port1, port2 } = new MessageChannel();
port1.on("message", (message) => console.log("  message on an unref'd port", message));
port1.unref();
let emitted = 0;
process.on("unhandledRejection", (error) => console.log("  unhandled:", error.message));
process.on("beforeExit", async (code) => {
  emitted += 1;
  console.log("beforeExit", emitted, code);
  process.nextTick(() => console.log("  tick", emitted));
  Promise.resolve().then(() => {
    console.log("  promise", emitted);
    process.nextTick(() => console.log("  promise>tick", emitted));
  });
  if (emitted === 1) setTimeout(() => console.log("  timer"), 5);
  if (emitted === 2) setImmediate(() => console.log("  immediate"));
  if (emitted === 3) require("fs").stat(__filename, () => console.log("  stat"));
  if (emitted === 4) {
    // Nothing here holds the process: Node runs none of it, reports the
    // rejection, and exits without another 'beforeExit'.
    setImmediate(() => console.log("  unref'd immediate")).unref();
    setTimeout(() => console.log("  unref'd timer"), 0).unref();
    clearTimeout(setTimeout(() => console.log("  cleared timer"), 1000));
    port2.postMessage(emitted);
    throw new Error("cleanup failed");
  }
  if (emitted > 8) process.exit(9);
});
process.on("exit", (code) => console.log("exit", code));
