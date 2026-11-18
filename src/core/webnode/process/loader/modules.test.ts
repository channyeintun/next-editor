// @vitest-environment node
// The module loader on the fake runtime's filesystem: ES module linking
// (cycles, missing names, retries after a failed link), TypeScript and JSX in
// CommonJS packages, and the paths `require.resolve` and `import.meta.resolve`
// take.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import { loadBuiltin } from "../node/index";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { runMacrotask } from "../node/eventLoop";
import { createProcess } from "../node/process";
import { configureLoader, importModule, runEntry, runSource } from "./modules";
import { prepareSource, transformReady } from "./transform";

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

beforeAll(async () => {
  await transformReady;
});

beforeEach(() => {
  fake = createFakeRuntime({ cwd: "/p" });
  setRuntime(fake);
  configureLoader({ loadBuiltin, conditions: [] });
  log.length = 0;
  (globalThis as { __log?: unknown[] }).__log = log;
});

afterEach(() => {
  setRuntime(null);
  delete (globalThis as { __log?: unknown[] }).__log;
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

describe("ES module cycles", () => {
  it("reads default, named and namespace imports live, and hoists exported functions", async () => {
    files("/p/cyc", {
      "ast.mjs": [
        "import { visit } from './visit.mjs';",
        "export function isNode(n) { return !!n }",
        "export default function walk(n) { return visit(n) }",
        "function helper() {}",
        "export { helper };",
      ].join("\n"),
      "visit.mjs": [
        "import walk, { isNode, helper } from './ast.mjs';",
        "import * as ns from './ast.mjs';",
        "__log.push([typeof isNode, typeof walk, typeof helper, typeof ns.isNode].join());",
        "export function visit(n) { return n }",
        "export function later() { return [typeof walk, typeof ns.isNode, typeof ns.default].join() }",
      ].join("\n"),
      "main.mjs": [
        "import { isNode } from './ast.mjs';",
        "import { later } from './visit.mjs';",
        "__log.push(later(), isNode(1));",
      ].join("\n"),
    });
    await runEntry("/p/cyc/main.mjs");
    expect(log).toEqual([
      "function,function,function,function",
      "function,function,function",
      true,
    ]);
  });

  it("gives a cycle the exported functions at once and the other bindings live", async () => {
    files("/p/live", {
      "a.mjs": "import './b.mjs'; export let count = 1; export function bump() { count += 1 }",
      "b.mjs": [
        "import { bump } from './a.mjs';",
        "import * as a from './a.mjs';",
        "__log.push(typeof bump);",
        "export function read() { return a.count }",
        "export { bump };",
      ].join("\n"),
      "main.mjs":
        "import './a.mjs'; import { read, bump } from './b.mjs'; bump(); __log.push(read());",
    });
    await runEntry("/p/live/main.mjs");
    expect(log).toEqual(["function", 2]);
  });
});

describe("linking", () => {
  it("rejects an import of a name the module does not export, as Node does", async () => {
    files("/p/miss", {
      "math.mjs": "export function sum(a, b) { return a + b }",
      "main.mjs": "import { summ } from './math.mjs'; __log.push(typeof summ);",
    });
    await expect(runEntry("/p/miss/main.mjs")).rejects.toThrow(
      new SyntaxError("The requested module './math.mjs' does not provide an export named 'summ'"),
    );
    expect(log).toEqual([]);
  });

  it("finds names through export * and leaves CommonJS imports unchecked", async () => {
    files("/p/star", {
      "leaf.mjs": "export const leaf = 'leaf'; export default 'not re-exported';",
      "barrel.mjs": "export * from './leaf.mjs'; export * from './data.cjs';",
      "data.cjs": "exports.fromCjs = 'cjs';",
      "main.mjs": [
        "import { leaf, fromCjs } from './barrel.mjs';",
        "import { anything } from './data.cjs';",
        "__log.push(leaf, fromCjs, anything);",
      ].join("\n"),
      "default.mjs": "import def from './barrel.mjs';",
    });
    await runEntry("/p/star/main.mjs");
    expect(log).toEqual(["leaf", "cjs", undefined]);
    await expect(importModule("./default.mjs", "/p/star/main.mjs")).rejects.toThrow(
      "does not provide an export named 'default'",
    );
  });

  it("reads the files again after a failed link, as Node does", async () => {
    files("/p/retry", {
      "a.mjs": "import { v } from './b.mjs'; export const x = v;",
      "s.mjs": "export const x = ;",
    });
    await expect(importModule("./a.mjs", "/p/retry/main.mjs")).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
    });
    write("/p/retry/b.mjs", "export const v = 42;");
    expect((await importModule("./a.mjs", "/p/retry/main.mjs")).x).toBe(42);

    await expect(importModule("./s.mjs", "/p/retry/main.mjs")).rejects.toThrow(SyntaxError);
    write("/p/retry/s.mjs", "export const x = 1;");
    expect((await importModule("./s.mjs", "/p/retry/main.mjs")).x).toBe(1);
  });

  it("keeps an evaluation error for good", async () => {
    files("/p/throws", { "t.mjs": "__log.push('ran'); throw new Error('boom');" });
    await expect(importModule("./t.mjs", "/p/throws/main.mjs")).rejects.toThrow("boom");
    await expect(importModule("./t.mjs", "/p/throws/main.mjs")).rejects.toThrow("boom");
    expect(log).toEqual(["ran"]);
  });
});

