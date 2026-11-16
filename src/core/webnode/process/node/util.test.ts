// @vitest-environment node
// Differential tests for the `util` module against real Node's `node:util`:
// inspect/format over tables of values and options, MIME types, parseEnv,
// system errors; plus behaviour tests for promisify, callbackify, deprecate,
// inherits, debuglog, styleText, aborted and getCallSites.
import nodeUtil from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import util from "./util";

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
class Empty {}
class WithGetter {
  get value(): number {
    return 42;
  }
}
class Tagged {
  get [Symbol.toStringTag](): string {
    return "tag";
  }
}

function circular(): unknown {
  const o: Record<string, unknown> = { a: [] };
  (o.a as unknown[]).push(o);
  o.b = { inner: null as unknown };
  (o.b as Record<string, unknown>).inner = o.b;
  return o;
}

const custom = {
  [Symbol.for("nodejs.util.inspect.custom")](depth: number, options: { stylize: unknown }) {
    return `custom(${depth}, ${typeof options.stylize})`;
  },
};

const getterObject = Object.defineProperty({ plain: 1 }, "computed", {
  get: () => "got",
  enumerable: true,
});
const accessorPair = Object.defineProperty({}, "both", {
  get: () => 1,
  set: () => {},
  enumerable: true,
});

const values: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["true", true],
  ["integer", 42],
  ["negative zero", -0],
  ["float", 3.14159],
  ["NaN", Number.NaN],
  ["Infinity", -Infinity],
  ["bigint", 12345678901234567890n],
  ["string", "hello"],
  ["string with quote", "it's"],
  ["string with both quotes", `it's "x"`],
  ["string with newline", "a\nb"],
  ["symbol", Symbol("desc")],
  ["registered symbol", Symbol.for("reg")],
  ["empty object", {}],
  ["object", { a: 1, b: "two", c: [3], d: { e: { f: { g: 1 } } } }],
  ["quoted keys", { "a-b": 1, valid_id: 2, 3: 3 }],
  ["symbol key", { [Symbol("k")]: 1 }],
  ["null prototype", Object.assign(Object.create(null), { a: 1 })],
  ["array", [1, "two", [3, [4, [5, [6]]]]]],
  ["sparse array", [1, , , 4]], // eslint-disable-line no-sparse-arrays
  ["array with props", Object.assign([1, 2], { extra: "x" })],
  ["long array", Array.from({ length: 120 }, (_, i) => i)],
  ["long string array", Array.from({ length: 30 }, (_, i) => `item-${i}`)],
  [
    "nested arrays",
    [
      [1, 2],
      [3, 4],
    ],
  ],
  [
    "map",
    new Map<unknown, unknown>([
      [1, { a: 1 }],
      ["k", [1]],
    ]),
  ],
  ["set", new Set([1, "a", { b: 2 }])],
  ["empty map", new Map()],
  ["weakmap", new WeakMap()],
  ["map iterator", new Map([[1, 2]]).entries()],
  ["set iterator", new Set([1]).values()],
  ["date", new Date(0)],
  ["invalid date", new Date(Number.NaN)],
  ["regexp", /ab+c/gi],
  ["function", function named() {}],
  ["anonymous function", (() => () => {})()],
  ["arrow", () => 1],
  ["async function", async function af() {}],
  ["generator function", function* gen() {}],
  ["class", Point],
  ["class extends", class Sub extends Point {}],
  ["function with props", Object.assign(function f() {}, { prop: 1 })],
  ["class instance", new Point(1, 2)],
  ["empty class instance", new Empty()],
  ["getter class instance", new WithGetter()],
  ["toStringTag instance", new Tagged()],
  ["boxed number", new Number(3)],
  ["boxed string", new String("abc")],
  ["boxed boolean", new Boolean(false)],
  ["boxed symbol", Object(Symbol("s"))],
  ["boxed bigint", Object(5n)],
  ["Uint8Array", new Uint8Array([1, 2, 3])],
  ["Float64Array", new Float64Array([1.5, -0])],
  ["BigInt64Array", new BigInt64Array([1n])],
  ["ArrayBuffer", new Uint8Array([1, 2]).buffer],
  ["DataView", new DataView(new ArrayBuffer(2))],
  ["Buffer", Buffer.from("hello")],
  ["long Buffer", Buffer.alloc(60)],
  ["circular", circular()],
  ["custom inspect", custom],
  ["getter property", getterObject],
  ["accessor pair", accessorPair],
  ["nested custom", { inner: custom }],
  ["object with function", { fn() {}, arrow: () => {} }],
  ["deep nesting", { l1: { l2: { l3: { l4: { l5: {} } } } } }],
  ["many keys", Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, i]))],
  ["long string", "x".repeat(200)],
  ["multi-line string in object", { text: "line one\nline two\nline three ".repeat(5) }],
  [
    "arguments",
    (function (..._args: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      return arguments;
    })(1, 2),
  ],
  ["globalThis-like", { Math, JSON }],
];

