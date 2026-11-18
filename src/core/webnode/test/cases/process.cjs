const path = require("path");
const os = require("os");
const fs = require("fs");
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
// Without a parent that gave it a channel a process has no send, disconnect,
// connected or channel: `if (process.send)` is how a program tells.
console.log(typeof process.send, process.connected, typeof process.disconnect, process.channel);
if (process.send) {
  process.send("ready");
}
// One user everywhere: the process, os.userInfo() and the files it makes.
fs.writeFileSync("mine", "");
console.log(
  os.userInfo().uid === process.getuid(),
  os.userInfo().gid === process.getgid(),
  fs.statSync("mine").uid === process.getuid(),
  process.geteuid() === process.getuid(),
);
fs.unlinkSync("mine");
// chdir: an empty path names nothing; through a link the process is in the
// directory itself, and env.PWD is left alone.
const home = process.cwd();
const pwd = process.env.PWD;
const failure = (action) => {
  try {
    action();
    return "returned";
  } catch (error) {
    return `${error.code} ${error.syscall} ${String(error.message).replace(home, "<cwd>")}`;
  }
};
console.log(failure(() => process.chdir("")));
console.log(failure(() => process.chdir(5)));
fs.mkdirSync("d/sub", { recursive: true });
fs.symlinkSync("d/sub", "link");
process.chdir("link");
console.log(path.relative(home, process.cwd()), process.env.PWD === pwd);
process.chdir(home);
fs.rmSync("link");
fs.rmSync("d", { recursive: true });
// kill: Node's error for a process that is not there, and a signal listened
// for under its other name (SIGIOT is SIGABRT).
console.log(
  failure(() => process.kill(999999)),
  failure(() => process.kill("x")).split(" ")[0],
);
// The signal arrives from the event loop: the timer keeps the process there for it.
const waiting = setTimeout(() => console.log("no SIGIOT arrived"), 2000);
process.on("SIGIOT", function listener(signal, number) {
  console.log("SIGIOT listener got", signal, number);
  process.removeListener("SIGIOT", listener);
  clearTimeout(waiting);
});
process.kill(process.pid, "SIGIOT");
process.env.MY_VAR = 5;
console.log(process.env.MY_VAR, typeof process.env.MY_VAR, "MY_VAR" in process.env);
process.on("exit", (code) => console.log("exit event", code));
process.exitCode = 4;
