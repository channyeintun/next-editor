// @vitest-environment node
// Differential tests: each assert member over a table of calls, against real
// Node's `node:assert` — whether it throws, the error class, `code`,
// `operator`, `generatedMessage`, `actual`/`expected`, and the first line of
// the message.
import nodeAssert from "node:assert";
import nodeAssertStrict from "node:assert/strict";
import { describe, expect, it } from "vitest";
import assert from "./assert";
import assertStrict from "./assert_strict";

type Outcome =
  | { threw: false }
  | {
      threw: true;
      name: string;
      code: unknown;
      operator?: unknown;
      generatedMessage?: unknown;
      firstLine: string;
      actualIsSame?: boolean;
      expectedIsSame?: boolean;
    };

function describeError(error: unknown, actual?: unknown, expected?: unknown): Outcome {
  if (!(error instanceof Error)) {
    return { threw: true, name: typeof error, code: undefined, firstLine: String(error) };
  }
  const e = error as Error & {
    code?: unknown;
    operator?: unknown;
    generatedMessage?: unknown;
    actual?: unknown;
    expected?: unknown;
  };
  const isAssertion = e.code === "ERR_ASSERTION";
  return {
    threw: true,
    name: e.name,
    code: e.code,
    ...(isAssertion
      ? {
          operator: e.operator,
          generatedMessage: e.generatedMessage,
          actualIsSame: e.actual === actual,
          expectedIsSame: e.expected === expected,
        }
      : {}),
    firstLine: e.message.split("\n")[0],
  };
}

/** 0 … n-1 with the entries at `at` replaced by their negation minus one. */
function changed(n: number, at: number[]): number[] {
  return Array.from({ length: n }, (_, i) => (at.includes(i) ? -i - 1 : i));
}

function run(fn: () => void, actual?: unknown, expected?: unknown): Outcome {
  try {
    fn();
    return { threw: false };
  } catch (error) {
    return describeError(error, actual, expected);
  }
}

async function runAsync(fn: () => Promise<void>): Promise<Outcome> {
  try {
    await fn();
    return { threw: false };
  } catch (error) {
    return describeError(error);
  }
}

type Assert = typeof nodeAssert;
const obj = { a: 1 };
const comparisons: [string, unknown, unknown][] = [
  ["equal numbers", 1, 1],
  ["unequal numbers", 1, 2],
  ["loose equal", 1, "1"],
  ["NaN", Number.NaN, Number.NaN],
  ["zeros", 0, -0],
  ["null undefined", null, undefined],
  ["same object", obj, obj],
  ["equal objects", { a: 1 }, { a: 1 }],
  ["loose objects", { a: 1 }, { a: "1" }],
  ["unequal objects", { a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }],
  ["long strings", "a".repeat(30), "b".repeat(30)],
  ["similar strings", "hello world foo", "hello world bar"],
  ["strings", "a", "b"],
  [
    "multi-line objects",
    { a: 1, b: 2, c: 3, d: { e: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } },
    { a: 1, b: 2, c: 4, d: { e: [1, 2, 3] } },
  ],
  ["functions", () => 1, () => 1],
  ["dates", new Date(0), new Date(0)],
  ["maps", new Map([[1, 2]]), new Map([[1, 3]])],
  ["arrays same structure", [1, 2], [1, 2]],
];

const methods = [
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
] as const;

