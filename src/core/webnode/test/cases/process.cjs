const path = require("path");
const os = require("os");
console.log(
  process.argv.length,
  path.basename(process.argv[1]),
  typeof process.pid,
  typeof process.title,
);
console.log(
  typeof process.version,
  process.versions.node.split(".").length,
  typeof process.env.PATH,
  process.cwd() === path.resolve("."),
);
console.log(
  typeof process.hrtime.bigint(),
  process.hrtime().length,
  typeof process.uptime(),
  typeof process.memoryUsage().heapUsed,
);
console.log(
  Object.prototype.toString.call(process),
  typeof process.nextTick,
  typeof process.emitWarning,
  process.exitCode,
);
console.log(
  typeof os.cpus().length,
  typeof os.tmpdir(),
  os.EOL === "\n",
  typeof os.homedir(),
  os.endianness(),
);
console.log(
  typeof globalThis.window,
  typeof globalThis.document,
  typeof globalThis.global,
  typeof Buffer,
  typeof setImmediate,
  typeof fetch,
  typeof structuredClone,
);
process.env.MY_VAR = 5;
console.log(process.env.MY_VAR, typeof process.env.MY_VAR, "MY_VAR" in process.env);
process.on("exit", (code) => console.log("exit event", code));
process.exitCode = 4;
