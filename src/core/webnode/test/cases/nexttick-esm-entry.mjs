// An ES module entry runs in a promise job, so its ticks run after the
// promise jobs it queued; a tick a CommonJS preload queued runs first.
process.nextTick(() => console.log("t"));
Promise.resolve().then(() => console.log("p"));
queueMicrotask(() => console.log("q"));
console.log("sync");