describe("comparison assertions", () => {
  for (const method of methods) {
    it(`${method} matches Node`, () => {
      for (const [label, actual, expected] of comparisons) {
        const ours = run(
          () => (assert[method] as (a: unknown, b: unknown) => void)(actual, expected),
          actual,
          expected,
        );
        const theirs = run(
          () => (nodeAssert[method] as (a: unknown, b: unknown) => void)(actual, expected),
          actual,
          expected,
        );
        expect([label, ours]).toEqual([label, theirs]);
      }
    });

    it(`${method} with a message or an Error`, () => {
      const [actual, expected] = method.startsWith("not") ? [1, 1] : [1, 2];
      const call = (a: Assert | typeof assert, message: unknown) =>
        run(() =>
          (a[method] as (x: unknown, y: unknown, m: unknown) => void)(actual, expected, message),
        );
      expect(call(assert, "custom")).toEqual(call(nodeAssert, "custom"));
      const error = new RangeError("mine");
      expect(call(assert, error)).toEqual(call(nodeAssert, error));
    });

    it(`${method} requires two arguments`, () => {
      const ours = run(() => (assert[method] as (a?: unknown) => void)(1));
      const theirs = run(() => (nodeAssert[method] as (a?: unknown) => void)(1));
      expect(ours).toEqual(theirs);
    });
  }
});

describe("ok / assert()", () => {
  const cases: [string, unknown[]][] = [
    ["truthy", [1]],
    ["falsy with message", [0, "nope"]],
    ["falsy with error", [0, new TypeError("t")]],
    ["no arguments", []],
  ];
  for (const [label, args] of cases) {
    it(`${label}`, () => {
      expect(run(() => (assert.ok as (...a: unknown[]) => void)(...args))).toEqual(
        run(() => (nodeAssert.ok as (...a: unknown[]) => void)(...args)),
      );
      expect(run(() => (assert as (...a: unknown[]) => void)(...args))).toEqual(
        run(() => (nodeAssert as (...a: unknown[]) => void)(...args)),
      );
    });
  }

  it("falsy without a message is a generated == failure", () => {
    const outcome = run(() => assert(false));
    expect(outcome).toMatchObject({
      threw: true,
      code: "ERR_ASSERTION",
      operator: "==",
      generatedMessage: true,
    });
  });
});

describe("fail", () => {
  it("matches Node", () => {
    expect(run(() => assert.fail())).toEqual(run(() => nodeAssert.fail()));
    expect(run(() => assert.fail("boom"))).toEqual(run(() => nodeAssert.fail("boom")));
    const error = new TypeError("e");
    expect(run(() => assert.fail(error))).toEqual(run(() => nodeAssert.fail(error)));
  });
});

describe("throws / doesNotThrow", () => {
  class CustomError extends Error {}
  const thrower = () => {
    throw new TypeError("Wrong value");
  };
  const customThrower = () => {
    throw Object.assign(new CustomError("custom"), { code: "E_CUSTOM", info: { a: 1 } });
  };
  const noop = () => {};
  const throwsPrimitive = () => {
    throw "a string"; // eslint-disable-line no-throw-literal
  };
  const cases: [string, unknown[]][] = [
    ["no matcher", [thrower]],
    ["does not throw", [noop]],
    ["does not throw with message", [noop, "should throw"]],
    ["does not throw with class", [noop, TypeError]],
    ["class match", [thrower, TypeError]],
    ["class mismatch", [thrower, RangeError]],
    ["parent class", [thrower, Error]],
    ["regexp match", [thrower, /Wrong/]],
    ["regexp mismatch", [thrower, /Right/]],
    ["validation function true", [thrower, (e: Error) => e.message === "Wrong value"]],
    [
      "validation function false",
      [
        thrower,
        function check() {
          return false;
        },
      ],
    ],
    ["object match", [thrower, { name: "TypeError", message: "Wrong value" }]],
    ["object regexp match", [thrower, { message: /value/ }]],
    ["object mismatch", [thrower, { message: "Other" }]],
    ["object nested", [customThrower, { code: "E_CUSTOM", info: { a: 1 } }]],
    ["object nested mismatch", [customThrower, { info: { a: 2 } }]],
    ["object mismatch with message", [thrower, { message: "Other" }, "msg"]],
    ["error instance match", [thrower, new TypeError("Wrong value")]],
    ["error instance mismatch", [thrower, new TypeError("Other")]],
    ["empty object", [thrower, {}]],
    ["string message", [noop, "message only"]],
    ["string identical to error message", [thrower, "Wrong value"]],
    ["string as error with message", [thrower, "a", "b"]],
    ["invalid matcher", [thrower, 1]],
    ["fn not a function", ["nope"]],
    ["primitive thrown with object", [throwsPrimitive, { a: 1 }]],
    ["primitive thrown with regexp", [throwsPrimitive, /string/]],
    ["class with different prototype", [customThrower, TypeError]],
  ];
  for (const [label, args] of cases) {
    it(`throws: ${label}`, () => {
      expect(run(() => (assert.throws as (...a: unknown[]) => void)(...args))).toEqual(
        run(() => (nodeAssert.throws as (...a: unknown[]) => void)(...args)),
      );
    });
  }

  const noThrowCases: [string, unknown[]][] = [
    ["no throw", [noop]],
    ["throws", [thrower]],
    ["throws with message", [thrower, "msg"]],
    ["matching class", [thrower, TypeError]],
    ["non-matching class rethrows", [thrower, RangeError]],
    ["matching regexp", [thrower, /Wrong/]],
    ["validation function", [thrower, () => true]],
    ["invalid matcher", [thrower, {}]],
  ];
  for (const [label, args] of noThrowCases) {
    it(`doesNotThrow: ${label}`, () => {
      expect(run(() => (assert.doesNotThrow as (...a: unknown[]) => void)(...args))).toEqual(
        run(() => (nodeAssert.doesNotThrow as (...a: unknown[]) => void)(...args)),
      );
    });
  }
});

