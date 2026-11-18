// @vitest-environment node
// Code a program evaluates itself, on the fake runtime's filesystem: the
// `import()` of a function made by `new Function` (and its async and generator
// siblings), of a direct eval and of `(0, eval)` loads through the loader, as
// code of the file that built it; and the constructors stay what Node's are.
// The expectations are real node v26's answers for the same files.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import { loadBuiltin } from "../node/index";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { configureLoader, runEntry } from "./modules";
import { rewriteEvaluated, transformReady } from "./transform";

// What build/webnodeBundle.ts does to sucrase's code templates in the bundle:
// the code it writes for `import` and `export` uses the loader's own names.
vi.mock("sucrase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sucrase")>();
  return {
    ...actual,
    transform(code: string, options: Parameters<typeof actual.transform>[1]) {
      const result = actual.transform(code, options);
      if (!options.transforms.includes("imports")) {
        return result;
      }
      return {
        ...result,
        code: result.code
          .replaceAll("require('", "__webnode_require('")
          .replace(/(?<!module\.)\bexports\b/g, "__webnode_exports"),
      };
    },
  };
});

let fake: FakeRuntime;
const log: unknown[] = [];
const scope = globalThis as { __log?: unknown[]; __done?: Promise<unknown> };

beforeAll(async () => {
  await transformReady;
});

beforeEach(() => {
  fake = createFakeRuntime({ cwd: "/p/ev" });
  setRuntime(fake);
  configureLoader({ loadBuiltin, conditions: [] });
  log.length = 0;
  scope.__log = log;
});

afterEach(() => {
  setRuntime(null);
  delete scope.__log;
  delete scope.__done;
});