describe("ES modules", () => {
  it("still handles string names, live bindings, export * and module.exports", async () => {
    files("/p/names", {
      "strings.mjs":
        "const a = 1; const b = 2; export { a as 'kebab-name', b as \"with space\", a as plain };",
      "reads.mjs":
        "import { 'kebab-name' as kebab, \"with space\" as spaced, plain } from './strings.mjs'; export const sum = kebab + spaced + plain;",
      "star.mjs": "export * from './strings.mjs';",
      "reads-star.mjs": "import { 'with space' as spaced } from './star.mjs'; export { spaced };",
      "live.mjs":
        "let count = 0; export function bump() { count += 1; } export { count as 'the count' };",
      "as-function.mjs": [
        "function plugin() { return 'called'; }",
        "export default plugin;",
        "export const named = 'named';",
        "export { plugin as 'module.exports' };",
      ].join("\n"),
      "main.mjs": [
        "import { sum } from './reads.mjs';",
        "import { spaced } from './reads-star.mjs';",
        "import * as live from './live.mjs';",
        "import plugin, { named } from './as-function.mjs';",
        "import { createRequire } from 'node:module';",
        "live.bump(); live.bump();",
        "const required = createRequire(import.meta.url)('./as-function.mjs');",
        "__log.push(sum, spaced, live['the count'], plugin(), named, required === plugin);",
      ].join("\n"),
    });
    await runEntry("/p/names/main.mjs");
    expect(log).toEqual([4, 2, 2, "called", "named", true]);
  });

  it("runs a top-level await, and require() of it fails", async () => {
    files("/p/tla", {
      "leaf.mjs": "await Promise.resolve(); export const leaf = 1;",
      "main.mjs":
        "import { leaf } from './leaf.mjs'; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); let code; try { require(`./other.mjs`) } catch (error) { code = error.code } __log.push(leaf, code);",
      "other.mjs": "await 0;",
    });
    await runEntry("/p/tla/main.mjs");
    expect(log).toEqual([1, "ERR_REQUIRE_ASYNC_MODULE"]);
  });

  it("starts a module that awaits before its later siblings, as Node does", async () => {
    const seen: string[] = [];
    (globalThis as { orderSeen?: string[] }).orderSeen = seen;
    files("/p/order", {
      "a.mjs":
        "globalThis.orderSeen.push('a start'); await new Promise((r) => setTimeout(r, 5)); globalThis.orderSeen.push('a end');",
      "b.mjs": "globalThis.orderSeen.push('b');",
      "c.cjs": "globalThis.orderSeen.push('c');",
      "main.mjs":
        "import './a.mjs'; import './b.mjs'; import './c.cjs'; globalThis.orderSeen.push('main');",
    });
    await runEntry("/p/order/main.mjs");
    delete (globalThis as { orderSeen?: string[] }).orderSeen;
    // The awaiting module runs up to its await first; only its importer waits for it.
    expect(seen).toEqual(["a start", "b", "c", "a end", "main"]);
  });

  it("binds an import on every line, also above its declaration", async () => {
    files("/p/hoist", {
      "main.mjs": [
        "__log.push([typeof basename, v, typeof ns.join, def.kind, typeof other].join());",
        'import { basename } from "node:path";',
        "import {",
        "  v, // the value",
        "  other /* a function */,",
        '} from "./dep.mjs";',
        'import * as ns from "path"',
        'import def from "./data.cjs"',
        "const list = [1]",
        "import { \"string name\" as named } from './dep.mjs'",
        "(function () { __log.push(`iife ${named} ${list.length}`) })()",
        '__log.push(new Error("here").stack.split("\\n")[1].replace(/^.*main\\.mjs/, "main.mjs").replace(/\\)$/, ""));',
        'import "./side.mjs";',
      ].join("\n"),
      "dep.mjs": [
        '__log.push("dep runs");',
        "export const v = 5;",
        "export function other() {}",
        'const s = "named!";',
        'export { s as "string name" };',
      ].join("\n"),
      "data.cjs": '__log.push("data runs"); module.exports = { kind: "cjs" };',
      "side.mjs": '__log.push("side runs");',
    });
    await runEntry("/p/hoist/main.mjs");
    // Real node v26 prints the same six lines.
    expect(log).toEqual([
      "dep runs",
      "data runs",
      "side runs",
      "function,5,function,cjs,function",
      "iife named! 1",
      "main.mjs:12:12",
    ]);
  });

  it("keeps every line where it was when it lifts an import declaration", () => {
    const source = [
      "first();",
      "import {",
      "  a, // one",
      "  b /* two",
      "  lines */,",
      "} from './de\\",
      "p.mjs'",
      "last(a, b);",
    ].join("\n");
    const prepared = prepareSource(source, "/p/lines/main.mjs", "esm");
    expect(prepared.specifiers).toEqual(["./dep.mjs"]);
    const lines = prepared.code.split("\n");
    expect(lines).toHaveLength(source.split("\n").length);
    // The declaration, on the first line, before the code that was there.
    expect(lines[0]).toMatch(/__webnode_require\('\.\/dep\.mjs'\);.*first\(\);$/);
    // Where it stood: a statement boundary and its line breaks.
    expect(lines.slice(1, 7)).toEqual([";", "", "", "", "", ""]);
    expect(lines[7]).toMatch(/^last\(.*\.a, .*\.b\);$/);
  });

  it("puts the imports of a TypeScript file first whichever format it runs as", async () => {
    files("/p/hoistts", {
      "package.json": '{"type":"commonjs"}',
      "cjs.ts": [
        "__log.push(typeof helper, typeof join, typeof fs.readFileSync);",
        "import { helper } from './helper';",
        "import type { Shape } from './helper';",
        "import { join } from 'node:path'",
        "import fs = require('node:fs');",
        "const shape: Shape = { n: 1 };",
        "__log.push(shape.n, typeof module);",
      ].join("\n"),
      "esm.mts": [
        "__log.push(typeof helper);",
        "import { helper } from './helper';",
        "const n: number = 2;",
        "__log.push(n, typeof module);",
      ].join("\n"),
      "helper.ts": "export interface Shape { n: number }\nexport function helper(): void {}",
    });
    // `import fs = require()` is a `const`, declared where it stands: it is not lifted.
    await expect(Promise.resolve().then(() => runEntry("/p/hoistts/cjs.ts"))).rejects.toThrow(
      "Cannot access 'fs' before initialization",
    );
    expect(log).toEqual([]);
    write(
      "/p/hoistts/cjs.ts",
      [
        "__log.push(typeof helper, typeof join);",
        "import { helper } from './helper';",
        "import type { Shape } from './helper';",
        "import { join } from 'node:path'",
        "import fs = require('node:fs');",
        "const shape: Shape = { n: 1 };",
        "__log.push(shape.n, typeof module, typeof fs.readFileSync);",
      ].join("\n"),
    );
    await runEntry("/p/hoistts/cjs.ts");
    await runEntry("/p/hoistts/esm.mts");
    expect(log).toEqual([
      "function",
      "function",
      1,
      "object",
      "function",
      "function",
      2,
      "undefined",
    ]);
  });

  it("resolves import.meta.resolve of a path whether or not the file exists", async () => {
    files("/p/imr", {
      "main.mjs": [
        "__log.push(import.meta.resolve('./missing.js'), import.meta.resolve('../imr/dir-no-ext'), import.meta.resolve('/abs/missing.js'));",
        "try { import.meta.resolve('nopkg') } catch (error) { __log.push(error.code) }",
      ].join("\n"),
    });
    await runEntry("/p/imr/main.mjs");
    expect(log).toEqual([
      "file:///p/imr/missing.js",
      "file:///p/imr/dir-no-ext",
      "file:///abs/missing.js",
      "ERR_MODULE_NOT_FOUND",
    ]);
  });
});