describe("rejects / doesNotReject", () => {
  const rejecting = () => Promise.reject(new TypeError("Wrong value"));
  const resolving = () => Promise.resolve(1);
  const cases: [string, () => unknown[]][] = [
    ["rejecting fn", () => [rejecting]],
    ["rejecting promise", () => [rejecting()]],
    ["resolving fn", () => [resolving]],
    ["resolving with class", () => [resolving, TypeError]],
    ["class match", () => [rejecting, TypeError]],
    ["class mismatch", () => [rejecting, RangeError]],
    ["regexp", () => [rejecting, /Wrong/]],
    ["object", () => [rejecting, { message: "Wrong value" }]],
    ["object mismatch", () => [rejecting, { message: "nope" }]],
    ["fn returns non-promise", () => [() => 1]],
    ["invalid promiseFn", () => [1]],
    [
      "sync throw in fn",
      () => [
        () => {
          throw new Error("sync");
        },
      ],
    ],
  ];
  for (const [label, makeArgs] of cases) {
    it(`rejects: ${label}`, async () => {
      const ours = await runAsync(() =>
        (assert.rejects as (...a: unknown[]) => Promise<void>)(...makeArgs()),
      );
      const theirs = await runAsync(() =>
        (nodeAssert.rejects as (...a: unknown[]) => Promise<void>)(...makeArgs()),
      );
      expect(ours).toEqual(theirs);
    });
  }

  const noRejectCases: [string, () => unknown[]][] = [
    ["resolving", () => [resolving]],
    ["rejecting", () => [rejecting]],
    ["rejecting matching", () => [rejecting, TypeError, "msg"]],
    ["rejecting non-matching", () => [rejecting, RangeError]],
    ["invalid input", () => ["x"]],
  ];
  for (const [label, makeArgs] of noRejectCases) {
    it(`doesNotReject: ${label}`, async () => {
      const ours = await runAsync(() =>
        (assert.doesNotReject as (...a: unknown[]) => Promise<void>)(...makeArgs()),
      );
      const theirs = await runAsync(() =>
        (nodeAssert.doesNotReject as (...a: unknown[]) => Promise<void>)(...makeArgs()),
      );
      expect(ours).toEqual(theirs);
    });
  }
});

