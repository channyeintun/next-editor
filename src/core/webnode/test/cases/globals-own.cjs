// Globals a browser worker has and Node does not are not there at all; the
// ones Node owns are the global object's own, shaped as Node's, and deleting
// one leaves nothing behind. A port's 'close' event has Node's class.
"use strict";
const { MessageChannel } = require("worker_threads");

for (const name of ["requestAnimationFrame", "cancelAnimationFrame", "importScripts", "self"]) {
  console.log(name, name in globalThis, typeof globalThis[name]);
}
const own = Object.getOwnPropertyDescriptor(globalThis, "crypto");
console.log(
  "crypto",
  Object.keys(own).join(","),
  typeof own.get,
  typeof own.set,
  own.enumerable,
  own.configurable,
  globalThis.crypto === own.get.call(globalThis),
  typeof globalThis.crypto.getRandomValues,
);
const clone = structuredClone;
delete globalThis.structuredClone;
console.log(
  "structuredClone after delete",
  typeof structuredClone,
  "structuredClone" in globalThis,
);
globalThis.structuredClone = clone;
delete globalThis.crypto;
console.log("crypto after delete", typeof crypto, "crypto" in globalThis);

const { port1, port2 } = new MessageChannel();
port1.addEventListener("close", (event) => {
  console.log("close event", event.constructor.name, event instanceof Event, event.type);
});
port1.start();
port2.close();
setTimeout(() => {}, 50);
