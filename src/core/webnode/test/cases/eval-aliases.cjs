// An indirect eval spelled as a value of the global `eval` (an alias, a
// property of the global object, `call`, an optional call, an array element)
// loads what its code imports through the loader, from the file that calls
// it; a plain call stays a direct eval with its scope; and `eval` reads as
// the engine's function.
const fs = require("fs");
const path = require("path");

const dir = path.join(process.cwd(), "tmp-eval-aliases");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
fs.writeFileSync(path.join(dir, "x.mjs"), 'export const where = "top";');
fs.writeFileSync(path.join(dir, "lib/x.mjs"), 'export const where = "lib";');
fs.writeFileSync(
  path.join(dir, "lib/caller.cjs"),
  "exports.call = (run, code) => run(code); exports.own = eval;",
);
fs.writeFileSync(
  path.join(dir, "main.cjs"),
  [
    'const lib = require("./lib/caller.cjs");',
    "const show = async (label, promise) => {",
    "  try {",
    "    const m = await promise;",
    '    console.log(label, "->", typeof m === "object" && m !== null ? m.where : m);',
    "  } catch (e) {",
    '    console.log(label, "->", e.name, e.code, String(e.message).split(__dirname).join("<dir>").split("\\n")[0]);',
    "  }",
    "};",
    "module.exports = (async () => {",
    "  const run = eval;",
    '  await show("alias", run("import(\'./x.mjs\')"));',
    '  await show("property", globalThis.eval("import(\'./x.mjs\') "));',
    '  await show("global", global.eval("import(\'./x.mjs\')  "));',
    '  await show("call", eval.call(null, "import(\'./x.mjs\')   "));',
    '  await show("optional call", eval?.("import(\'./x.mjs\')    "));',
    '  await show("from an array", [eval][0]("import(\'./x.mjs\')     "));',
    '  await show("alias called in lib", lib.call(run, "import(\'./x.mjs\')      "));',
    '  await show("lib\'s eval called here", lib.own("import(\'./x.mjs\')       "));',
    '  await show("missing", run("import(\'./missing.mjs\')"));',
    "  const local = 'local';",
    "  globalThis.outer = 'global';",
    '  await show("scope", (function (outer) { return run("typeof local + outer"); })("argument"));',
    '  await show("direct", (function (outer) { return eval("local + outer"); })(" argument"));',
    '  await show("not a string", run(42));',
    "  console.log(eval === globalThis.eval, eval === lib.own, typeof eval, eval.name, eval.length);",
    "  console.log(String(eval), Object.getOwnPropertyNames(eval).join(), eval instanceof Function);",
    "  delete globalThis.outer;",
    "})();",
  ].join("\n"),
);

require(path.join(dir, "main.cjs")).then(() => {
  // A program whose last work is such an import() still gets its answer.
  // eslint-disable-next-line no-eval -- the alias is what this case checks
  const run = eval;
  run(`import(${JSON.stringify(path.join(dir, "x.mjs"))})`).then((m) => {
    console.log("last", m.where);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
