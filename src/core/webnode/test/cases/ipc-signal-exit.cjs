// The messages a forked child sent before a signal ended it come before
// 'disconnect' and 'exit', as in Node: a child that kills itself right after
// it sends, and a child its parent kills while the messages of a burst are
// still on their way.
"use strict";
const { fork } = require("child_process");
const fs = require("fs");

fs.writeFileSync(
  "suicide.cjs",
  'process.send("first"); process.send("last"); process.kill(process.pid, process.argv[2]);',
);
fs.writeFileSync(
  "burst.cjs",
  "for (let i = 0; i < 50; i++) process.send(i); setInterval(() => {}, 1000);",
);

function watch(child, label) {
  return new Promise((resolve) => {
    const log = [];
    let messages = 0;
    child.on("message", (message) => {
      messages += 1;
      if (typeof message === "string") log.push(`message ${message}`);
    });
    child.on("disconnect", () => log.push(`disconnect after ${messages}`));
    child.on("exit", (code, signal) => log.push(`exit ${code} ${signal} after ${messages}`));
    child.on("close", () => {
      console.log(`${label}: ${log.join(" | ")}`);
      resolve();
    });
  });
}

(async () => {
  for (const signal of ["SIGKILL", "SIGTERM"]) {
    await watch(fork("suicide.cjs", [signal]), `kills itself with ${signal}`);
  }
  {
    const child = fork("burst.cjs");
    child.once("message", () => child.kill("SIGTERM"));
    await watch(child, "killed by its parent at the first message of a burst");
  }
  {
    const child = fork("burst.cjs");
    child.once("message", () => setTimeout(() => child.kill("SIGKILL"), 30));
    await watch(child, "killed by its parent after a burst");
  }
})();
