// @vitest-environment node
// The Rust rewriter against sucrase, through the loader: each module here is
// loaded twice, once from an entry the Rust rewriter made and once rewritten
// by sucrase, and must behave the same.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { loadBuiltin } from "../../node/index";
import { setRuntime } from "../../runtime";
import { createFakeRuntime, type FakeRuntime } from "../../testing/fakeRuntime";
import { configureLoader, importModule } from "../modules";
import { PREPARED_MIN_BYTES, encodePreparedEntry } from "../preparedEntry";
import { prepareSource, transformReady } from "../transform";
import { RewriteDeclined, loadRewriter } from "./rewriter";

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

let rewrite: (text: string) => string;

beforeAll(async () => {
  await transformReady;
  rewrite = await loadRewriter();
});

afterEach(() => {
  setRuntime(null);
});

function write(fake: FakeRuntime, path: string, data: string | Uint8Array): void {
  fake.fs.mkdir(path.slice(0, path.lastIndexOf("/")), true, 0o755);
  fake.fs.writeFile(
    path,
    typeof data === "string" ? new TextEncoder().encode(data) : data,
    O_WRONLY | O_CREAT | O_TRUNC,
    0o644,
  );
}

/** Large enough for the loader to ask for an entry: the padding is a comment at the end. */
const padded = (source: string) => `${source}\n// ${"x".repeat(PREPARED_MIN_BYTES)}\n`;

let scenario = 0;

/**
 * What `main.mjs` of `files` exports as `seen` (a function, awaited), with
 * `main.mjs` rewritten by the Rust rewriter or by sucrase. The other files are
 * rewritten by sucrase either way.
 */
async function seenWith(files: Record<string, string>, byRust: boolean): Promise<unknown> {
  scenario += 1;
  const directory = `/p/node_modules/${byRust ? "rust" : "plain"}-${scenario}`;
  const main = `${directory}/main.mjs`;
  const entry = `/entries/${scenario}`;
  const fake = createFakeRuntime({
    cwd: "/p",
    preparedEntry: (filename) => (byRust && filename === main ? entry : null),
  });
  setRuntime(fake);
  configureLoader({ loadBuiltin, conditions: [] });
  for (const [name, source] of Object.entries(files)) {
    write(fake, `${directory}/${name}`, name === "main.mjs" ? padded(source) : source);
  }
  if (byRust) {
    write(
      fake,
      entry,
      encodePreparedEntry(prepareSource(padded(files["main.mjs"]), main, "esm", rewrite)),
    );
  }
  const namespace = await importModule(main, "/p/start.mjs");
  return JSON.parse(JSON.stringify(await (namespace.seen as () => unknown)()));
}

async function bothWays(
  files: Record<string, string>,
): Promise<{ rust: unknown; sucrase: unknown }> {
  return { rust: await seenWith(files, true), sucrase: await seenWith(files, false) };
}

/** The two results of `bothWays`, when they are the same one. */
function agreed(seen: { rust: unknown; sucrase: unknown }): unknown {
  expect(seen.rust).toEqual(seen.sucrase);
  return seen.rust;
}

