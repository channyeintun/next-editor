// The main module throws into an 'uncaughtException' listener: the ticks the
// module and the listener queued run before their promise jobs, as after any
// other macrotask.
"use strict";
const log = (line) => console.log(line);
process.on("uncaughtException", (error) => {
  log(`caught ${error.message}`);
  process.nextTick(() => log("caught>t"));
  Promise.resolve().then(() => log("caught>p"));
});
process.nextTick(() => log("t"));
Promise.resolve().then(() => log("p"));
setImmediate(() => log("immediate"));
throw new Error("main");
