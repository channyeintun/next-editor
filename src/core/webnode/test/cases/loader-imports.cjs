// What an import statement means, on files written at run time: a binding is
// there on every line of its module, also above the declaration; a specifier
// is a URL reference, so its percent escapes are decoded, while a require()
// request is a plain path; and a JSON file that cannot be read fails with the
// read's own message.
const fs = require("fs");
const path = require("path");

const dir = path.join(process.cwd(), "tmp-loader-imports");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "sub dir"), { recursive: true });
const files = {
  "hoist.mjs": [
    "console.log([typeof basename, v, typeof ns.join, def.kind, typeof other].join());",
    'import { basename } from "node:path";',
    "import {",
    "  v, // the value",
    "  other /* a function */,",
    '} from "./dep.mjs";',
    'import * as ns from "path"',
    'import def from "./data.cjs"',
    "const list = [1]",
    "import { \"string name\" as named } from './dep.mjs'",
    "(function () { console.log(`iife ${named} ${list.length}`) })()",
    'console.log(new Error("here").stack.split("\\n")[1].replace(/^.*hoist\\.mjs/, "hoist.mjs").replace(/\\)$/, ""));',
    'import "./side.mjs";',
  ].join("\n"),
  "dep.mjs": [
    'console.log("dep runs");',
    "export const v = 5;",
    "export function other() {}",
    'const s = "named!";',
    'export { s as "string name" };',
  ].join("\n"),
  "data.cjs": 'console.log("data runs"); module.exports = { kind: "cjs" };',
  "side.mjs": 'console.log("side runs");',
  "importer.mjs": "export const load = (specifier) => import(specifier);",
  "requirer.cjs": "exports.load = (request) => require(request);",
  "sp ace.mjs": "export default 'space';",
  "per%cent.mjs": "export default 'percent';",
  "ha#sh.mjs": "export default 'hash';",
  "lit%20eral.mjs": "export default 'the escape itself';",
  "sub dir/in ner.mjs": "export default 'deep';",
  "lit%20eral.cjs": "module.exports = 'cjs, the escape itself';",
  "lit eral.cjs": "module.exports = 'cjs, a space';",
  "bad.json": "{ nope",
  "locked.json": "{}",
};
for (const [name, text] of Object.entries(files)) {
  fs.writeFileSync(path.join(dir, name), text);
}
fs.chmodSync(path.join(dir, "locked.json"), 0);

const here = (text) => String(text).split(dir).join("<dir>");
const failure = (error) => here(`${error.name} ${error.code} :: ${error.message.split("\n")[0]}`);

(async () => {
  await import(path.join(dir, "hoist.mjs"));

  const { load } = await import(path.join(dir, "importer.mjs"));
  for (const specifier of [
    "./sp%20ace.mjs",
    "./sp ace.mjs",
    "./per%25cent.mjs",
    "./ha%23sh.mjs",
    "./sub%20dir/in%20ner.mjs",
    "./lit%2520eral.mjs",
    "./%2e%2e/tmp-loader-imports/sp%20ace.mjs",
    `${dir}/sp%20ace.mjs`,
    "./sub%20dir%2Fin%20ner.mjs",
    "./per%cent.mjs",
    "./gone%20file.mjs",
  ]) {
    try {
      console.log(`import ${here(specifier)} -> ${(await load(specifier)).default}`);
    } catch (error) {
      console.log(`import ${here(specifier)} -> ${failure(error)}`);
    }
  }

  const requirer = require(path.join(dir, "requirer.cjs"));
  for (const request of ["./lit%20eral.cjs", "./lit eral.cjs", "./sp%20ace.mjs"]) {
    try {
      const loaded = requirer.load(request);
      console.log(`require ${request} -> ${loaded.default ?? loaded}`);
    } catch (error) {
      console.log(`require ${request} -> ${error.code}`);
    }
  }
  for (const request of ["./bad.json", "./locked.json"]) {
    try {
      requirer.load(request);
    } catch (error) {
      console.log(`require ${request} -> ${failure(error)}`);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
})();
