// The module loader on files written at run time: directory requests (`./`,
// `.`, `..`, `dir/`), require() of an ES module graph with top-level await,
// sibling imports where one awaits, CommonJS that drops itself from
// require.cache, and a module rewritten on disk then imported with a new query.
const fs = require("fs");
const path = require("path");

const dir = path.join(process.cwd(), "tmp-loader-graph");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "src/utils/deep"), { recursive: true });
const files = {
  "src.js": "module.exports = 'src.js';",
  "src/index.js": "module.exports = 'src/index.js';",
  "src/utils.js": "module.exports = 'src/utils.js';",
  "src/utils/index.js": "module.exports = 'src/utils/index.js';",
  "src/utils/deep.js": "module.exports = 'src/utils/deep.js';",
  "src/utils/deep/index.js": "module.exports = 'src/utils/deep/index.js';",
  "src/utils/x.js": [
    "for (const request of ['./', '.', '..', '../', '../utils/', './deep/', './deep', '../utils']) {",
    "  console.log(JSON.stringify(request), require(request));",
    "}",
  ].join("\n"),
  "tla-leaf.mjs": "globalThis.ranLeaf = true; await Promise.resolve(); export const leaf = 1;",
  "tla-root.mjs":
    "globalThis.ranRoot = true; import { leaf } from './tla-leaf.mjs'; export const root = leaf;",
  "sync.mjs": "export const sync = 'sync esm';",
  "sibling-a.mjs":
    "console.log('a start'); await new Promise((resolve) => setTimeout(resolve, 20)); console.log('a end');",
  "sibling-b.mjs": "console.log('b runs');",
  "sibling-c.cjs": "console.log('c runs');",
  "siblings.mjs":
    "import './sibling-a.mjs'; import './sibling-b.mjs'; import './sibling-c.cjs'; console.log('parent runs');",
  "self-delete.cjs": "exports.value = 'kept exports'; delete require.cache[__filename];",
  "imports-self-delete.mjs":
    "import data from './self-delete.cjs'; import { value } from './self-delete.cjs'; console.log(data.value, value);",
  "changing.mjs": "export const version = 1;",
  "changing.js": "export const version = 'js 1';",
  "first-importer.mjs": "import { version } from './changing.js'; export const first = version;",
  "second-importer.mjs": "import { version } from './changing.js'; export const second = version;",
};
for (const [name, text] of Object.entries(files)) {
  fs.writeFileSync(path.join(dir, name), text);
}

require(path.join(dir, "src/utils/x.js"));

console.log(require(path.join(dir, "sync.mjs")).sync);
for (const name of ["tla-leaf.mjs", "tla-root.mjs"]) {
  try {
    require(path.join(dir, name));
    console.log(name, "loaded");
  } catch (error) {
    console.log(name, error.code);
  }
}
console.log("ran before the error:", globalThis.ranLeaf, globalThis.ranRoot);

(async () => {
  await import(path.join(dir, "siblings.mjs"));
  await import(path.join(dir, "imports-self-delete.mjs"));

  const mjs = path.join(dir, "changing.mjs");
  console.log("mjs", (await import(`${mjs}?v=1`)).version);
  fs.writeFileSync(mjs, "export const version = 2;");
  console.log("mjs", (await import(`${mjs}?v=2`)).version);
  console.log("mjs", (await import(`${mjs}?v=1`)).version);

  const js = path.join(dir, "changing.js");
  const { first } = await import(path.join(dir, "first-importer.mjs"));
  const { second } = await import(path.join(dir, "second-importer.mjs"));
  console.log("js", first, second);
  fs.writeFileSync(js, "export const version = 'js 2';");
  console.log("js", (await import(`${js}?v=2`)).version);

  // The await in tla-leaf.mjs is real now that import() runs it.
  console.log("tla", (await import(path.join(dir, "tla-root.mjs"))).root);
  fs.rmSync(dir, { recursive: true, force: true });
})();
