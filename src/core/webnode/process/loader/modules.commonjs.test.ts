// @vitest-environment node
// A CommonJS file that an ES module imports, or that is the program's entry,
// is classified before it is loaded. These cases hold what that must not
// cost or change: the file is prepared once and compiled once, a file
// rewritten in between is read again, a program's own compile hook still
// sees it, and a file is a script or a module that awaits exactly as before.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import { loadBuiltin } from "../node/index";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { configureLoader, runEntry } from "./modules";
import { prepareSource, transformReady } from "./transform";

const seen = vi.hoisted(() => ({ prepared: [] as string[] }));

// Counts the preparations the loader asks for, by file.
vi.mock("./transform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transform")>();
  return {
    ...actual,
    prepareSource(...args: Parameters<typeof actual.prepareSource>) {
      seen.prepared.push(args[1]);
      return actual.prepareSource(...args);
    },
  };
});

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

interface TestGlobals {
  __log?: unknown[];
  __rewrite?: () => void;
}

let fake: FakeRuntime;
const log: unknown[] = [];
const globals = globalThis as TestGlobals;

beforeAll(async () => {
  await transformReady;
});

beforeEach(() => {
  fake = createFakeRuntime({ cwd: "/p" });
  setRuntime(fake);
  configureLoader({ loadBuiltin, conditions: [] });
  log.length = 0;
  seen.prepared.length = 0;
  globals.__log = log;
});

afterEach(() => {
  setRuntime(null);
  delete globals.__log;
  delete globals.__rewrite;
  vi.restoreAllMocks();
});