const optionSets: [string, nodeUtil.InspectOptions | undefined][] = [
  ["defaults", undefined],
  ["depth 0", { depth: 0 }],
  ["depth Infinity", { depth: Infinity }],
  ["colors", { colors: true }],
  ["compact false", { compact: false }],
  ["compact 1", { compact: 1 }],
  ["breakLength 20", { breakLength: 20 }],
  ["breakLength Infinity", { breakLength: Infinity }],
  ["sorted", { sorted: true }],
  ["showHidden", { showHidden: true }],
  ["maxArrayLength 2", { maxArrayLength: 2 }],
  ["maxStringLength 4", { maxStringLength: 4 }],
  ["getters", { getters: true }],
  ["numericSeparator", { numericSeparator: true }],
  ["customInspect false", { customInspect: false }],
];

// Values whose output depends on V8 internals the extracted inspect cannot
// reach: `arguments` objects (printed as plain objects), errors (stack text
// differs), Proxies and promise state (not in the table).
// Map/Set iterators print without their entries: previewing them needs V8's
// internal previewEntries, and reading them in JavaScript would consume them.
const skipValues = new Set(["arguments", "map iterator", "set iterator"]);

describe("util.inspect", () => {
  for (const [optionLabel, options] of optionSets) {
    it(`matches Node with ${optionLabel}`, () => {
      for (const [label, value] of values) {
        if (skipValues.has(label)) {
          continue;
        }
        // showHidden over a WeakMap lists live entries in an engine-defined order.
        if (optionLabel === "showHidden" && label === "weakmap") {
          continue;
        }
        const ours = util.inspect(value, options);
        const theirs = nodeUtil.inspect(value, options);
        expect([label, ours]).toEqual([label, theirs]);
      }
    });
  }

  it("uses the registered custom symbol", () => {
    expect(util.inspect.custom).toBe(Symbol.for("nodejs.util.inspect.custom"));
    expect(util.inspect.custom).toBe(nodeUtil.inspect.custom);
  });

  it("supports the legacy (object, showHidden, depth, colors) signature", () => {
    const value = { a: { b: { c: { d: 1 } } } };
    expect(util.inspect(value, false, 0, false)).toBe(nodeUtil.inspect(value, false, 0, false));
  });

  it("prints errors like Node (name, message, extra properties)", () => {
    const error = Object.assign(new TypeError("bad"), { code: "E_BAD" });
    const ours = util.inspect(error).split("\n");
    const theirs = nodeUtil.inspect(error).split("\n");
    expect(ours[0]).toBe(theirs[0]);
    expect(ours.at(-1)).toBe(theirs.at(-1));
    expect(util.inspect(new Error("x"), { compact: true }).startsWith("Error: x\n    at ")).toBe(
      true,
    );
  });

  it("has colors and styles matching Node", () => {
    expect(util.inspect.colors).toEqual(nodeUtil.inspect.colors);
    expect(Object.keys(util.inspect.styles)).toEqual(Object.keys(nodeUtil.inspect.styles));
  });

  it("reads and validates defaultOptions", () => {
    const saved = { ...util.inspect.defaultOptions };
    try {
      expect(util.inspect.defaultOptions.depth).toBe(2);
      util.inspect.defaultOptions = { depth: 0 };
      expect(util.inspect({ a: { b: 1 } })).toBe("{ a: [Object] }");
      expect(() => {
        util.inspect.defaultOptions = null as never;
      }).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    } finally {
      util.inspect.defaultOptions = saved;
    }
    expect(util.inspect({ a: { b: 1 } })).toBe("{ a: { b: 1 } }");
  });

  it("exposes replDefaults", () => {
    expect(typeof util.inspect.replDefaults).toBe("object");
    expect(util.inspect.replDefaults.showProxy).toBe(true);
  });
});

