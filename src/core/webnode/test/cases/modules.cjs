const fs = require("fs");
const path = require("path");
const dir = path.join(process.cwd(), "tmp-mod-case");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "node_modules/pkg/lib"), { recursive: true });
fs.mkdirSync(path.join(dir, "node_modules/esm-only"), { recursive: true });
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify({ name: "case", type: "commonjs" }),
);
fs.writeFileSync(path.join(dir, "a.js"), "exports.name = 'a'; exports.b = require('./b');");
fs.writeFileSync(
  path.join(dir, "b.js"),
  "const a = require('./a'); module.exports = { sawA: a.name, file: require('path').basename(__filename) };",
);
fs.writeFileSync(path.join(dir, "data.json"), '{"n": 42}');
fs.writeFileSync(
  path.join(dir, "node_modules/pkg/package.json"),
  JSON.stringify({
    name: "pkg",
    exports: {
      ".": { import: "./lib/index.mjs", require: "./lib/index.cjs" },
      "./sub": "./lib/sub.js",
    },
  }),
);
fs.writeFileSync(
  path.join(dir, "node_modules/pkg/lib/index.cjs"),
  "module.exports = { kind: 'cjs' };",
);
fs.writeFileSync(
  path.join(dir, "node_modules/pkg/lib/index.mjs"),
  "export const kind = 'esm'; export default function hello() { return 'hi'; }",
);
fs.writeFileSync(path.join(dir, "node_modules/pkg/lib/sub.js"), "module.exports = 'sub';");
fs.writeFileSync(
  path.join(dir, "node_modules/esm-only/package.json"),
  JSON.stringify({ name: "esm-only", type: "module", main: "index.js" }),
);
fs.writeFileSync(
  path.join(dir, "node_modules/esm-only/index.js"),
  "import { basename } from 'node:path'; export const where = basename(import.meta.url); export default 7; export let count = 0; export function bump() { count += 1; }",
);
fs.writeFileSync(
  path.join(dir, "main.mjs"),
  [
    "import pkg, { kind } from 'pkg';",
    "import cjs from './a.js';",
    "import seven, { where, count, bump } from 'esm-only';",
    "import * as ns from 'esm-only';",
    "import data from './data.json' with { type: 'json' };",
    "import fs, { readFileSync } from 'node:fs';",
    "bump();",
    "const late = await import('./b.js');",
    "console.log(kind, pkg(), cjs.name, seven, where, count, ns.count, data.n, typeof readFileSync, fs.readFileSync === readFileSync, late.default.file);",
    "console.log(typeof require, typeof __filename, import.meta.url.endsWith('/main.mjs'), import.meta.filename.endsWith('main.mjs'));",
  ].join("\n"),
);

const a = require(path.join(dir, "a.js"));
console.log(a.name, a.b);
console.log(require(path.join(dir, "data.json")).n);
const local = require("module").createRequire(path.join(dir, "main.cjs"));
console.log(local("pkg").kind, local("pkg/sub"), path.basename(local.resolve("pkg")));
console.log(local("esm-only").default, Object.keys(local("esm-only")).sort());
try {
  local("pkg/hidden");
} catch (error) {
  console.log(error.code);
}
try {
  require("./nope");
} catch (error) {
  console.log(error.code);
}
console.log(
  require.resolve("fs"),
  require("node:fs") === require("fs"),
  typeof module.exports,
  require.main === module,
);
import(path.join(dir, "main.mjs")).then(() => {
  fs.rmSync(dir, { recursive: true });
  console.log("done");
});