describe("imports", () => {
  it("default, named, renamed and namespace, from ES modules and CommonJS", async () => {
    expect(
      agreed(
        await bothWays({
          "esm.mjs":
            "export default 'd'; export const a = 1; export function b() { return this === undefined; }",
          "cjs.cjs": "module.exports = { a: 2, b() { return 'cjs'; } };",
          "main.mjs": [
            "import d, { a, b as renamed } from './esm.mjs';",
            "import * as all from './esm.mjs';",
            "import cjs, { a as cjsA } from './cjs.cjs';",
            "import * as cjsAll from './cjs.cjs';",
            "import { default as again } from './esm.mjs';",
            "import './esm.mjs';",
            "export const seen = () => [d, a, renamed(), all.a, all.default, Object.keys(all).sort(),",
            "  cjs.a, cjsA, cjs.b(), cjsAll.a, typeof cjsAll.default, again];",
          ].join("\n"),
        }),
      ),
    ).toEqual(["d", 1, true, 1, "d", ["a", "b", "default"], 2, 2, "cjs", 2, "object", "d"]);
  });

  it("every place an imported name is used", async () => {
    expect(
      agreed(
        await bothWays({
          "dep.mjs": [
            "export const value = 5;",
            "export function fn(...args) { return [this === undefined, ...args]; }",
            "export class Thing { constructor(x) { this.x = x; } }",
            "export const tag = (strings, ...values) => strings.raw.join('|') + values.join(',');",
            "export const object = { method() { return this === object; }, nested: { deep: 1 } };",
          ].join("\n"),
          "main.mjs": [
            "import { value, fn, Thing, tag, object } from './dep.mjs';",
            "const shorthand = { value, fn };",
            "function defaults(a = value, { b = value } = {}) { return a + b; }",
            "class Sub extends Thing { static held = value; field = value; get v() { return value; } }",
            "export const seen = () => [",
            "  value, fn(1, 2), (fn)(3), (0, fn)(4), fn.call(null, 5), fn?.(6), new Thing(7).x,",
            "  tag`a${value}b`, object.method(), object.nested.deep, object?.nested?.deep,",
            "  shorthand.value, shorthand.fn(8), defaults(), typeof value, typeof fn,",
            "  new Sub(9).field, Sub.held, new Sub(1).v, `${value}`, [value, ...[value]], -value, !value,",
            "  value ? 'y' : 'n', value > 1 && value, { [value]: value }[5], [fn][0](10),",
            "  (() => value)(), (function () { return value; })(), fn`x`.length,",
            "];",
          ].join("\n"),
        }),
      ),
    ).toBeDefined();
  });

  it("a name of the module's own that hides an imported one", async () => {
    expect(
      agreed(
        await bothWays({
          "dep.mjs":
            "export const a = 'import'; export const b = 'import'; export const c = 'import';",
          "main.mjs": [
            "import { a, b, c } from './dep.mjs';",
            "function param(a) { return a; }",
            "function local() { const a = 'const'; { let b = 'let'; return [a, b, c]; } }",
            "function hoisted() { const before = typeof b; var b = 'var'; return [before, b]; }",
            "function caught() { try { throw 'thrown'; } catch (a) { return a; } }",
            "function looped() { const out = []; for (const a of ['of']) out.push(a); for (let b = 0; b < 1; b++) out.push(b); return out; }",
            "function destructured({ a, x: [b] }) { return [a, b]; }",
            "const arrow = (c) => c;",
            "class Named { a() { return a; } static c = c; }",
            "function inner() { function a() { return 'fn'; } return a(); }",
            "const object = { a: 'key', b() { return b; }, get c() { return c; } };",
            "export const seen = () => [a, param('param'), local(), hoisted(), caught(), looped(),",
            "  destructured({ a: 'da', x: ['db'] }), arrow('arrow'), new Named().a(), Named.c, inner(),",
            "  object.a, object.b(), object.c];",
          ].join("\n"),
        }),
      ),
    ).toEqual([
      "import",
      "param",
      ["const", "let", "import"],
      ["undefined", "var"],
      "thrown",
      ["of", 0],
      ["da", "db"],
      "arrow",
      "import",
      "import",
      "fn",
      "key",
      "import",
      "import",
    ]);
  });

  it("a binding the exporting module changes later is read live", async () => {
    expect(
      agreed(
        await bothWays({
          "dep.mjs": "export let count = 0; export function bump() { count += 1; }",
          "main.mjs": [
            "import { count, bump } from './dep.mjs';",
            "export const seen = () => { const before = count; bump(); bump(); return [before, count]; };",
          ].join("\n"),
        }),
      ),
    ).toEqual([0, 2]);
  });

  it("code without semicolons, a call first on its line", async () => {
    expect(
      agreed(
        await bothWays({
          "dep.mjs": "export const log = []; export function note(x) { log.push(x) }",
          "main.mjs": [
            "import { log, note } from './dep.mjs'",
            "const a = 1",
            "note(a)",
            "const b = [2]",
            "note(b[0])",
            "let c = a",
            "note(c)",
            "export const seen = () => log",
          ].join("\n"),
        }),
      ),
    ).toEqual([1, 2, 1]);
  });
});