describe("util.format", () => {
  const formats: unknown[][] = [
    ["%s:%s", "foo"],
    ["%s:%s", "foo", "bar", "baz"],
    [1, 2, 3],
    ["%% %s"],
    ["%s", 42n],
    ["%s", { a: { b: { c: 1 } } }],
    ["%s", Symbol("x")],
    ["%s", -0],
    ["%s", new Error("e")],
    ["%s", [1, [2, [3]]]],
    ["%s", null, undefined],
    ["%d", "42"],
    ["%d", 42n],
    ["%d", {}],
    ["%i", 42.9],
    ["%i", "0x1f"],
    ["%f", "3.5"],
    ["%j", { a: 1 }],
    [
      "%j",
      (() => {
        const o: Record<string, unknown> = {};
        o.o = o;
        return o;
      })(),
    ],
    ["%o", { a: [1, 2], f() {} }],
    ["%O", { a: { b: { c: { d: 1 } } } }],
    ["%c", "color: red"],
    ["%x %s", "a"],
    ["a", { b: 1 }, "c"],
    ["%s"],
    [],
    [{ a: 1 }],
    ["%s %s", "only"],
    ["%%s", "x"],
  ];
  for (const args of formats) {
    it(`format(${args.map((a) => typeof a).join(", ")}) ${String(args[0])}`, () => {
      // An error prints its stack, whose frames differ: compare the first line.
      const firstLineOnly = args[1] instanceof Error;
      const view = (text: string) => (firstLineOnly ? text.split("\n")[0] : text);
      expect(view(util.format(...args))).toBe(view(nodeUtil.format(...args)));
    });
  }

  it("formatWithOptions passes options to inspect", () => {
    const value = { a: { b: { c: 1 } } };
    expect(util.formatWithOptions({ depth: 0 }, "%O", value)).toBe(
      nodeUtil.formatWithOptions({ depth: 0 }, "%O", value),
    );
    expect(util.formatWithOptions({ colors: true }, "x", 1)).toBe(
      nodeUtil.formatWithOptions({ colors: true }, "x", 1),
    );
  });

  it("stripVTControlCharacters", () => {
    expect(util.stripVTControlCharacters("\u001B[4mvalue\u001B[0m")).toBe("value");
  });
});

describe("util.promisify", () => {
  it("resolves with the first callback value and rejects with the error", async () => {
    const ok = (a: number, cb: (err: unknown, v?: number, extra?: number) => void) =>
      cb(null, a * 2, 99);
    const fail = (cb: (err: unknown) => void) => cb(new Error("boom"));
    await expect(util.promisify(ok)(21)).resolves.toBe(42);
    await expect(util.promisify(fail)()).rejects.toThrow("boom");
  });

  it("rejects when the function throws synchronously", async () => {
    const thrower = () => {
      throw new Error("sync");
    };
    await expect(util.promisify(thrower)()).rejects.toThrow("sync");
  });

  it("keeps `this` and copies properties", async () => {
    function method(this: { k: number }, cb: (e: unknown, v: number) => void) {
      cb(null, this.k);
    }
    (method as unknown as { extra: number }).extra = 5;
    const p = util.promisify(method);
    expect((p as unknown as { extra: number }).extra).toBe(5);
    expect(p.name).toBe("method");
    await expect(p.call({ k: 7 })).resolves.toBe(7);
  });

  it("honours promisify.custom", () => {
    const custom = () => Promise.resolve(1);
    const fn = Object.assign(() => {}, { [util.promisify.custom]: custom });
    expect(util.promisify.custom).toBe(Symbol.for("nodejs.util.promisify.custom"));
    expect(util.promisify(fn)).toBe(custom);
    const p = util.promisify((cb: () => void) => cb());
    expect(util.promisify(p)).toBe(p);
  });

  it("validates its argument", () => {
    for (const bad of [undefined, 1, {}]) {
      let ours: unknown;
      let theirs: unknown;
      try {
        util.promisify(bad as never);
      } catch (e) {
        ours = (e as Error).message;
      }
      try {
        nodeUtil.promisify(bad as never);
      } catch (e) {
        theirs = (e as Error).message;
      }
      expect(ours).toBe(theirs);
    }
  });
});

