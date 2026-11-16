// @vitest-environment node
// Differential tests: strict and loose deep equality over a table of value
// pairs, against real Node's `util.isDeepStrictEqual` and `assert.deepEqual`.
import nodeAssert from "node:assert";
import nodeUtil from "node:util";
import { describe, expect, it } from "vitest";
import { isDeepEqual, isDeepStrictEqual } from "./comparisons";

function nodeLoose(a: unknown, b: unknown): boolean {
  try {
    nodeAssert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

class Foo {
  a = 1;
}
class Bar {
  a = 1;
}

function circular(): Record<string, unknown> {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  return o;
}
function circularPair(): [Record<string, unknown>, Record<string, unknown>] {
  const a: Record<string, unknown> = { name: "a" };
  const b: Record<string, unknown> = { name: "a" };
  a.next = b;
  b.next = a;
  return [a, b];
}

const sym = Symbol("s");
const sparse1 = [1, , 3]; // eslint-disable-line no-sparse-arrays
const sparse2 = [1, undefined, 3];
const withProp = Object.assign([1, 2], { extra: true });
const errWithCode = Object.assign(new Error("x"), { code: "E1" });
const errWithOtherCode = Object.assign(new Error("x"), { code: "E2" });
const nonEnumSym = {};
Object.defineProperty(nonEnumSym, sym, { value: 1, enumerable: false });

const pairs: [string, unknown, unknown][] = [
  ["same number", 1, 1],
  ["number vs string", 1, "1"],
  ["NaN", Number.NaN, Number.NaN],
  ["+0 vs -0", 0, -0],
  ["null vs undefined", null, undefined],
  ["true vs 1", true, 1],
  ["bigint vs number", 1n, 1],
  ["strings", "a", "b"],
  ["symbols", Symbol("a"), Symbol("a")],
  ["empty objects", {}, {}],
  ["objects equal", { a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } }],
  ["objects key order", { a: 1, b: 2 }, { b: 2, a: 1 }],
  ["objects differ", { a: 1 }, { a: 2 }],
  ["objects loose value", { a: 1 }, { a: "1" }],
  ["extra key", { a: 1 }, { a: 1, b: undefined }],
  ["undefined value vs missing", { a: undefined }, {}],
  ["null proto vs object", Object.create(null), {}],
  ["class vs class", new Foo(), new Foo()],
  ["different classes", new Foo(), new Bar()],
  ["class vs plain", new Foo(), { a: 1 }],
  ["arrays", [1, 2, 3], [1, 2, 3]],
  ["arrays differ", [1, 2, 3], [1, 2, 4]],
  ["arrays loose", [1, 2], ["1", "2"]],
  ["array lengths", [1], [1, 2]],
  ["sparse vs undefined", sparse1, sparse2],
  ["sparse vs sparse", [1, , 3], [1, , 3]], // eslint-disable-line no-sparse-arrays
  ["array extra prop", withProp, [1, 2]],
  ["array vs object", [1], { 0: 1 }],
  ["array vs arguments-like", [], { length: 0 }],
  ["symbol keys equal", { [sym]: 1 }, { [sym]: 1 }],
  ["symbol keys differ", { [sym]: 1 }, { [sym]: 2 }],
  ["symbol key missing", { [sym]: 1 }, {}],
  ["non-enumerable symbol", nonEnumSym, {}],
  ["dates equal", new Date(0), new Date(0)],
  ["dates differ", new Date(0), new Date(1)],
  ["date vs object", new Date(0), {}],
  ["date with prop", Object.assign(new Date(0), { x: 1 }), new Date(0)],
  ["regexps", /a/g, /a/g],
  ["regexp flags", /a/g, /a/i],
  ["regexp lastIndex", Object.assign(/a/g, { lastIndex: 3 }), /a/g],
  ["regexp vs object", /a/, {}],
  ["errors same", new Error("x"), new Error("x")],
  ["errors message", new Error("x"), new Error("y")],
  ["errors type", new Error("x"), new TypeError("x")],
  ["errors code", errWithCode, errWithOtherCode],
  ["errors cause", new Error("x", { cause: 1 }), new Error("x", { cause: 2 })],
  ["errors cause missing", new Error("x", { cause: undefined }), new Error("x")],
  ["errors cause equal", new Error("x", { cause: { a: 1 } }), new Error("x", { cause: { a: 1 } })],
  ["aggregate errors", new AggregateError([1], "m"), new AggregateError([2], "m")],
  ["boxed numbers", new Number(1), new Number(1)],
  ["boxed numbers differ", new Number(1), new Number(2)],
  ["boxed vs primitive", new Number(1), 1],
  ["boxed strings", new String("a"), new String("a")],
  ["boxed string differ", new String("a"), new String("b")],
  ["boxed booleans", new Boolean(true), new Boolean(false)],
  ["boxed bigint", Object(1n), Object(1n)],
  ["boxed symbol", Object(sym), Object(sym)],
  ["boxed vs object", new Number(1), {}],
  ["maps equal", new Map([[1, "a"]]), new Map([[1, "a"]])],
  ["maps differ", new Map([[1, "a"]]), new Map([[1, "b"]])],
  ["maps loose keys", new Map([[1, "a"]]), new Map([["1", "a"]])],
  ["maps object keys", new Map([[{ a: 1 }, "x"]]), new Map([[{ a: 1 }, "x"]])],
  [
    "maps object keys swapped",
    new Map([
      [{}, "a"],
      [{}, "b"],
    ]),
    new Map([
      [{}, "b"],
      [{}, "a"],
    ]),
  ],
  ["maps size", new Map([[1, 1]]), new Map()],
  ["map vs object", new Map(), {}],
  ["sets equal", new Set([1, 2]), new Set([2, 1])],
  ["sets differ", new Set([1, 2]), new Set([1, 3])],
  ["sets loose", new Set([1]), new Set(["1"])],
  ["sets objects", new Set([{ a: 1 }, { b: 2 }]), new Set([{ b: 2 }, { a: 1 }])],
  ["sets objects differ", new Set([{ a: 1 }]), new Set([{ a: 2 }])],
  ["sets null/undefined loose", new Set([null]), new Set([undefined])],
  ["set vs array", new Set([1]), [1]],
  ["typed arrays", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  ["typed arrays differ", new Uint8Array([1, 2]), new Uint8Array([1, 3])],
  ["typed array kinds", new Uint8Array([1]), new Int8Array([1])],
  ["float -0", new Float64Array([0]), new Float64Array([-0])],
  ["float NaN", new Float32Array([Number.NaN]), new Float32Array([Number.NaN])],
  ["buffer vs uint8", Buffer.from([1]), new Uint8Array([1])],
  ["buffers", Buffer.from("ab"), Buffer.from("ab")],
  ["array buffers", new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer],
  ["array buffers differ", new Uint8Array([1, 2]).buffer, new Uint8Array([1, 3]).buffer],
  ["shared vs array buffer", new SharedArrayBuffer(1), new ArrayBuffer(1)],
  ["dataviews", new DataView(new ArrayBuffer(2)), new DataView(new ArrayBuffer(2))],
  ["circular self", circular(), circular()],
  ["circular pair", ...circularPair()],
  ["functions same", Math.max, Math.max],
  ["functions differ", () => 1, () => 1],
  [
    "nested deep",
    { a: [{ b: new Map([[1, new Set([1])]]) }] },
    { a: [{ b: new Map([[1, new Set([1])]]) }] },
  ],
  ["object vs null", {}, null],
];

// Not in the table: two distinct Promises (or WeakMaps). Newer Node compares
// those by identity; Node 22 compares their (empty) own keys, as this module does.

describe("isDeepStrictEqual", () => {
  for (const [label, a, b] of pairs) {
    it(`${label}`, () => {
      expect(isDeepStrictEqual(a, b)).toBe(nodeUtil.isDeepStrictEqual(a, b));
      expect(isDeepStrictEqual(b, a)).toBe(nodeUtil.isDeepStrictEqual(b, a));
    });
  }
});

describe("isDeepEqual (loose)", () => {
  for (const [label, a, b] of pairs) {
    it(`${label}`, () => {
      expect(isDeepEqual(a, b)).toBe(nodeLoose(a, b));
      expect(isDeepEqual(b, a)).toBe(nodeLoose(b, a));
    });
  }
});