describe("CommonJS", () => {
  it("resolves require.resolve paths relative to the working directory", async () => {
    files("/p/rp", {
      "node_modules/x/index.js": "",
      "sub/main.cjs":
        "__log.push(require.resolve('x', { paths: ['.'] }), require.resolve('x', { paths: ['./'] }));",
    });
    fake.cwd = "/p/rp";
    await runEntry("/p/rp/sub/main.cjs");
    expect(log).toEqual(["/p/rp/node_modules/x/index.js", "/p/rp/node_modules/x/index.js"]);
  });

  it("names a file whose path has a space in stack traces", async () => {
    files("/p/my app", { "a.js": "__log.push(new Error('x').stack.split('\\n')[1]);" });
    await runEntry("/p/my app/a.js");
    expect(log[0]).toContain("/p/my%20app/a.js:1:");
  });

  it("names the file in a JSON parse error only, not in a read error", async () => {
    files("/p/json", {
      "bad.json": "{ nope",
      "locked.json": "{}",
      "main.cjs": [
        "for (const name of ['./bad.json', './locked.json']) {",
        "  try { require(name) } catch (error) { __log.push([error.name, error.code, error.message]) }",
        "}",
      ].join("\n"),
    });
    fake.fs.chmod("/p/json/locked.json", 0, true);
    await runEntry("/p/json/main.cjs");
    expect(log).toEqual([
      ["SyntaxError", undefined, expect.stringMatching(/^\/p\/json\/bad\.json: .*JSON/)],
      ["Error", "EACCES", "EACCES: permission denied, open '/p/json/locked.json'"],
    ]);
  });
});