describe("util.callbackify", () => {
  it("calls back with the result or the error", async () => {
    const ok = util.callbackify(async (a: number) => a + 1);
    const result = await new Promise((resolve) =>
      ok(1, (err: unknown, v: unknown) => resolve([err, v])),
    );
    expect(result).toEqual([null, 2]);
    const bad = util.callbackify(async () => {
      throw new Error("no");
    });
    const error = await new Promise((resolve) => bad((err: unknown) => resolve(err)));
    expect((error as Error).message).toBe("no");
  });

  it("wraps a falsy rejection", async () => {
    const bad = util.callbackify(() => Promise.reject(null));
    const error = (await new Promise<unknown>((resolve) =>
      bad((err: unknown) => resolve(err)),
    )) as {
      code: string;
      reason: unknown;
      message: string;
    };
    expect(error.code).toBe("ERR_FALSY_VALUE_REJECTION");
    expect(error.reason).toBe(null);
    expect(error.message).toBe("Promise was rejected with falsy value");
  });

  it("renames and lengthens like Node", () => {
    async function work(_a: number) {}
    const ours = util.callbackify(work);
    const theirs = nodeUtil.callbackify(work);
    expect(ours.name).toBe(theirs.name);
    expect(ours.length).toBe(theirs.length);
    expect(() => ours(1)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  });
});

describe("util.deprecate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns once per code through process.emitWarning", () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const a = util.deprecate((x: number) => x + 1, "a is old", "WEBNODE_TEST_1");
    const b = util.deprecate((x: number) => x + 2, "b is old", "WEBNODE_TEST_1");
    expect(a(1)).toBe(2);
    expect(a(1)).toBe(2);
    expect(b(1)).toBe(3);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(0, 3)).toEqual([
      "a is old",
      "DeprecationWarning",
      "WEBNODE_TEST_1",
    ]);
  });

  it("warns once per wrapper without a code and supports new", () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    class Old {
      v = 1;
    }
    const Wrapped = util.deprecate(Old, "Old is old");
    const instance = new (Wrapped as unknown as new () => Old)();
    new (Wrapped as unknown as new () => Old)();
    expect(instance).toBeInstanceOf(Old);
    expect(instance).toBeInstanceOf(Wrapped as unknown as typeof Old);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns fn unchanged under process.noDeprecation", () => {
    const fn = () => 1;
    (process as { noDeprecation?: boolean }).noDeprecation = true;
    try {
      expect(util.deprecate(fn, "x")).toBe(fn);
    } finally {
      delete (process as { noDeprecation?: boolean }).noDeprecation;
    }
  });
});

describe("util.inherits", () => {
  it("sets super_ and the prototype chain", () => {
    function Base() {}
    Base.prototype.hello = () => "hi";
    function Child() {}
    util.inherits(Child, Base);
    expect((Child as unknown as { super_: unknown }).super_).toBe(Base);
    expect(Object.getPrototypeOf(Child.prototype)).toBe(Base.prototype);
  });

  it("validates like Node", () => {
    const cases: [unknown, unknown][] = [
      [null, function () {}],
      [function () {}, undefined],
      [function () {}, Object.create(null)],
    ];
    for (const [ctor, superCtor] of cases) {
      let ours: unknown;
      let theirs: unknown;
      try {
        util.inherits(ctor, superCtor);
      } catch (e) {
        ours = [(e as { code: string }).code, (e as Error).message];
      }
      try {
        nodeUtil.inherits(ctor as never, superCtor as never);
      } catch (e) {
        theirs = [(e as { code: string }).code, (e as Error).message];
      }
      expect(ours).toEqual(theirs);
    }
  });
});