function files(directory: string, entries: Record<string, string>): void {
  for (const [name, text] of Object.entries(entries)) {
    const path = `${directory}/${name}`;
    fake.fs.mkdir(path.slice(0, path.lastIndexOf("/")), true, 0o755);
    fake.fs.writeFile(path, new TextEncoder().encode(text), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  }
}

let mains = 0;

/**
 * Runs a file of `/p/ev`, whose body is `lines` inside an async function, to
 * its end. Each run is a file of its own: a module runs once.
 */
async function runMain(lines: string[]): Promise<string> {
  mains += 1;
  const name = `main${mains}.cjs`;
  files("/p/ev", {
    [name]: [
      "const show = async (label, promise) => {",
      "  try {",
      "    const m = await promise;",
      "    __log.push([label, typeof m === 'object' && m !== null ? (m.where ?? typeof m.basename) : m]);",
      "  } catch (e) {",
      "    __log.push([label, e.name, e.code, e.message]);",
      "  }",
      "};",
      "globalThis.__done = (async () => {",
      ...lines,
      "})();",
    ].join("\n"),
  });
  await runEntry(`/p/ev/${name}`);
  await scope.__done;
  return `/p/ev/${name}`;
}

const MODULES = {
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
};

describe("import() in code a program evaluates", () => {
  it("loads from the file that built the code, wherever the code is called", async () => {
    files("/p/ev", MODULES);
    await runMain([
      'const maker = require("./lib/maker.cjs");',
      'await show("made in lib, called here", maker.made("./x.mjs"));',
      'await show("made later in lib", maker.makeLater()("./x.mjs"));',
      'await show("direct eval in lib", maker.viaEval("./x.mjs"));',
      'await show("indirect eval in lib", maker.indirect("./x.mjs"));',
      'await show("AsyncFunction in lib", maker.asyncMade("./x.mjs"));',
      'await show("made here", new Function("return import(\'./x.mjs\')")());',
      'await show("builtin", new Function("m", "return import(m)")("node:path"));',
      'await show("direct eval here", eval("import(\'./x.mjs\')"));',
      'await show("indirect eval here", (0, eval)("import(\'./x.mjs\')"));',
      'await show("eval in Function", new Function("return eval(\\"import(\'./x.mjs\')\\")")());',
      'await show("Function in eval", eval("new Function(\\"return import(\'./x.mjs\')\\")()"));',
      "const GeneratorFunction = function* () {}.constructor;",
      'await show("generator", GeneratorFunction("yield import(\'./x.mjs\')")().next().value);',
      "const AsyncGeneratorFunction = async function* () {}.constructor;",
      'await show("async generator", AsyncGeneratorFunction("yield import(\'./x.mjs\')")().next().then((step) => step.value));',
    ]);
    expect(log).toEqual([
      ["made in lib, called here", "lib"],
      ["made later in lib", "lib"],
      ["direct eval in lib", "lib"],
      ["indirect eval in lib", "lib"],
      ["AsyncFunction in lib", "lib"],
      ["made here", "top"],
      ["builtin", "function"],
      ["direct eval here", "top"],
      ["indirect eval here", "top"],
      ["eval in Function", "top"],
      ["Function in eval", "top"],
      ["generator", "top"],
      ["async generator", "top"],
    ]);
  });

  it("rejects with the loader's error for a module that is not there", async () => {
    const main = await runMain([
      'await show("missing", new Function("return import(\'./missing.mjs\')")());',
      'await show("bare", eval("import(\'no-such-pkg\')"));',
    ]);
    expect(log).toEqual([
      [
        "missing",
        "Error",
        "ERR_MODULE_NOT_FOUND",
        `Cannot find module '/p/ev/missing.mjs' imported from ${main}`,
      ],
      [
        "bare",
        "Error",
        "ERR_MODULE_NOT_FOUND",
        `Cannot find package 'no-such-pkg' imported from ${main}`,
      ],
    ]);
  });

  it("loads in code that has a globalThis and a Symbol of its own", async () => {
    files("/p/ev", {
      ...MODULES,
      "shadow.cjs": [
        "const globalThis = null, Symbol = null;",
        "module.exports = [",
        "  eval(\"import('./x.mjs')\"),",
        "  (0, eval)(\"import('./x.mjs')\"),",
        '  new Function("globalThis", "Symbol", "return import(\'./x.mjs\')")(null, null),',
        "];",
      ].join("\n"),
    });
    await runMain([
      'for (const made of require("./shadow.cjs")) { await show("shadowed", made); }',
    ]);
    expect(log).toEqual([
      ["shadowed", "top"],
      ["shadowed", "top"],
      ["shadowed", "top"],
    ]);
  });

  it("loads from an ES module and from TypeScript compiled to CommonJS too", async () => {
    files("/p/ev", {
      ...MODULES,
      "esm.mjs": [
        "const viaFunction = await new Function(\"return import('./lib/x.mjs')\")();",
        "const viaEval = await eval(\"import('./x.mjs')\");",
        "const local = 20;",
        '__log.push(viaFunction.where, viaEval.where, eval("local + 1"));',
      ].join("\n"),
      "typed.cts": [
        "const local: number = 30;",
        'eval("import(\'./x.mjs\')").then((m: { where: string }) => __log.push(m.where, eval("local + 1")));',
      ].join("\n"),
    });
    await runEntry("/p/ev/esm.mjs");
    await runEntry("/p/ev/typed.cts");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(["lib", "top", 21, "top", 31]);
  });
});

describe("import() in code vm compiles", () => {
  const MISSING = [
    "TypeError",
    "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
    "A dynamic import callback was not specified.",
  ];
  const NEEDS_FLAG = [
    "TypeError",
    "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG",
    "A dynamic import callback was invoked without --experimental-vm-modules",
  ];

  it("follows the importModuleDynamically option, as Node does without --experimental-vm-modules", async () => {
    files("/p/ev", { ...MODULES, "lib/f.js": "" });
    await runMain([
      'const vm = require("vm");',
      "const L = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;",
      "let called = 0;",
      "const callback = () => { called += 1; return import('./x.mjs'); };",
      'await show("runInThisContext", vm.runInThisContext("import(\'./x.mjs\')"));',
      'await show("Script", new vm.Script("import(\'./x.mjs\')").runInThisContext());',
      'await show("compileFunction", vm.compileFunction("return import(\'./x.mjs\')")());',
      'await show("runInNewContext", vm.runInNewContext("import(\'./x.mjs\')", {}));',
      'await show("runInContext", vm.runInContext("import(\'./x.mjs\')", vm.createContext({})));',
      'await show("direct eval inside", vm.runInThisContext("eval(\\"import(\'./x.mjs\')\\")"));',
      'await show("builtin", vm.runInThisContext("import(\'node:path\')"));',
      'await show("loader", vm.runInThisContext("import(\'./x.mjs\')", { importModuleDynamically: L }));',
      'await show("loader, file in lib", vm.runInThisContext("import(\'./x.mjs\')", { filename: "/p/ev/lib/f.js", importModuleDynamically: L }));',
      'await show("loader, relative file", vm.runInThisContext("import(\'./x.mjs\')", { filename: "lib/f.js", importModuleDynamically: L }));',
      'await show("loader Script", new vm.Script("import(\'./x.mjs\')", { importModuleDynamically: L }).runInThisContext());',
      'await show("loader compileFunction", vm.compileFunction("return import(\'./x.mjs\')", [], { importModuleDynamically: L })());',
      'await show("loader context", vm.runInNewContext("import(\'./x.mjs\')", {}, { importModuleDynamically: L }));',
      'await show("loader direct eval inside", vm.runInThisContext("eval(\\"import(\'./x.mjs\')\\")", { importModuleDynamically: L }));',
      'await show("option on run", new vm.Script("import(\'./x.mjs\')").runInThisContext({ importModuleDynamically: L }));',
      'await show("callback", vm.runInThisContext("import(\'./x.mjs\')", { importModuleDynamically: callback }));',
      'await show("callback compileFunction", vm.compileFunction("return import(\'./x.mjs\')", [], { importModuleDynamically: callback })());',
      '__log.push(["called", called]);',
      "for (const bad of [5, null, Symbol('x'), vm.constants.DONT_CONTEXTIFY]) {",
      '  try { vm.runInThisContext("1", { importModuleDynamically: bad }); } catch (e) { __log.push([e.code, e.message]); }',
      "}",
      'try { vm.compileFunction("1", [], { importModuleDynamically: "x" }); } catch (e) { __log.push([e.code]); }',
    ]);
    const rejected = (label: string, why: string[]) => [label, ...why];
    expect(log).toEqual([
      rejected("runInThisContext", MISSING),
      rejected("Script", MISSING),
      rejected("compileFunction", MISSING),
      rejected("runInNewContext", MISSING),
      rejected("runInContext", MISSING),
      rejected("direct eval inside", MISSING),
      rejected("builtin", MISSING),
      ["loader", "top"],
      ["loader, file in lib", "lib"],
      ["loader, relative file", "top"],
      ["loader Script", "top"],
      ["loader compileFunction", "top"],
      ["loader context", "top"],
      ["loader direct eval inside", "top"],
      rejected("option on run", MISSING),
      rejected("callback", NEEDS_FLAG),
      rejected("callback compileFunction", NEEDS_FLAG),
      ["called", 0],
      [
        "ERR_INVALID_ARG_TYPE",
        'The "options.importModuleDynamically" property must be of type function. Received type number (5)',
      ],
      [
        "ERR_INVALID_ARG_TYPE",
        'The "options.importModuleDynamically" property must be of type function. Received null',
      ],
      [
        "ERR_INVALID_ARG_TYPE",
        'The "options.importModuleDynamically" property must be of type function. Received type symbol (Symbol(x))',
      ],
      [
        "ERR_INVALID_ARG_TYPE",
        'The "options.importModuleDynamically" property must be of type function. Received type symbol (Symbol(vm_context_no_contextify))',
      ],
      ["ERR_INVALID_ARG_TYPE"],
    ]);
  });
});

describe("eval, as the engine has it", () => {
  it("keeps a direct eval's scope and an indirect eval's lack of one", async () => {
    await runMain([
      "const outer = 'module';",
      "globalThis.outer = 'global';",
      'await show("direct", (function (local) { return eval("local + outer"); })("local "));',
      'await show("indirect", (function (outer) { return (0, eval)("outer"); })("local"));',
      'await show("var", (0, eval)("var declaredByEval = 5; declaredByEval") + globalThis.declaredByEval);',
      'await show("non-string", [eval(42), (0, eval)(42), eval(), typeof eval].join());',
      'await show("spread", eval(...["1 + 1", "ignored"]));',
      'await show("nested", eval("eval(\'1 + \' + 2)"));',
      "delete globalThis.outer; delete globalThis.declaredByEval;",
    ]);
    expect(log).toEqual([
      ["direct", "local module"],
      ["indirect", "global"],
      ["var", 10],
      ["non-string", "42,42,,function"],
      ["spread", 2],
      ["nested", 3],
    ]);
  });

  it("leaves code that has an eval of its own, and the word in a string, as written", () => {
    const parent = () => "/p/ev/main.cjs";
    expect(
      rewriteEvaluated('function eval(code) { return code } eval("eval(1)")', parent),
    ).toBeNull();
    expect(rewriteEvaluated('const eval = other; eval("import(1)")', parent)).toBeNull();
    expect(rewriteEvaluated('var eval = other; (0, eval)("1")', parent)).toBeNull();
    expect(rewriteEvaluated('log("eval(x) and import(y)"); // eval(z)', parent)).toBeNull();
    expect(rewriteEvaluated("a.eval(b); a?.eval(c); ({ eval: 1, eval() {} })", parent)).toBeNull();
    expect(rewriteEvaluated("return a + b", parent)).toBeNull();
    // A parenthesized plain call is a direct eval too.
    expect(rewriteEvaluated("(eval)(code); ((eval))(code)", parent)).toBeNull();
    // A parameter called `eval` is an eval of the code's own.
    expect(rewriteEvaluated("g((a, eval) => 1); f(eval)", parent)).toBeNull();
    expect(rewriteEvaluated("try {} catch (eval) {} (0, eval)(x)", parent)).toBeNull();
  });

  it("makes each other use of the global eval as a value the loader's indirect eval", () => {
    const host = '__webnode_evaluated("/p/ev/main.cjs")';
    const rewrite = (code: string) => rewriteEvaluated(code, () => "/p/ev/main.cjs");
    expect(rewrite("const run = eval; run(code); globalThis.eval(code)")).toBe(
      `const run = ${host}.eval; run(code); ${host}.eval(code)`,
    );
    expect(rewrite("eval.call(null, c); eval?.(c); [eval][0](c); ({ eval }); a ? eval : b")).toBe(
      `${host}.eval.call(null, c); ${host}.eval?.(c); [${host}.eval][0](c); ({ eval: ${host}.eval }); a ? ${host}.eval : b`,
    );
    expect(rewrite("global.eval(a); self . eval; window.eval; eval === globalThis.eval")).toBe(
      `${host}.eval(a); ${host}.eval; ${host}.eval; ${host}.eval === ${host}.eval`,
    );
    expect(rewrite("eval(eval)")).toBe(`eval(${host}.source(${host}.eval))`);
    // A property of something else, an assignment, a delete, a label and a key stay as written.
    expect(
      rewrite(
        "a.globalThis.eval; globalThis?.eval; eval = f; eval++; globalThis.eval = f; delete eval; eval: for (;;) break eval; x = { eval: 1 }",
      ),
    ).toBeNull();
    expect(rewrite("const global = {}; global.eval; globalThis.eval")).toBe(
      `const global = {}; global.eval; ${host}.eval`,
    );
  });

  it("rewrites only what needs the loader, and asks for the file only then", () => {
    let asked = 0;
    const parent = () => {
      asked += 1;
      return "/p/ev/a b.cjs";
    };
    expect(rewriteEvaluated("return 1 + important", parent)).toBeNull();
    expect(asked).toBe(0);
    const host = '__webnode_evaluated("/p/ev/a b.cjs")';
    expect(rewriteEvaluated("return import(m)", parent)).toBe(`return ${host}.import(m)`);
    expect(rewriteEvaluated("eval(import(a), b)", parent)).toBe(
      `eval(${host}.source(${host}.import(a), b))`,
    );
    expect(rewriteEvaluated("(0, eval)(`x${eval(y)}`)", parent)).toBe(
      `(0, ${host}.eval)(\`x\${eval(${host}.source(y))}\`)`,
    );
    expect(asked).toBe(3);
  });

  it("finds the whole call, whatever its argument holds", () => {
    const host = '__webnode_evaluated("/p/ev/main.cjs")';
    const rewrite = (code: string) => rewriteEvaluated(code, () => "/p/ev/main.cjs");
    expect(rewrite("eval\n  (a)(b)")).toBe(`eval\n  (${host}.source(a))(b)`);
    expect(rewrite('eval(/\\)/.test(q) ? "a)" : `b${")"}`) // eval(c)')).toBe(
      `eval(${host}.source(/\\)/.test(q) ? "a)" : \`b\${")"}\`)) // eval(c)`,
    );
    expect(rewrite('"eval(x)" + eval(eval(y))')).toBe(
      `"eval(x)" + eval(${host}.source(eval(${host}.source(y))))`,
    );
    expect(rewrite("(0,eval)(a); (1, eval) (b)")).toBe(
      `(0,${host}.eval)(a); (1, ${host}.eval) (b)`,
    );
    expect(rewrite("eval()")).toBe(`eval(${host}.source())`);
  });

  it("loads through the loader from an eval spelled any other way, from the file that calls it", async () => {
    files("/p/ev", {
      ...MODULES,
      "lib/caller.cjs": "exports.call = (run, code) => run(code); exports.own = eval;",
    });
    await runMain([
      'const lib = require("./lib/caller.cjs");',
      "const run = eval;",
      'await show("alias", run("import(\'./x.mjs\')"));',
      'await show("property", globalThis.eval("import(\'./x.mjs\')"));',
      'await show("global", global.eval("import(\'./x.mjs\')"));',
      'await show("call", eval.call(null, "import(\'./x.mjs\')"));',
      'await show("optional call", eval?.("import(\'./x.mjs\')"));',
      'await show("from an array", [eval][0]("import(\'./x.mjs\')"));',
      'await show("alias called in lib", lib.call(run, "import(\'./x.mjs\')"));',
      'await show("lib\'s eval called here", lib.own("import(\'./x.mjs\')"));',
      "const local = 'local';",
      "globalThis.outer = 'global';",
      'await show("scope", (function (outer) { return run("typeof local + outer"); })("argument"));',
      'await show("not a string", run(42));',
      "__log.push([eval === globalThis.eval, eval === lib.own, typeof eval, eval.name, eval.length, String(eval), Object.getOwnPropertyNames(eval).join(), eval instanceof Function].join());",
      'await show("direct still", (function (local) { return eval("local"); })("direct"));',
      "delete globalThis.outer;",
    ]);
    expect(log).toEqual([
      ["alias", "top"],
      ["property", "top"],
      ["global", "top"],
      ["call", "top"],
      ["optional call", "top"],
      ["from an array", "top"],
      ["alias called in lib", "lib"],
      ["lib's eval called here", "top"],
      ["scope", "undefinedglobal"],
      ["not a string", 42],
      "true,true,function,eval,1,function eval() { [native code] },length,name,true",
      ["direct still", "direct"],
    ]);
  });

  it("leaves what is not an eval of code: a method, a key, a parameter list, a longer word", () => {
    const rewrite = (code: string) => rewriteEvaluated(code, () => "/p/ev/main.cjs");
    expect(rewrite("x = { eval: true, eval(a) { return a } }; class A { eval(b) {} }")).toBeNull();
    expect(rewrite("f(a, eval); g((a, eval) => 1); [a, eval]")).toBeNull();
    expect(rewrite("evaluate(a); medieval(b); $eval(c); eval_(d); this.#eval(e)")).toBeNull();
  });
});

describe("the function constructors", () => {
  it("are Node's in everything a program can see", async () => {
    await runMain([
      "const AsyncFunction = (async () => {}).constructor;",
      "const GeneratorFunction = function* () {}.constructor;",
      'const f = new Function("a", "b", "return a + b");',
      "__log.push([f(1, 2), f.name, f.length, f instanceof Function, f.constructor === Function, Object.getPrototypeOf(f) === Function.prototype].join());",
      '__log.push([Function.name, Function.length, typeof Function.prototype, Function("return 7")(), Function.prototype.constructor === Function].join());',
      "__log.push([AsyncFunction.name, AsyncFunction.length, Object.getPrototypeOf(AsyncFunction) === Function, GeneratorFunction.name, Object.getPrototypeOf(async () => {}).constructor === AsyncFunction].join());",
      "class Sub extends Function { constructor() { super(\"return 'sub'\"); } }",
      "const s = new Sub();",
      "__log.push([s(), s instanceof Sub, s instanceof Function].join());",
      'for (const make of [() => new Function("return import("), () => new Function("a b", "return 1")]) {',
      "  try { make(); } catch (e) { __log.push(e.name); }",
      "}",
      "__log.push([/\\[native code\\]/.test(Function.toString()), /\\[native code\\]/.test(AsyncFunction.toString())].join());",
      "__log.push(new Function({ toString: () => 'x' }, { toString: () => 'return x * 2' })(21));",
      "__log.push(Object.keys(globalThis).filter((name) => /webnode/.test(name)).length);",
      "const prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');",
      "const limit = Error.stackTraceLimit;",
      "const marker = () => 'own';",
      "Error.prepareStackTrace = marker; Error.stackTraceLimit = 3;",
      "new Function('return import(\"node:path\")');",
      "__log.push([Error.prepareStackTrace === marker, Error.stackTraceLimit].join());",
      "delete Error.prepareStackTrace; Error.stackTraceLimit = 10;",
      "new Function('return import(\"node:path\")');",
      "__log.push(Object.hasOwn(Error, 'prepareStackTrace'));",
      "if (prepare) { Object.defineProperty(Error, 'prepareStackTrace', prepare); }",
      "Error.stackTraceLimit = limit;",
    ]);
    expect(log).toEqual([
      "3,anonymous,2,true,true,true",
      "Function,1,function,7,true",
      "AsyncFunction,1,true,GeneratorFunction,true",
      "sub,true,true",
      "SyntaxError",
      "SyntaxError",
      "true,true",
      42,
      0,
      "true,3",
      false,
    ]);
  });
});