describe("match / doesNotMatch / ifError", () => {
  const cases: [string, unknown[]][] = [
    ["match", ["abc", /b/]],
    ["no match", ["abc", /x/]],
    ["not a string", [1, /1/]],
    ["not a regexp", ["abc", "b"]],
    ["custom message", ["abc", /x/, "msg"]],
  ];
  for (const [label, args] of cases) {
    it(`match: ${label}`, () => {
      expect(run(() => (assert.match as (...a: unknown[]) => void)(...args))).toEqual(
        run(() => (nodeAssert.match as (...a: unknown[]) => void)(...args)),
      );
    });
    it(`doesNotMatch: ${label}`, () => {
      expect(run(() => (assert.doesNotMatch as (...a: unknown[]) => void)(...args))).toEqual(
        run(() => (nodeAssert.doesNotMatch as (...a: unknown[]) => void)(...args)),
      );
    });
  }

  for (const value of [null, undefined, new Error("bad"), new TypeError(""), "str", 0]) {
    it(`ifError(${String(value)})`, () => {
      expect(run(() => assert.ifError(value))).toEqual(run(() => nodeAssert.ifError(value)));
    });
  }

  it("ifError keeps the original frames", () => {
    const original = new Error("orig");
    let stack = "";
    try {
      assert.ifError(original);
    } catch (e) {
      stack = (e as Error).stack ?? "";
    }
    expect(
      stack.startsWith("AssertionError [ERR_ASSERTION]: ifError got unwanted exception: orig"),
    ).toBe(true);
    expect(stack).toContain((original.stack ?? "").split("\n")[1]);
  });
});

