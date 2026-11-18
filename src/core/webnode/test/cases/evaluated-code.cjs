// Code a program evaluates itself: import() inside a function made by
// `new Function` (or the async and generator function constructors), inside
// a direct eval and inside `(0, eval)` loads from the file that built the
// code, wherever the code is called; eval keeps its scope; and the
// constructors are what a program expects of them.
const fs = require("fs");
const path = require("path");

const dir = path.join(process.cwd(), "tmp-evaluated-code");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
const files = {
  "x.mjs": 'export default "top x"; export const where = "top";',
  "lib/x.mjs": 'export default "lib x"; export const where = "lib";',
  "lib/maker.cjs": [
    'exports.made = new Function("m", "return import(m)");',
    'exports.makeLater = () => new Function("m", "return import(m)");',
    'exports.viaEval = (m) => eval("import(m)");',
    'exports.indirect = (m) => (0, eval)("import(" + JSON.stringify(m) + ")");',
    "const AsyncFunction = (async () => {}).constructor;",
    'exports.asyncMade = new AsyncFunction("m", "return (await import(m)).where");',
  ].join("\n"),
  "main.cjs": [
    'const maker = require("./lib/maker.cjs");',
    "const AsyncFunction = (async () => {}).constructor;",
    "const GeneratorFunction = function* () {}.constructor;",
    "const show = async (label, promise) => {",
    "  try {",
    "    const m = await promise;",
    '    console.log(`${label} -> ${typeof m === "object" && m !== null ? (m.where ?? typeof m.basename) : m}`);',
    "  } catch (e) {",
    '    console.log(`${label} -> ${e.name} ${e.code} ${String(e.message).split(__dirname).join("<dir>").split("\\n")[0]}`);',
    "  }",
    "};",
    "module.exports = (async () => {",
    '  await show("made in lib, called here", maker.made("./x.mjs"));',
    '  await show("made later in lib", maker.makeLater()("./x.mjs"));',
    '  await show("direct eval in lib", maker.viaEval("./x.mjs"));',
    '  await show("indirect eval in lib", maker.indirect("./x.mjs"));',
    '  await show("AsyncFunction in lib", maker.asyncMade("./x.mjs"));',
    '  await show("made here", new Function("return import(\'./x.mjs\')")());',
    '  await show("builtin", new Function("m", "return import(m)")("node:path"));',
    '  await show("direct eval here", eval("import(\'./x.mjs\')"));',
    '  await show("indirect eval here", (0, eval)("import(\'./x.mjs\')"));',
    '  await show("eval in Function", new Function("return eval(\\"import(\'./x.mjs\')\\")")());',
    '  await show("Function in eval", eval("new Function(\\"return import(\'./x.mjs\')\\")()"));',
    '  await show("generator", GeneratorFunction("yield import(\'./x.mjs\')")().next().value);',
    '  await show("missing", new Function("return import(\'./missing.mjs\')")());',
    '  await show("bare missing", new Function("return import(\'no-such-pkg\')")());',
    "  const outer = 'module';",
    "  globalThis.outer = 'global';",
    '  await show("direct scope", (function (local) { return eval("local + outer"); })("local "));',
    '  await show("indirect scope", (function (outer) { return (0, eval)("outer"); })("local"));',
    '  await show("eval var", (0, eval)("var declaredByEval = 5; declaredByEval") + globalThis.declaredByEval);',
    '  await show("eval of a non-string", [eval(42), (0, eval)(42), eval(), typeof eval].join());',
    '  const f = new Function("a", "b", "return a + b");',
    "  console.log(f(1, 2), f.name, f.length, f instanceof Function, f.constructor === Function, Object.getPrototypeOf(f) === Function.prototype);",
    '  console.log(Function.name, Function.length, typeof Function.prototype, Function("return 7")(), Function.prototype.constructor === Function);',
    "  console.log(AsyncFunction.name, AsyncFunction.length, Object.getPrototypeOf(AsyncFunction) === Function, GeneratorFunction.name, Object.getPrototypeOf(async () => {}).constructor === AsyncFunction);",
    "  class Sub extends Function { constructor() { super(\"return 'sub'\"); } }",
    "  const s = new Sub();",
    "  console.log(s(), s instanceof Sub, s instanceof Function);",
    '  for (const make of [() => new Function("return import("), () => new Function("a b", "return 1")]) {',
    "    try { make(); } catch (e) { console.log(e.name); }",
    "  }",
    "  console.log(/\\[native code\\]/.test(Function.toString()), /\\[native code\\]/.test(AsyncFunction.toString()));",
    "})();",
  ].join("\n"),
};
for (const [name, text] of Object.entries(files)) {
  fs.writeFileSync(path.join(dir, name), text);
}

require(path.join(dir, "main.cjs")).then(() => {
  // A program whose last work is an import() made this way still gets its answer.
  new Function("m", "return import(m)")(path.join(dir, "x.mjs")).then((m) => {
    console.log("last", m.default);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
