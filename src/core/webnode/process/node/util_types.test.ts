// @vitest-environment node
// Differential tests: every `util/types` check over a table of values, against
// real Node's `node:util/types`.
import * as nodeTypes from "node:util/types";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import types from "./util_types";

function args(..._rest: unknown[]): IArguments {
  // eslint-disable-next-line prefer-rest-params
  return arguments;
}

class MyError extends TypeError {}
class MyMap extends Map {}
class MyArray extends Uint8Array {}
async function asyncFn(): Promise<void> {}
function* genFn(): Generator<number> {
  yield 1;
}
async function* asyncGenFn(): AsyncGenerator<number> {
  yield 1;
}

const otherRealm = vm.runInNewContext(`({
  date: new Date(0),
  regexp: /x/g,
  error: new RangeError("x"),
  map: new Map([[1, 2]]),
  set: new Set([1]),
  weakMap: new WeakMap(),
  weakSet: new WeakSet(),
  promise: Promise.resolve(1),
  u8: new Uint8Array(2),
  f64: new Float64Array(2),
  ab: new ArrayBuffer(4),
  dv: new DataView(new ArrayBuffer(4)),
  asyncFn: async () => {},
  genFn: function* () {},
  num: new Number(1),
  args: (function () { return arguments; })(1, 2),
  mapIter: new Map().keys(),
  setIter: new Set().values(),
})`) as Record<string, unknown>;

const fakeDate = Object.create(Date.prototype) as object;
const fakeTagged = { [Symbol.toStringTag]: "Date" };
const fakeError = { [Symbol.toStringTag]: "Error", message: "x", name: "Error" };
const taggedError = Object.assign(new Error("x"), { [Symbol.toStringTag]: "Nope" });
// eslint-disable-next-line unicorn/no-thenable
const fakePromise = { then() {}, [Symbol.toStringTag]: "Promise" };

const values: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["number", 1],
  ["string", "s"],
  ["boolean", true],
  ["bigint", 1n],
  ["symbol", Symbol("s")],
  ["object", {}],
  ["null-proto object", Object.create(null)],
  ["array", [1, 2]],
  ["function", function named() {}],
  ["arrow", () => {}],
  ["class", class Foo {}],
  ["date", new Date()],
  ["invalid date", new Date(Number.NaN)],
  ["fake date", fakeDate],
  ["tagged object", fakeTagged],
  ["regexp", /a/],
  ["RegExp.prototype", RegExp.prototype],
  ["error", new Error("x")],
  ["subclass error", new MyError("x")],
  ["fake error", fakeError],
  ["tagged error", taggedError],
  ["Error.prototype", Error.prototype],
  ["map", new Map()],
  ["subclass map", new MyMap()],
  ["set", new Set()],
  ["weakmap", new WeakMap()],
  ["weakset", new WeakSet()],
  ["promise", Promise.resolve()],
  ["fake promise", fakePromise],
  // eslint-disable-next-line unicorn/no-thenable
  ["thenable", { then() {} }],
  ["map iterator", new Map().entries()],
  ["set iterator", new Set().values()],
  ["array iterator", [].values()],
  ["Uint8Array", new Uint8Array(1)],
  ["Uint8 subclass", new MyArray(1)],
  ["Buffer", Buffer.from("x")],
  ["Uint8ClampedArray", new Uint8ClampedArray(1)],
  ["Uint16Array", new Uint16Array(1)],
  ["Uint32Array", new Uint32Array(1)],
  ["Int8Array", new Int8Array(1)],
  ["Int16Array", new Int16Array(1)],
  ["Int32Array", new Int32Array(1)],
  ["Float32Array", new Float32Array(1)],
  ["Float64Array", new Float64Array(1)],
  ["BigInt64Array", new BigInt64Array(1)],
  ["BigUint64Array", new BigUint64Array(1)],
  ["ArrayBuffer", new ArrayBuffer(1)],
  ["SharedArrayBuffer", new SharedArrayBuffer(1)],
  ["DataView", new DataView(new ArrayBuffer(1))],
  ["async function", asyncFn],
  ["async arrow", async () => {}],
  ["generator function", genFn],
  ["async generator function", asyncGenFn],
  ["generator object", genFn()],
  ["async generator object", asyncGenFn()],
  ["Number object", new Number(1)],
  ["String object", new String("s")],
  ["Boolean object", new Boolean(false)],
  ["BigInt object", Object(1n)],
  ["Symbol object", Object(Symbol("x"))],
  ["arguments", args(1, 2)],
  ["array-like", { length: 0, callee() {} }],
  ["module namespace", types],
  ["frozen null-proto tagged", Object.freeze(Object.create(null, {}))],
  ...Object.entries(otherRealm).map(
    ([name, value]) => [`realm ${name}`, value] as [string, unknown],
  ),
];

if (typeof (globalThis as { Float16Array?: unknown }).Float16Array === "function") {
  const F16 = (globalThis as unknown as { Float16Array: new (n: number) => unknown }).Float16Array;
  values.push(["Float16Array", new F16(1)]);
}

// Node classifies these by internals a page cannot see.
const skipped = new Set([
  // A Proxy is indistinguishable from its target here.
  "isProxy",
  "isExternal",
  "isKeyObject",
  // Our namespace object comes from Vite's module transform, not V8.
  "isModuleNamespaceObject",
]);

describe("util/types", () => {
  it("has the same members as Node's", () => {
    expect(Object.keys(types).sort()).toEqual(
      Object.keys(nodeTypes)
        .filter((key) => key !== "default")
        .sort(),
    );
  });

  for (const name of Object.keys(types)) {
    if (skipped.has(name)) {
      continue;
    }
    it(`${name} classifies like Node`, () => {
      const ours = (types as Record<string, (v: unknown) => boolean>)[name];
      const theirs = (nodeTypes as unknown as Record<string, (v: unknown) => boolean>)[name];
      for (const [label, value] of values) {
        if (name === "isPromise" && label === "fake promise") {
          // No side-effect-free brand check exists for promises.
          continue;
        }
        expect([label, ours(value)]).toEqual([label, theirs(value)]);
      }
    });
  }

  it("isProxy, isExternal and isKeyObject report false", () => {
    expect(types.isProxy(new Proxy({}, {}))).toBe(false);
    expect(types.isExternal({})).toBe(false);
    expect(types.isKeyObject({})).toBe(false);
  });

  it("isModuleNamespaceObject recognises the shape of a namespace object", () => {
    // Under vitest `import()` returns the runner's own module object, so the
    // check runs on an object shaped like V8's namespace objects.
    const ns = Object.preventExtensions(
      Object.create(null, { [Symbol.toStringTag]: { value: "Module" } }),
    );
    expect(types.isModuleNamespaceObject(ns)).toBe(true);
    expect(types.isModuleNamespaceObject({ [Symbol.toStringTag]: "Module" })).toBe(false);
    expect(types.isModuleNamespaceObject({})).toBe(false);
  });

  it("isCryptoKey recognises a WebCrypto key", async () => {
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    expect(types.isCryptoKey(key)).toBe(true);
    expect(types.isCryptoKey({})).toBe(false);
  });
});