describe("TypeScript and JSX", () => {
  it("compiles a .ts file with import syntax in a CommonJS package to CommonJS", async () => {
    files("/p/tsxc", {
      "package.json": '{ "name": "server", "type": "commonjs" }',
      "server.ts": [
        "import path from 'node:path';",
        "import { helper } from './helper';",
        'const pkg = require("./package.json");',
        "export const port: number = 3000;",
        "__log.push(path.join(__dirname, 'public'), pkg.name, helper(), module.exports.port);",
      ].join("\n"),
      "helper.ts": "export function helper(): string { return 'helped' }",
    });
    await runEntry("/p/tsxc/server.ts");
    expect(log).toEqual(["/p/tsxc/public", "server", "helped", 3000]);
  });

  it("compiles a .cts file to CommonJS and keeps a .mts file an ES module", async () => {
    files("/p/ctsmts", {
      "a.cts": "import { b } from './b.mts'; __log.push(typeof require, b);",
      "b.mts": "export const b: string = typeof require;",
    });
    await runEntry("/p/ctsmts/a.cts");
    expect(log).toEqual(["function", "undefined"]);
  });

  it("keeps a .ts file with import syntax in a package of no type an ES module", () => {
    write("/p/notype/a.ts", "import x from './x'; export const y = x;");
    expect(
      prepareSource("import x from './x'; export const y = x;", "/p/notype/a.ts", null).format,
    ).toBe("esm");
  });

  it("runs a CommonJS .jsx file with the JSX runtime required, not imported", async () => {
    files("/p/jsxc", {
      "node_modules/react/index.js": "module.exports = { version: 'test' };",
      "node_modules/react/jsx-dev-runtime.js":
        "exports.jsxDEV = (type, props) => ({ type, props });",
      "App.jsx":
        'const React = require("react");\nmodule.exports = function App() { return <div>hi</div>; };',
      "main.cjs": "const App = require('./App.jsx'); __log.push(App().type, App().props.children);",
    });
    await runEntry("/p/jsxc/main.cjs");
    expect(log).toEqual(["div", "hi"]);
  });

  it("throws a SyntaxError that names decorators and the file", () => {
    expect(() =>
      prepareSource(
        "function log(t: any, k: string) {}\nclass Svc { @log run() { return 1 } }",
        "/p/dec.ts",
        null,
      ),
    ).toThrow(
      new SyntaxError("TypeScript decorators are not supported in webnode (/p/dec.ts:2:13)"),
    );
  });

  it("throws for a namespace that holds values instead of dropping it", () => {
    expect(() =>
      prepareSource("namespace V { export const ok = 1 }\nglobalThis.r = V.ok;", "/p/n.ts", null),
    ).toThrow(/namespace "V" holds values.*\(\/p\/n\.ts:1:1\)/);
    expect(() =>
      prepareSource(
        "namespace A.B { export namespace C { export function f() {} } }",
        "/p/n.ts",
        null,
      ),
    ).toThrow(/namespace "C" holds values/);
  });

  it("erases namespaces of types, declare blocks and ambient modules", async () => {
    files("/p/types", {
      "main.ts": [
        "namespace Shapes { export interface Point { x: number } export type Id = string; namespace Inner { export type T = 1 } }",
        "declare namespace Lib { const version: string; function f(): void }",
        "declare global { namespace NodeJS { interface ProcessEnv { PORT?: string } } var flag: boolean }",
        "declare module 'untyped' { export const value: number }",
        "module Legacy { export type L = 1 }",
        "const p: Shapes.Point = { x: 1 };",
        "// @ts-ignore a comment with an @ sign",
        "__log.push(p.x, 'user@example.com');",
      ].join("\n"),
    });
    await runEntry("/p/types/main.ts");
    expect(log).toEqual([1, "user@example.com"]);
  });
});

