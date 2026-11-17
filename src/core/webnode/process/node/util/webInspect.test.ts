// @vitest-environment node
// How `util.inspect` prints objects whose state the browser hides. Node's own
// web classes carry an `inspect.custom`; Chrome's do not. Each test takes
// Node's hook off a class (leaving the Chrome shape: state behind prototype
// accessors), installs ours, and compares with what Node printed.
import nodeUtil from "node:util";
import { describe, expect, it } from "vitest";
import util from "../util";
import { installWebInspectors } from "./webInspect";

const custom = Symbol.for("nodejs.util.inspect.custom");

/** Prints `value` with our hook in place of Node's on `ctor`, then puts Node's back. */
function inspectWithOurHook(
  ctor: { prototype: object; name: string },
  value: unknown,
  options?: object,
): string {
  const proto = ctor.prototype as Record<symbol, unknown>;
  const nodeHook = Object.getOwnPropertyDescriptor(proto, custom)!;
  delete proto[custom];
  try {
    installWebInspectors({ [ctor.name]: ctor });
    return util.inspect(value, options);
  } finally {
    Object.defineProperty(proto, custom, nodeHook);
  }
}

describe("web platform classes", () => {
  const ac = new AbortController();
  const form = new FormData();
  form.append("a", "1");
  form.append("a", "2");
  form.append("b", "3");
  const cases: [{ prototype: object; name: string }, () => unknown][] = [
    [URL, () => new URL("http://user:pw@a.com:8080/b?c=1#h")],
    [URLSearchParams, () => new URLSearchParams("a=1&b=2&a=3")],
    [URLSearchParams, () => new URLSearchParams()],
    [URLSearchParams, () => new URLSearchParams(`a=${"x".repeat(90)}&b=2`)],
    [Headers, () => new Headers({ a: "1", "content-type": "x" })],
    [Headers, () => new Headers()],
    [FormData, () => form],
    [Blob, () => new Blob(["hi"], { type: "text/plain" })],
    [File, () => new File(["hi"], "f.txt", { type: "text/plain", lastModified: 5 })],
    [AbortSignal, () => ac.signal],
    [AbortController, () => ac],
    [TextEncoder, () => new TextEncoder()],
    [TextDecoder, () => new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true })],
    [Event, () => new Event("foo", { cancelable: true })],
    [Request, () => new Request("http://a.com/x", { method: "POST", headers: { a: "1" } })],
    [Response, () => new Response("hi", { status: 201, headers: { a: "1" } })],
  ];
  for (const [ctor, make] of cases) {
    it(`prints ${ctor.name} like Node`, () => {
      const value = make();
      for (const wrap of [(v: unknown) => v, (v: unknown) => ({ nested: v })]) {
        const theirs = nodeUtil.inspect(wrap(value));
        expect(inspectWithOurHook(ctor, wrap(value))).toBe(theirs);
      }
    });
  }

  it("keeps a hook a class already has", () => {
    class Own {
      [custom]() {
        return "mine";
      }
    }
    installWebInspectors({ URL: Own });
    expect(util.inspect(new Own())).toBe("mine");
  });
});

describe("state the browser hides", () => {
  it("does not claim a promise is pending", () => {
    expect(util.inspect(Promise.resolve(3))).toBe("Promise { <state unknown> }");
    expect(util.inspect({ p: new Promise(() => {}) })).toBe("{ p: Promise { <state unknown> } }");
    expect(util.inspect(Object.assign(Promise.resolve(), { a: 1 }))).toBe(
      "Promise { <state unknown>, a: 1 }",
    );
    class MyPromise extends Promise<void> {}
    expect(util.inspect(MyPromise.resolve())).toBe("MyPromise [Promise] { <state unknown> }");
    expect(util.format("%o", Promise.resolve(1))).toBe("Promise { <state unknown> }");
    expect(util.inspect({ a: { b: { c: Promise.resolve() } } })).toBe(
      "{ a: { b: { c: [Promise] } } }",
    );
  });

  it("does not print iterators and weak collections as empty", () => {
    expect(util.inspect(new Map([[1, 2]]).entries())).toBe("[Map Iterator] { <items unknown> }");
    expect(util.inspect(new Set([1]).values())).toBe("[Set Iterator] { <items unknown> }");
    expect(util.inspect(new WeakMap(), { showHidden: true })).toBe("WeakMap { <items unknown> }");
    expect(util.inspect(new WeakSet())).toBe(nodeUtil.inspect(new WeakSet()));
    expect(util.inspect(new Set([1]).values(), { compact: false })).toBe(
      "[Set Iterator] {\n  <items unknown>\n}",
    );
    expect(util.inspect([Promise.resolve()], { compact: false })).toBe(
      "[\n  Promise {\n    <state unknown>\n  }\n]",
    );
  });

  it("leaves the built-in prototypes as they were", () => {
    util.inspect([Promise.resolve(), new Map().keys(), new WeakMap()]);
    for (const proto of [
      Promise.prototype,
      Object.getPrototypeOf(new Map().keys()),
      Object.getPrototypeOf(new Set().keys()),
      WeakMap.prototype,
      WeakSet.prototype,
    ]) {
      expect(Object.getOwnPropertySymbols(proto)).not.toContain(custom);
    }
  });

  it("prints a promise inside a custom inspector's own inspect call", () => {
    const value = {
      [custom]: (_depth: number, options: object, inspect: typeof util.inspect) =>
        `X ${inspect(Promise.resolve(), options)}`,
    };
    expect(util.inspect(value)).toBe("X Promise { <state unknown> }");
  });
});