describe("AssertionError", () => {
  it("has Node's shape", () => {
    const ours = new assert.AssertionError({ actual: 1, expected: 2, operator: "strictEqual" });
    const theirs = new nodeAssert.AssertionError({
      actual: 1,
      expected: 2,
      operator: "strictEqual",
    });
    expect(ours.name).toBe(theirs.name);
    expect(ours.code).toBe(theirs.code);
    expect(ours.message).toBe(theirs.message);
    expect(ours.generatedMessage).toBe(theirs.generatedMessage);
    // Newer Node adds a `diff` property; Node 22 has none.
    expect(Object.keys(ours)).toEqual(Object.keys(theirs).filter((key) => key !== "diff"));
    expect(ours.toString()).toBe(theirs.toString());
    expect(ours.stack?.split("\n")[0]).toBe(
      "AssertionError [ERR_ASSERTION]: " + ours.message.split("\n")[0],
    );
    expect(ours).toBeInstanceOf(Error);
  });

  it("uses a given message", () => {
    const ours = new assert.AssertionError({ message: "m", actual: 1, expected: 2 });
    expect(ours.message).toBe("m");
    expect(ours.generatedMessage).toBe(false);
  });

  it("validates its options", () => {
    expect(run(() => new assert.AssertionError(1 as never))).toEqual(
      run(() => new nodeAssert.AssertionError(1 as never)),
    );
  });

  it("generates full messages like Node for common diffs", () => {
    const calls: [keyof typeof assert, unknown, unknown][] = [
      ["deepStrictEqual", { a: 1, b: 2 }, { a: 1, b: 3 }],
      ["strictEqual", "hello world foo", "hello world bar"],
      ["strictEqual", 1, 2],
      ["strictEqual", {}, {}],
      ["deepStrictEqual", { a: Symbol() }, { a: Symbol() }],
      ["strictEqual", () => 1, () => 1],
      ["deepStrictEqual", [1, 2, 3], [1, 2, 4]],
      ["notStrictEqual", 1, 1],
      ["notDeepStrictEqual", { a: 1 }, { a: 1 }],
      ["equal", 1, 2],
      ["notEqual", 1, 1],
      ["deepEqual", { a: 1 }, { a: 2 }],
      // Collapsed runs of equal lines, and the last entry's missing comma.
      ["deepStrictEqual", Array.from({ length: 30 }, (_, i) => i), changed(30, [2, 29])],
      ["deepStrictEqual", Array.from({ length: 12 }, (_, i) => i), changed(12, [3, 10])],
      ["deepStrictEqual", { a: 1, b: [1, 2, 3] }, { a: 1, b: [1, 2, 4], c: 2 }],
      ["deepStrictEqual", [1, 2, 3, 4], [1, 2, 3]],
      ["deepStrictEqual", { x: [1, 2], y: "s" }, { z: { q: 1 }, x: [2, 1] }],
    ];
    for (const [method, actual, expected] of calls) {
      const message = (a: typeof assert | Assert) => {
        try {
          ((a as unknown as Record<string, unknown>)[method] as (x: unknown, y: unknown) => void)(
            actual,
            expected,
          );
        } catch (e) {
          return (e as Error).message;
        }
        return null;
      };
      expect([method, message(assert)]).toEqual([method, message(nodeAssert)]);
    }
  });

  it("diffs large values in linear-ish time, like Node", () => {
    const lines = 5000;
    const big = (last: number) =>
      Object.fromEntries(
        Array.from({ length: lines }, (_, i) => [`k${i}`, i === lines - 1 ? last : i]),
      );
    const messageOf = (a: typeof assert | Assert) => {
      try {
        a.deepStrictEqual(big(1), big(2));
      } catch (e) {
        return (e as Error).message;
      }
      return null;
    };
    const started = performance.now();
    const ours = messageOf(assert);
    expect(performance.now() - started).toBeLessThan(500);
    expect(ours).toBe(messageOf(nodeAssert));
  });

  it("falls back to a plain report when the values share almost nothing", () => {
    const a = Array.from({ length: 4000 }, (_, i) => i);
    const b = a.map((i) => -i - 1);
    const started = performance.now();
    let message = "";
    try {
      assert.deepStrictEqual(a, b);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(message).toContain("+   3999\n");
    expect(message).toContain("-   -4000\n");
  });
});

describe("strict", () => {
  it("is the strict variant", () => {
    expect(assert.strict.strict).toBe(assert.strict);
    expect(assertStrict).toBe(assert.strict);
    expect(assert.strict.equal).toBe(assert.strictEqual);
    expect(assert.strict.deepEqual).toBe(assert.deepStrictEqual);
    expect(assert.strict.notEqual).toBe(assert.notStrictEqual);
    expect(assert.strict.notDeepEqual).toBe(assert.notDeepStrictEqual);
    expect(assert.strict.throws).toBe(assert.throws);
    expect(assert.strict.AssertionError).toBe(assert.AssertionError);
  });

  it("behaves like node:assert/strict", () => {
    expect(run(() => assertStrict.equal(1, "1"))).toEqual(
      run(() => nodeAssertStrict.equal(1, "1")),
    );
    expect(run(() => assertStrict(0))).toMatchObject({ threw: true, code: "ERR_ASSERTION" });
    expect(run(() => assertStrict.deepEqual({ a: 1 }, { a: "1" }))).toEqual(
      run(() => nodeAssertStrict.deepEqual({ a: 1 }, { a: "1" })),
    );
  });

  it("has Node 22's members", () => {
    const expected = [
      "AssertionError",
      "ok",
      "fail",
      "equal",
      "notEqual",
      "deepEqual",
      "notDeepEqual",
      "deepStrictEqual",
      "notDeepStrictEqual",
      "strictEqual",
      "notStrictEqual",
      "partialDeepStrictEqual",
      "match",
      "doesNotMatch",
      "throws",
      "rejects",
      "doesNotThrow",
      "doesNotReject",
      "ifError",
      "CallTracker",
      "strict",
    ];
    expect(Object.keys(assert).sort()).toEqual(expected.sort());
  });

  it("names the unsupported members", () => {
    expect(() => assert.partialDeepStrictEqual({}, {})).toThrow(/partialDeepStrictEqual/);
    expect(() => new assert.CallTracker()).toThrow(/CallTracker/);
  });
});
