// The coded errors of the stream builtin have Node's shape: a plain Error
// (TypeError for an argument) with an own `code`, printed, inspected and
// reported uncaught as `Error [CODE]: message`.
const { Readable, Writable, finished } = require("stream");
const { spawnSync } = require("child_process");
const util = require("util");

const writable = () => new Writable({ write: (_chunk, _encoding, callback) => callback() });

function show(label, error) {
  const own = Object.getOwnPropertyNames(error)
    .filter((key) => key !== "stack")
    .sort();
  console.log(
    label,
    error instanceof Error,
    error.name,
    error.code,
    error.constructor.name,
    own,
    Object.keys(error),
  );
  // The argument error's message names the chunk types its library accepts.
  const text = (line) => (error.code === "ERR_INVALID_ARG_TYPE" ? line.split(":")[0] : line);
  console.log("  string:", text(String(error)));
  console.log("  stack:", text(String(error.stack).split("\n")[0]));
  console.log(
    "  inspect:",
    text(util.inspect(error).split("\n")[0]),
    util.inspect(error).includes(`code: '${error.code}'`),
  );
}

const cases = [
  [
    "write after end",
    (done) => {
      const w = writable();
      w.on("error", done);
      w.end();
      w.write("x");
    },
  ],
  [
    "premature close",
    (done) => {
      const r = new Readable({ read() {} });
      finished(r, done);
      r.destroy();
    },
  ],
  [
    "push after EOF",
    (done) => {
      const r = new Readable({ read() {} });
      r.on("error", done);
      r.push(null);
      r.push("x");
    },
  ],
  [
    "not implemented",
    (done) => {
      const r = new Readable();
      r.on("error", done);
      r.read();
    },
  ],
  [
    "destroyed",
    (done) => {
      const w = writable();
      w.destroy();
      w.write("x", done);
    },
  ],
  [
    "multiple callback",
    (done) => {
      const w = new Writable({
        write(_c, _e, cb) {
          cb();
          cb();
        },
      });
      w.on("error", done);
      w.write("x");
    },
  ],
  [
    "invalid chunk",
    (done) => {
      try {
        writable().write(42);
      } catch (error) {
        done(error);
      }
    },
  ],
];

(async () => {
  for (const [label, start] of cases) {
    show(label, await new Promise((resolve) => start(resolve)));
  }
  const child = spawnSync(
    "node",
    [
      "-e",
      "const w = new (require('stream').Writable)({ write: (c, e, cb) => cb() }); w.end(); w.write('y')",
    ],
    { encoding: "utf8" },
  );
  console.log(
    "uncaught:",
    child.status,
    child.stderr.split("\n").filter((line) => /^\w*Error/.test(line)),
  );
})();