describe("util.debuglog", () => {
  it("writes SECTION PID: message when NODE_DEBUG names the section", async () => {
    // NODE_DEBUG is read once per module instance, so load a fresh copy.
    vi.resetModules();
    const saved = process.env.NODE_DEBUG;
    process.env.NODE_DEBUG = "foo,ba*";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fresh = (await import("./util")).default;
      const foo = fresh.debuglog("foo");
      const bar = fresh.debuglog("bark");
      const other = fresh.debuglog("other");
      expect(foo.enabled).toBe(true);
      expect(bar.enabled).toBe(true);
      expect(other.enabled).toBe(false);
      foo("hello %d", 1);
      other("hidden");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(`FOO ${process.pid}: hello 1`);
      let received: unknown;
      fresh.debuglog("foo", (fn) => {
        received = fn;
      })("x");
      expect(typeof received).toBe("function");
    } finally {
      spy.mockRestore();
      if (saved === undefined) {
        delete process.env.NODE_DEBUG;
      } else {
        process.env.NODE_DEBUG = saved;
      }
    }
  });

  it("is also exported as util.debug", () => {
    expect(util.debug).toBe(util.debuglog);
  });
});

describe("util.styleText", () => {
  it("formats like Node when the stream is not validated", () => {
    const opts = { validateStream: false };
    expect(util.styleText("red", "x", opts)).toBe(nodeUtil.styleText("red", "x", opts));
    expect(util.styleText(["bold", "underline"], "x", opts)).toBe(
      nodeUtil.styleText(["bold", "underline"], "x", opts),
    );
  });

  it("skips colors for a non-TTY stream", () => {
    const stream = { write() {}, on() {}, isTTY: false };
    expect(util.styleText("red", "x", { stream })).toBe("x");
  });

  it("rejects an unknown format, listing the enumerable colors", () => {
    const run = () => util.styleText("nope" as never, "x", { validateStream: false });
    expect(run).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
    expect(run).toThrow(/^The argument 'format' must be one of: 'reset', 'bold'.*Received 'nope'$/);
    expect(util.styleText("grey" as never, "x", { validateStream: false })).toBe(
      nodeUtil.styleText("grey" as never, "x", { validateStream: false }),
    );
  });

  it("validates text and stream like Node", () => {
    const calls: [unknown, unknown, unknown][] = [
      ["red", 1, { validateStream: false }],
      ["red", "x", { stream: {} }],
    ];
    for (const [format, text, options] of calls) {
      let ours: unknown;
      let theirs: unknown;
      try {
        util.styleText(format as never, text as never, options as never);
      } catch (e) {
        ours = [(e as { code: string }).code, (e as Error).message];
      }
      try {
        nodeUtil.styleText(format as never, text as never, options as never);
      } catch (e) {
        theirs = [(e as { code: string }).code, (e as Error).message];
      }
      expect(ours).toEqual(theirs);
    }
  });
});

describe("system errors", () => {
  it("getSystemErrorName matches Node", () => {
    // Only errnos shared by Linux and the host Node (macOS numbers differ above 34).
    for (const errno of [-1, -2, -13, -17, -22]) {
      expect(util.getSystemErrorName(errno)).toBe(nodeUtil.getSystemErrorName(errno));
    }
    for (const bad of [1, 0, 1.5, "x"]) {
      let ours: unknown;
      let theirs: unknown;
      try {
        util.getSystemErrorName(bad as never);
      } catch (e) {
        ours = [(e as { code: string }).code, (e as Error).message];
      }
      try {
        nodeUtil.getSystemErrorName(bad as never);
      } catch (e) {
        theirs = [(e as { code: string }).code, (e as Error).message];
      }
      expect(ours).toEqual(theirs);
    }
  });

  it("getSystemErrorMap holds [name, description]", () => {
    const map = util.getSystemErrorMap();
    expect(map.get(-2)).toEqual(nodeUtil.getSystemErrorMap().get(-2));
    expect(map.get(-13)).toEqual(nodeUtil.getSystemErrorMap().get(-13));
  });

  it("_errnoException builds Node's error", () => {
    const error = util._errnoException(-2, "open", "/x") as Error & { code: string };
    expect(error.message).toBe("open ENOENT /x");
    expect(error.code).toBe("ENOENT");
  });
});