describe("exports", () => {
  it("each kind of declaration, a list, a default", async () => {
    expect(
      agreed(
        await bothWays({
          "main.mjs": [
            "export const one = 1;",
            "export const two = 2;",
            "export let three = 3;",
            "export var four = 4;",
            "export function five() { return 5; }",
            "export async function six() { return 6; }",
            "export function* seven() { yield 7; }",
            "export class Eight { static n = 8; }",
            "const nine = 9, ten = 10;",
            "export { nine, ten as renamed, nine as alsoNine };",
            "export default class Named { static n = 11; }",
            "import * as self from './main.mjs';",
            "export const seen = async () => [self.one, self.two, self.three, self.four, self.five(),",
            "  await self.six(), [...self.seven()], self.Eight.n, self.nine, self.renamed, self.alsoNine,",
            "  self.default.n, self.default.name, Object.keys(self).sort()];",
          ].join("\n"),
        }),
      ),
    ).toBeDefined();
  });

  it("a default that is an expression, a function, a class without a name", async () => {
    for (const body of [
      "export default 40 + 2;",
      "export default function () { return 'anonymous'; }",
      "export default function named() { return named.name; }",
      "export default async function () { return 'async'; }",
      "export default class { static n = 1; }",
      "export default (() => 'arrow');",
      "export default { a: 1 };",
      "const local = 'local'; export { local as default };",
    ]) {
      expect(
        agreed(
          await bothWays({
            "main.mjs": [
              body,
              "import * as self from './main.mjs';",
              "export const seen = async () => {",
              "  const value = self.default;",
              "  return [typeof value, typeof value === 'function' && !/^class/.test(String(value)) ? await value() : value, value?.n];",
              "};",
            ].join("\n"),
          }),
        ),
      ).toBeDefined();
    }
  });

  it("names taken from another module, one by one, all, and all under a name", async () => {
    expect(
      agreed(
        await bothWays({
          "dep.mjs":
            "export default 'd'; export const a = 1; export const b = 2; export let live = 0; export const grow = () => { live += 1; };",
          "other.mjs":
            "export const c = 3; export const a = 'shadowed by the module that names it first';",
          "main.mjs": [
            "export { a, b as renamed, default as fromDefault, live, grow } from './dep.mjs';",
            "export { default } from './dep.mjs';",
            "export * from './other.mjs';",
            "export * as everything from './dep.mjs';",
            "import { c as imported } from './other.mjs';",
            "export { imported };",
            "import * as self from './main.mjs';",
            "export const seen = () => { self.grow(); return [self.a, self.renamed, self.fromDefault,",
            "  self.default, self.c, self.everything.b, self.everything.default, self.imported, self.live,",
            "  Object.keys(self).sort()]; };",
          ].join("\n"),
        }),
      ),
    ).toBeDefined();
  });

  it("a binding assigned after it was exported, each way sucrase follows", async () => {
    expect(
      agreed(
        await bothWays({
          "main.mjs": [
            "export let count = 0;",
            "let other = 10;",
            "export { other, other as alias };",
            "var Kind;",
            "(function (Kind) { Kind[(Kind.A = 0)] = 'A'; })(Kind || (Kind = {}));",
            "export { Kind };",
            "export function change() {",
            "  count = 5;",
            "  count += 2;",
            "  ++count;",
            "  count--;",
            "  other *= 2;",
            "  const seenInside = [count++, --other, (count ||= 1)];",
            "  return seenInside;",
            "}",
            "import * as self from './main.mjs';",
            "export const seen = () => [self.count, self.other, self.alias, self.Kind, change(),",
            "  self.count, self.other, self.alias];",
          ].join("\n"),
        }),
      ),
    ).toEqual([0, 10, 10, { 0: "A", A: 0 }, [7, 19, 8], 8, 19, 19]);
  });

  it("functions a module in a cycle calls before this one has run", async () => {
    expect(
      agreed(
        await bothWays({
          "other.mjs": [
            "import { early, value } from './main.mjs';",
            "export const atStart = [early(), typeof value];",
          ].join("\n"),
          "main.mjs": [
            "import { atStart } from './other.mjs';",
            "export function early() { return 'hoisted'; }",
            "export const value = 1;",
            "export const seen = () => atStart;",
          ].join("\n"),
        }),
      ),
    ).toBeDefined();
  });

  it("import() and import.meta beside them", async () => {
    expect(
      agreed(
        await bothWays({
          "lazy.mjs": "export const lazy = 'loaded';",
          "main.mjs": [
            "import { lazy as now } from './lazy.mjs';",
            "export const seen = async () => [now, (await import('./lazy.mjs')).lazy,",
            "  import.meta.url.endsWith('/main.mjs'), typeof import.meta.dirname];",
          ].join("\n"),
        }),
      ),
    ).toBeDefined();
  });
});

describe("what sucrase gets wrong and the rewriter does not", () => {
  it("several names exported by one declaration", async () => {
    const files = {
      "main.mjs": [
        "export const one = 1, two = 2;",
        "import * as self from './main.mjs';",
        "export const seen = () => [self.one, self.two];",
      ].join("\n"),
    };
    expect(await seenWith(files, true)).toEqual([1, 2]);
    await expect(seenWith(files, false)).rejects.toThrow(ReferenceError);
  });

  it("a label spelled like an imported name", async () => {
    const files = {
      "dep.mjs": "export const a = 'import';",
      "main.mjs": [
        "import { a } from './dep.mjs';",
        "export const seen = () => { a: for (;;) { break a; } return a; };",
      ].join("\n"),
    };
    expect(await seenWith(files, true)).toBe("import");
    await expect(seenWith(files, false)).rejects.toThrow(SyntaxError);
  });
});

describe("a module the rewriter leaves to sucrase", () => {
  const declined = (source: string) => {
    try {
      rewrite(source);
    } catch (error) {
      return error instanceof RewriteDeclined;
    }
    return false;
  };

  it("is one that assigns an exported binding by a pattern, exports a destructuring, or does not parse", () => {
    expect(declined("export let a = 1; [a] = [2];")).toBe(true);
    expect(declined("let a = 1; export { a }; for (a of [2]) {}")).toBe(true);
    expect(declined("export const { a, b } = {};")).toBe(true);
    expect(declined("export const a = ;")).toBe(true);
    expect(declined("import { a } from 'x'; const __wnr_m0 = a;")).toBe(true);
    expect(declined("export const a = 1;")).toBe(false);
  });
});

describe("the rewritten code", () => {
  it("keeps every line where it was", () => {
    const source = [
      "import {",
      "  a,",
      "  b,",
      "} from './dep.mjs';",
      "export {",
      "  a,",
      "};",
      "export const here = () => new Error('here').stack;",
      "export default b;",
    ].join("\n");
    const code = rewrite(source);
    expect(code.split("\n")).toHaveLength(source.split("\n").length);
    expect(code.split("\n")[7]).toContain("new Error('here')");
  });
});
