// How a process ends on an error nothing caught: the 'exit' listeners run
// before the error is printed, and an 'uncaughtException' listener that
// throws ends it with code 7, without them.
"use strict";
const { spawnSync } = require("child_process");

const programs = {
  fatal: () => {
    process.on("exit", (code) => process.stderr.write(`exit listener ${code}\n`));
    process.nextTick(() => process.stderr.write("tick\n"));
    setTimeout(() => {
      throw new Error("fatal one");
    }, 1);
  },
  "listener throws": () => {
    process.on("uncaughtException", (error) => {
      process.stderr.write(`uncaughtException ${error.message}\n`);
      throw new Error("handler threw");
    });
    process.on("exit", (code) => process.stderr.write(`exit listener ${code}\n`));
    setTimeout(() => process.stderr.write("timer never\n"), 50);
    process.nextTick(() => {
      throw new Error("first");
    });
  },
  "rejection in a listener of 'beforeExit'": () => {
    process.on("beforeExit", async () => {
      process.stderr.write("beforeExit\n");
      throw new Error("cleanup failed");
    });
    process.on("exit", (code) => process.stderr.write(`exit listener ${code}\n`));
  },
};

if (process.argv[2] !== undefined) {
  programs[process.argv[2]]();
  return;
}
for (const name of Object.keys(programs)) {
  const child = spawnSync(process.execPath, [__filename, name], { encoding: "utf8" });
  // The lines the program wrote and the first line of each error: a report's stack names files.
  const lines = child.stderr
    .split("\n")
    .filter((line) =>
      /^(tick|timer|exit listener|beforeExit|uncaughtException|Error: )/.test(line),
    );
  console.log(`${name}: status ${child.status}`);
  console.log(lines.map((line) => `  ${line}`).join("\n"));
}
