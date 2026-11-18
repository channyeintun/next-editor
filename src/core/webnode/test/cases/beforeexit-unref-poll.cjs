// A process whose only work does not hold it (an unref'd immediate that
// queues itself again, an unref'd interval) exits at once, after one
// 'beforeExit'.
"use strict";
let emitted = 0;
setInterval(() => {}, 1).unref();
(function poll() {
  setImmediate(poll).unref();
})();
process.on("beforeExit", () => {
  emitted += 1;
});
process.on("exit", (code) => console.log("exit", code, "beforeExit x" + emitted));
setTimeout(() => {
  console.log("still alive after 2s: beforeExit x" + emitted);
  process.exit(8);
}, 2000).unref();