describe("MIMEType", () => {
  const inputs = [
    "text/html",
    "TEXT/HTML; Charset=UTF-8",
    "text/plain;charset=utf-8;format=flowed",
    'text/plain; name="a \\"quoted\\" value"',
    "text/plain;a=1;a=2",
    "text/plain;novalue;b=2",
    "text/plain;x=;y=1",
    'text/plain;x="unterminated',
    "  application/json  ",
    "image/svg+xml",
    'text/plain;charset=""',
    "text/plain; x=a b",
    "text",
    "/html",
    "te xt/html",
    "text/",
  ];
  for (const input of inputs) {
    it(`${JSON.stringify(input)}`, () => {
      const describeMime = (Ctor: new (s: string) => object) => {
        try {
          const m = new Ctor(input) as {
            type: string;
            subtype: string;
            essence: string;
            params: Iterable<[string, string]>;
            toString(): string;
          };
          return [m.type, m.subtype, m.essence, [...m.params], m.toString(), JSON.stringify(m)];
        } catch (e) {
          return [(e as { code: string }).code, (e as Error).message];
        }
      };
      expect(describeMime(util.MIMEType)).toEqual(describeMime(nodeUtil.MIMEType));
    });
  }

  it("params get/set/has/delete and setters validate like Node", () => {
    const run = (Ctor: new (s: string) => object) => {
      const m = new Ctor("text/plain;a=1") as {
        type: string;
        params: {
          get(n: string): string | null;
          set(n: string, v: string): void;
          has(n: string): boolean;
          delete(n: string): void;
        };
        toString(): string;
      };
      const out: unknown[] = [];
      out.push(m.params.get("a"), m.params.get("missing"), m.params.has("a"));
      m.params.set("b", "has space");
      m.params.delete("a");
      out.push(m.toString());
      m.type = "IMAGE";
      out.push(m.toString());
      for (const bad of [
        () => (m.type = "x y"),
        () => m.params.set("", "v"),
        () => m.params.set("k", "\u0100"),
      ]) {
        try {
          bad();
        } catch (e) {
          out.push((e as Error).message);
        }
      }
      return out;
    };
    expect(run(util.MIMEType)).toEqual(run(nodeUtil.MIMEType));
  });
});