function write(path: string, text: string): void {
  fake.fs.mkdir(path.slice(0, path.lastIndexOf("/")), true, 0o755);
  fake.fs.writeFile(path, new TextEncoder().encode(text), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
}

function files(directory: string, entries: Record<string, string>): void {
  for (const [name, text] of Object.entries(entries)) {
    write(`${directory}/${name}`, text);
  }
}

/** How often the loader prepared `filename`. */
function preparations(filename: string): number {
  return seen.prepared.filter((one) => one === filename).length;
}

/** How often the code of a file that says `marker` was compiled to run. */
function compilations(evaluated: { mock: { calls: unknown[][] } }, marker: string): number {
  return evaluated.mock.calls.filter(([source]) => String(source).includes(marker)).length;
}

describe("a CommonJS file an ES module imports", () => {
  it("is prepared once, in a package of no type", async () => {
    files("/p/once", {
      "node_modules/lib/package.json": '{ "name": "lib", "main": "index.js" }',
      "node_modules/lib/index.js": "module.exports = { answer: 42 };",
      "main.mjs": "import lib from 'lib'; __log.push(lib.answer);",
    });
    await runEntry("/p/once/main.mjs");
    expect(log).toEqual([42]);
    expect(preparations("/p/once/node_modules/lib/index.js")).toBe(1);
  });

  it("is prepared once however many modules import it", async () => {
    files("/p/many", {
      "lib.js": "__log.push('ran'); module.exports = { answer: 42 };",
      "a.mjs": "import lib from './lib.js'; export const a = lib.answer;",
      "b.mjs": "import lib from './lib.js'; export const b = lib.answer;",
      "main.mjs": "import { a } from './a.mjs'; import { b } from './b.mjs'; __log.push(a + b);",
    });
    await runEntry("/p/many/main.mjs");
    expect(log).toEqual(["ran", 84]);
    // Each importer classifies it; only the first load prepares it to run, and that one is handed over.
    expect(preparations("/p/many/lib.js")).toBe(2);
  });

  it("is prepared once in a TypeScript file of a CommonJS package", async () => {
    files("/p/ts", {
      "package.json": '{ "type": "commonjs" }',
      "lib.ts": "const answer: number = 42; module.exports = { answer };",
      "main.mjs": "import lib from './lib.ts'; __log.push(lib.answer);",
    });
    await runEntry("/p/ts/main.mjs");
    expect(log).toEqual([42]);
    expect(preparations("/p/ts/lib.ts")).toBe(1);
  });

  it("is read again when it was rewritten before its importer ran", async () => {
    files("/p/rewritten", {
      "lib.js": "module.exports = 'as linked';",
      "first.mjs": "__rewrite();",
      "main.mjs": "import './first.mjs'; import lib from './lib.js'; __log.push(lib);",
    });
    globals.__rewrite = () => write("/p/rewritten/lib.js", "module.exports = 'as rewritten';");
    await runEntry("/p/rewritten/main.mjs");
    expect(log).toEqual(["as rewritten"]);
  });

  it("goes through a compile hook the program installed", async () => {
    files("/p/hook", {
      "lib.js": "module.exports = 'plain';",
      "main.mjs": "import lib from './lib.js'; __log.push(lib);",
    });
    type Compile = (code: string, filename: string) => unknown;
    type Loaded = { _compile: Compile };
    const Module = loadBuiltin("module") as {
      _extensions: Record<string, (module: Loaded, filename: string) => void>;
    };
    const original = Module._extensions[".js"];
    // As `pirates` does it: the next compile is the hook's, then the loader's again.
    Module._extensions[".js"] = (module, filename) => {
      const compile = module._compile;
      module._compile = function (code, name) {
        module._compile = compile;
        return module._compile(code.replace("'plain'", "'hooked'"), name);
      };
      original(module, filename);
    };
    try {
      await runEntry("/p/hook/main.mjs");
    } finally {
      Module._extensions[".js"] = original;
    }
    expect(log).toEqual(["hooked"]);
  });
});

describe("a CommonJS entry file", () => {
  it("is prepared once", async () => {
    files("/p/entry", { "main.js": "__log.push(typeof require, typeof module.exports);" });
    await runEntry("/p/entry/main.js");
    expect(log).toEqual(["function", "object"]);
    expect(preparations("/p/entry/main.js")).toBe(1);
  });
});

describe("a file of no format that says await", () => {
  it("is compiled once when it awaits inside a function, required or imported", async () => {
    files("/p/inside", {
      "required.js": "exports.run = async () => (await 1) + /* marker-required */ 1;",
      "imported.js": "exports.run = async () => (await 1) + /* marker-imported */ 2;",
      "main.mjs": [
        "import { createRequire } from 'node:module';",
        "import imported from './imported.js';",
        "const required = createRequire(import.meta.url)('./required.js');",
        "__log.push(await required.run(), await imported.run());",
      ].join("\n"),
    });
    const evaluated = vi.spyOn(globalThis, "eval");
    await runEntry("/p/inside/main.mjs");
    expect(log).toEqual([2, 3]);
    expect(compilations(evaluated, "marker-required")).toBe(1);
    expect(compilations(evaluated, "marker-imported")).toBe(1);
  });

  it("is an ES module when it awaits at its top level", async () => {
    files("/p/top", {
      "leaf.js":
        "const value = await Promise.resolve('awaited'); __log.push(value, typeof require);",
      "main.mjs": "import './leaf.js'; __log.push('after');",
    });
    await runEntry("/p/top/main.mjs");
    expect(log).toEqual(["awaited", "undefined", "after"]);
  });

  it("stays a script that fails to compile when it declares a wrapper name again", async () => {
    files("/p/again", {
      "lib.js": "const require = 1; exports.run = async () => await require;",
      "main.mjs": "import './lib.js';",
    });
    await expect(runEntry("/p/again/main.mjs")).rejects.toThrow(SyntaxError);
  });
});

describe("prepareSource with a caller that compiles", () => {
  it("asks the caller only about a file that says await, with the code it will run", () => {
    const asked: string[] = [];
    const compiles = (code: string) => {
      asked.push(code);
      return true;
    };
    expect(prepareSource("exports.a = 1;", "/p/a.js", null, undefined, compiles).format).toBe(
      "cjs",
    );
    expect(asked).toEqual([]);
    const prepared = prepareSource(
      "exports.a = async () => await import('./b.js');",
      "/p/a.js",
      null,
      undefined,
      compiles,
    );
    expect(prepared.format).toBe("cjs");
    expect(asked).toEqual([prepared.code]);
    expect(prepared.code).toContain("__webnode_import(");
  });

  it("decides as before when the caller's compile fails", () => {
    const fails = () => false;
    expect(prepareSource("await 1;", "/p/a.js", null, undefined, fails).format).toBe("esm");
    expect(
      prepareSource("async function f() { await 1 }", "/p/a.js", null, undefined, fails).format,
    ).toBe("cjs");
    expect(prepareSource("await 1; }", "/p/a.js", null, undefined, fails).format).toBe("cjs");
  });

  it("does not ask about a file whose format is named", () => {
    const compiles = vi.fn<(code: string) => boolean>(() => true);
    expect(prepareSource("await 1;", "/p/a.cjs", "cjs", undefined, compiles).format).toBe("cjs");
    expect(prepareSource("await 1;", "/p/a.mjs", "esm", undefined, compiles).format).toBe("esm");
    expect(compiles).not.toHaveBeenCalled();
  });
});