describe("watch mode reports", () => {
  const reported: string[] = [];
  beforeEach(() => {
    reported.length = 0;
    configureLoader({
      loadBuiltin,
      conditions: [],
      report: (kind, filename) => reported.push(`${kind} ${filename}`),
    });
  });

  it("reports each file the program loads, before it runs, and no builtin", async () => {
    files("/p/rep", {
      "main.js": "require('./dep'); require('fs'); require('./data.json'); require('./dep');",
      "dep.js": "__log.push('dep');",
      "data.json": "{}",
      "esm.mjs": "import './leaf.mjs'; import 'node:path'; await import('./late.mjs');",
      "leaf.mjs": "",
      "late.mjs": "",
      "broken.js": "require('./throws');",
      "throws.js": "throw new Error('boom');",
    });
    runEntry("/p/rep/main.js");
    await runEntry("/p/rep/esm.mjs");
    expect(() => runEntry("/p/rep/broken.js")).toThrow("boom");
    expect(reported).toEqual([
      "require /p/rep/main.js",
      "require /p/rep/main.js",
      "require /p/rep/dep.js",
      "require /p/rep/data.json",
      "import /p/rep/esm.mjs",
      "import /p/rep/leaf.mjs",
      "import /p/rep/late.mjs",
      "require /p/rep/broken.js",
      "require /p/rep/broken.js",
      "require /p/rep/throws.js",
    ]);
  });

  it("reports what a failed require() looked for, and nothing for an import", async () => {
    files("/p/miss-rep", {
      "main.js": "try { require('./later') } catch {} try { require('pkg') } catch {}",
      "node_modules/other/index.js": "",
      "esm.mjs": "import './nope.mjs';",
    });
    runEntry("/p/miss-rep/main.js");
    const looked = (base: string) =>
      ["", ".js", ".json", ".node", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".jsx"].map(
        (extension) => `missing ${base}${extension}`,
      );
    // Only node_modules folders that exist are searched for a package.
    expect(reported).toEqual([
      "require /p/miss-rep/main.js",
      "require /p/miss-rep/main.js",
      ...looked("/p/miss-rep/later"),
      ...looked("/p/miss-rep/node_modules/pkg"),
    ]);
    reported.length = 0;
    await expect(runEntry("/p/miss-rep/esm.mjs")).rejects.toThrow(/Cannot find module/);
    expect(reported).toEqual(["import /p/miss-rep/esm.mjs"]);
  });
});

describe("source run as code (node -e, a worker's eval)", () => {
  it("evaluates an ES module in a promise job, so its ticks run after its promise jobs", async () => {
    // Real Node v26: `new Worker("import 'node:fs'; nextTick(t); then(p)", { eval: true })`
    // logs p before t; the same code as CommonJS logs t before p.
    const proc = createProcess({ loadBuiltin: () => undefined, ipc: null });
    (globalThis as { __tick?: unknown }).__tick = proc.nextTick;
    const body = "__tick(() => __log.push('t')); Promise.resolve().then(() => __log.push('p'));";
    let result: unknown;
    runMacrotask(() => {
      result = runSource(`export {}; ${body}`, "/p/[worker eval]", "esm");
      log.push("returned");
    });
    await result;
    for (let i = 0; i < 20 && log.length < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(log).toEqual(["returned", "p", "t"]);
    log.length = 0;
    runMacrotask(() => {
      runSource(body, "/p/[eval]", "cjs");
      log.push("returned");
    });
    for (let i = 0; i < 20 && log.length < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(log).toEqual(["returned", "t", "p"]);
    delete (globalThis as { __tick?: unknown }).__tick;
  });

  it("rejects, rather than throws, when the module cannot be linked", async () => {
    files("/p/eval", { "dep.mjs": "export const a = 1;" });
    const result = runSource(
      "import { b } from '/p/eval/dep.mjs'; __log.push(b);",
      "/p/eval/[worker eval]",
      "esm",
    );
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow(/does not provide an export named 'b'/);
    expect(log).toEqual([]);
  });
});