describe("parseEnv", () => {
  const inputs = [
    "A=1\nB=2",
    "A=1\r\nB=two words\r\n",
    "# comment\nA=1 # trailing\n\nB=2",
    "export A=1\nexport  B = 2",
    "A=\"double\"\nB='single'\nC=`back`",
    'A="multi\\nline"\nB=x',
    'A="real\nmultiline"\nB=2',
    "A=\nB=2",
    "A=",
    "  A  =  spaced value  ",
    "A='unterminated\nB=2",
    "NOEQUALS\nA=1",
    "A=1=2",
    'A="#not comment"',
    "A=x#y",
    "=nokey\nB=1",
  ];
  for (const input of inputs) {
    it(`${JSON.stringify(input)}`, () => {
      expect(util.parseEnv(input)).toEqual({ ...nodeUtil.parseEnv(input) });
    });
  }

  it("validates its argument", () => {
    expect(() => util.parseEnv(1 as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});

describe("misc", () => {
  it("has Node 22's members", () => {
    const expected = [
      "_errnoException",
      "_exceptionWithHostPort",
      "_extend",
      "callbackify",
      "debug",
      "debuglog",
      "deprecate",
      "format",
      "styleText",
      "formatWithOptions",
      "getCallSites",
      "getSystemErrorMap",
      "getSystemErrorName",
      "inherits",
      "inspect",
      "isArray",
      "isBoolean",
      "isBuffer",
      "isDeepStrictEqual",
      "isNull",
      "isNullOrUndefined",
      "isNumber",
      "isString",
      "isSymbol",
      "isUndefined",
      "isRegExp",
      "isObject",
      "isDate",
      "isError",
      "isFunction",
      "isPrimitive",
      "log",
      "promisify",
      "stripVTControlCharacters",
      "toUSVString",
      "transferableAbortSignal",
      "transferableAbortController",
      "aborted",
      "types",
      "parseEnv",
      "parseArgs",
      "TextDecoder",
      "TextEncoder",
      "MIMEType",
      "MIMEParams",
    ];
    expect(Object.keys(util).sort()).toEqual(expected.sort());
  });

  it("legacy type checks", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    expect(util.isArray([])).toBe(true);
    expect(util.isBoolean(false)).toBe(true);
    expect(util.isBuffer(Buffer.from("x"))).toBe(true);
    expect(util.isBuffer(new Uint8Array(1))).toBe(false);
    expect(util.isNull(null)).toBe(true);
    expect(util.isNullOrUndefined(undefined)).toBe(true);
    expect(util.isNumber(1)).toBe(true);
    expect(util.isString("")).toBe(true);
    expect(util.isSymbol(Symbol())).toBe(true);
    expect(util.isUndefined(undefined)).toBe(true);
    expect(util.isRegExp(/x/)).toBe(true);
    expect(util.isObject({})).toBe(true);
    expect(util.isObject(null)).toBe(false);
    expect(util.isDate(new Date())).toBe(true);
    expect(util.isError(new TypeError())).toBe(true);
    expect(util.isFunction(() => {})).toBe(true);
    expect(util.isPrimitive("x")).toBe(true);
    expect(util.isPrimitive({})).toBe(false);
    expect(util._extend({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    vi.restoreAllMocks();
  });

  it("isDeepStrictEqual, types and text codecs", () => {
    expect(util.isDeepStrictEqual({ a: [1] }, { a: [1] })).toBe(true);
    expect(util.types.isDate(new Date())).toBe(true);
    expect(new util.TextDecoder().decode(new util.TextEncoder().encode("hé"))).toBe("hé");
  });

  it("toUSVString replaces lone surrogates", () => {
    expect(util.toUSVString("a\ud83db")).toBe(nodeUtil.toUSVString("a\ud83db"));
  });

  it("aborted resolves when the signal aborts", async () => {
    const controller = new AbortController();
    const done = util.aborted(controller.signal, {});
    controller.abort();
    await expect(done).resolves.toBeUndefined();
    await expect(util.aborted({} as never, {})).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
    await expect(util.aborted(controller.signal, 1 as never)).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
  });

  it("transferable abort helpers", () => {
    const controller = util.transferableAbortController();
    expect(controller).toBeInstanceOf(AbortController);
    expect(util.transferableAbortSignal(controller.signal)).toBe(controller.signal);
    expect(() => util.transferableAbortSignal({} as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("getCallSites reports the caller first", () => {
    function caller() {
      return util.getCallSites();
    }
    const sites = caller();
    expect(sites[0].functionName).toBe("caller");
    expect(sites[0].scriptName).toContain("util.test.ts");
    expect(sites[0].lineNumber).toBeGreaterThan(0);
    expect(util.getCallSites(1)).toHaveLength(1);
    expect(() => util.getCallSites(0)).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
  });

  it("log prints a timestamped line", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    util.log("hi %d", 1);
    expect(spy.mock.calls[0][0]).toBe("%s - %s");
    expect(spy.mock.calls[0][1]).toMatch(/^\d+ [A-Z][a-z]{2} \d\d:\d\d:\d\d$/);
    expect(spy.mock.calls[0][2]).toBe("hi 1");
    vi.restoreAllMocks();
  });
});
