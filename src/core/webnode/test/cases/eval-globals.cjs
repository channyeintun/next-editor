// `node -e` and `node -p`: every builtin module is a global there (the
// one-liners of tutorials rely on it), `crypto` is node:crypto in a script,
// and `node --run` ends as Node's task runner does.
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");

function node(...args) {
  const child = spawnSync(process.execPath, args, {
    encoding: "utf8",
    input: args.includes("-") ? args.pop() : undefined,
  });
  const error = /^\w*Error.*$/m.exec(child.stderr);
  console.log(
    `${JSON.stringify(args.slice(0, 3))} -> ${child.status} ${child.stdout.trim()}${error ? ` [${error[0]}]` : ""}`,
  );
}

node("-p", "crypto.randomBytes(8).toString('hex').length");
node("-e", "console.log(crypto.randomBytes(8).toString('hex').length)");
node("-p", "os.platform().length > 0");
node(
  "-e",
  "fs.writeFileSync('x1','1'); console.log(fs.readFileSync('x1','utf8')); fs.unlinkSync('x1')",
);
node("-p", "path.join('a','b')");
node(
  "-p",
  "[crypto === require('crypto'), globalThis.crypto === require('crypto'), typeof globalThis.crypto.subtle]",
);
node(
  "-e",
  "const crypto = require('crypto'); var os = require('os'); let fs = require('fs'); console.log(typeof crypto.randomBytes, typeof os.platform, typeof fs.readFileSync)",
);
node(
  "-e",
  "util = 1; function path() {} console.log(util, typeof path, Object.keys(globalThis).includes('util'))",
);
node(
  "-p",
  "const d = Object.getOwnPropertyDescriptor(globalThis, 'http'); [typeof d.get, typeof d.set, d.enumerable, d.configurable]",
);
node(
  "-p",
  "[typeof events, typeof stream.Readable, typeof url.URL, typeof zlib.gzipSync, typeof child_process.spawn, typeof module, typeof _http_agent]",
);
node("--input-type=module", "-e", "console.log(typeof os, typeof fs, typeof crypto.randomBytes)");
// -p prints its value once the script's work is done, before the 'exit' listeners.
node(
  "-p",
  "const o = { n: 1 }; process.nextTick(() => console.log('tick')); setTimeout(() => { o.n = 2; console.log('timer'); }, 5); process.on('exit', () => console.log('exit listener')); o",
);
node("-", "console.log(typeof os, typeof fs, typeof crypto.randomBytes)");

fs.writeFileSync(
  "package.json",
  JSON.stringify({
    scripts: {
      ok: "echo ran",
      fail: "echo failing; exit 7",
      signal: "kill -TERM $$",
    },
  }),
);
for (const script of ["ok", "fail", "signal", "missing"]) {
  const child = spawnSync(process.execPath, ["--run", script], { encoding: "utf8" });
  console.log(`--run ${script} -> ${child.status} ${child.signal} ${child.stdout.trim()}`);
}
const watched = spawnSync(process.execPath, ["--watch", "--run", "fail"], { encoding: "utf8" });
console.log(`--watch --run fail -> ${watched.status} ${watched.stdout.trim()}`);
fs.unlinkSync("package.json");
