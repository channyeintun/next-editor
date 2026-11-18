// A test's spy on MessagePort.prototype.postMessage that does not call
// through takes nothing from the event loop: immediates, fs callbacks and
// ticks still run.
"use strict";
const original = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function () {};
const seen = [];
setImmediate(() => seen.push("immediate"));
require("fs").stat(__filename, () => seen.push("fs.stat"));
Promise.resolve().then(() =>
  process.nextTick(() =>
    Promise.resolve().then(() => process.nextTick(() => seen.push("second-round tick"))),
  ),
);
setTimeout(() => {
  MessagePort.prototype.postMessage = original;
  console.log(seen.sort().join(", "));
}, 50);
