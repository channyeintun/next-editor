// Rejections nobody handled: the ones of one macrotask are reported together
// (every 'unhandledRejection' listener, then their ticks, then their promise
// jobs), one handled later gets 'rejectionHandled', and the
// --unhandled-rejections modes decide what a report does.
"use strict";
const { spawnSync } = require("child_process");

if (process.argv[2] === "mode") {
  process.on("exit", (code) => console.log("  exit", code));
  process.on("warning", (warning) =>
    console.log("  warning", warning.name, warning.message.split("\n")[0].slice(0, 50)),
  );
  if (process.argv[3] === "listen") {
    process.on("unhandledRejection", (reason) =>
      console.log("  unhandledRejection", reason.message),
    );
  }
  if (process.argv[4] === "catch") {
    process.on("uncaughtException", (error, origin) =>
      console.log("  uncaughtException", error.message, origin),
    );
  }
  Promise.reject(new Error("unhandled one"));
  setTimeout(() => console.log("  timer ran"), 10);
  return;
}

const order = [];
process.on("unhandledRejection", (reason) => {
  order.push(`UR:${reason.message}`);
  process.nextTick(() => order.push(`UR>tick:${reason.message}`));
  Promise.resolve().then(() => order.push(`UR>promise:${reason.message}`));
});
process.on("rejectionHandled", () => order.push("RH"));
Promise.reject(new Error("r1"));
const late = Promise.reject(new Error("r2"));
process.nextTick(() => Promise.reject(new Error("r3")));
Promise.reject(new Error("handled in a promise job")).catch(() => order.push("caught"));
setTimeout(() => {
  late.catch(() => order.push("r2 caught late"));
  setTimeout(() => {
    console.log(order.join(" "));
    for (const mode of ["throw", "strict", "warn", "none", "warn-with-error-code", "loud"]) {
      for (const listeners of [[], ["listen"], ["quiet", "catch"], ["listen", "catch"]]) {
        const child = spawnSync(
          process.execPath,
          [`--unhandled-rejections=${mode}`, __filename, "mode", ...listeners],
          { encoding: "utf8" },
        );
        // Only the lines the program printed: the fatal report has a stack.
        const lines = child.stdout.split("\n").filter((line) => line.startsWith("  "));
        const invalid = /invalid value for --unhandled-rejections/.test(child.stderr);
        console.log(
          `${mode} [${listeners.join(" ")}] status ${child.status}${invalid ? " invalid value" : ""}`,
        );
        console.log(lines.join("\n"));
      }
    }
  }, 20);
}, 20);
