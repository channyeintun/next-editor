// @vitest-environment node
import { describe, expect, it } from "vitest";
import vm, {
  Script,
  SourceTextModule,
  compileFunction,
  createContext,
  isContext,
  measureMemory,
  runInContext,
  runInNewContext,
  runInThisContext,
  scanTopLevelDeclarations,
} from "./vm";

describe("vm shape", () => {
  it("has Node's exports", () => {
    expect(Object.keys(vm)).toEqual([
      "Script",
      "createContext",
      "createScript",
      "runInContext",
      "runInNewContext",
      "runInThisContext",
      "isContext",
      "compileFunction",
      "measureMemory",
      "constants",
    ]);
    expect(typeof vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER).toBe("symbol");
    expect(typeof vm.constants.DONT_CONTEXTIFY).toBe("symbol");
  });
});

describe("runInThisContext", () => {
  it("returns the completion value against the real global", () => {
    expect(runInThisContext("1 + 2")).toBe(3);
    expect(runInThisContext("this === globalThis")).toBe(true);
    runInThisContext("globalThis.__vmTestValue = 42");
    expect((globalThis as Record<string, unknown>).__vmTestValue).toBe(42);
    delete (globalThis as Record<string, unknown>).__vmTestValue;
  });

  it("names the file in stack traces with unchanged line numbers", () => {
    let stack = "";
    try {
      runInThisContext("\n\nthrow new Error('here')", { filename: "/app/file.js" });
    } catch (error) {
      stack = (error as Error).stack ?? "";
    }
    expect(stack).toContain("/app/file.js:3");
    try {
      runInThisContext("throw new Error('x')", "/app/named.js");
    } catch (error) {
      stack = (error as Error).stack ?? "";
    }
    expect(stack).toContain("/app/named.js:1");
  });

  it("validates code", () => {
    expect(() => runInThisContext(1 as unknown as string)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("applies lineOffset", () => {
    let stack = "";
    try {
      runInThisContext("throw new Error('x')", { filename: "/off.js", lineOffset: 10 });
    } catch (error) {
      stack = (error as Error).stack ?? "";
    }
    expect(stack).toContain("/off.js:11");
  });
});

describe("Script", () => {
  it("throws a SyntaxError at construction", () => {
    expect(() => new Script("let = ;")).toThrow(SyntaxError);
  });

  it("is reusable across runs and contexts", () => {
    const script = new Script("count = (typeof count === 'number' ? count : 0) + 1");
    const a = createContext({});
    const b = createContext({ count: 10 });
    script.runInContext(a);
    script.runInContext(a);
    script.runInContext(b);
    expect(a).toEqual({ count: 2 });
    expect(b).toEqual({ count: 11 });
    expect(script.runInNewContext({ count: 0 })).toBe(1);
  });

  it("has cache data members and sourceMapURL", () => {
    const script = new Script("1\n//# sourceMappingURL=out.js.map\n", {
      cachedData: new Uint8Array(4),
    });
    expect(script.cachedDataRejected).toBe(true);
    expect(script.sourceMapURL).toBe("out.js.map");
    expect(script.createCachedData().length).toBe(0);
    expect(new Script("1").cachedDataRejected).toBeUndefined();
    expect(new Script("1").runInThisContext()).toBe(1);
  });
});

describe("contexts", () => {
  it("createContext / isContext", () => {
    const sandbox = { a: 1 };
    expect(isContext(sandbox)).toBe(false);
    expect(createContext(sandbox)).toBe(sandbox);
    expect(isContext(sandbox)).toBe(true);
    expect(() => isContext(1 as unknown as object)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(isContext(createContext(vm.constants.DONT_CONTEXTIFY))).toBe(true);
  });

  it("runInContext requires a contextified object", () => {
    expect(() => runInContext("1", {})).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("reads the context first, then the real globals", () => {
    const context = createContext({ x: 2, Math: { max: () => "shadowed" } });
    expect(runInContext("x * 21", context)).toBe(42);
    expect(runInContext("Math.max(1, 2)", context)).toBe("shadowed");
    expect(runInContext("JSON.stringify([x])", context)).toBe("[2]");
    expect(runInContext("typeof notDefinedAnywhere", context)).toBe("undefined");
  });

  it("this and globalThis are the context object", () => {
    const context = createContext({});
    expect(runInContext("this", context)).toBe(context);
    expect(runInContext("globalThis", context)).toBe(context);
  });

  it("stores writes and var initialisers on the context, not the real global", () => {
    const context = createContext({});
    runInContext("y = 5; var z = 6; globalThis.w = 7; this.v = 8", context);
    expect(context).toEqual({ y: 5, z: 6, w: 7, v: 8 });
    expect("y" in globalThis).toBe(false);
    expect("z" in globalThis).toBe(false);
  });

  it("persists top-level function and var declarations between runs", () => {
    const context = createContext({});
    runInContext(
      [
        "var counter = 0;",
        "function bump() { return ++counter; }",
        "var a, b = 2;",
        "var { c, d: e } = { c: 3, d: 4 };",
        "bump();",
      ].join("\n"),
      context,
    );
    expect(runInContext("bump() + b + c + e", context)).toBe(2 + 2 + 3 + 4);
    expect(context).toHaveProperty("bump");
    expect(context).toHaveProperty("a", undefined);
    expect((context as Record<string, unknown>).counter).toBe(2);
  });

  it("functions declared in the code are callable within the same run", () => {
    const context = createContext({});
    expect(runInContext("f(); function f() { return 'hoisted'; }", context)).toBe("hoisted");
  });

  it("does not let a context's eval replace the runner's", () => {
    const context = createContext({ eval: () => "fake" });
    expect(runInContext("1 + 1", context)).toBe(2);
  });

  it("runInNewContext creates a context", () => {
    expect(runInNewContext("a + b", { a: 1, b: 2 })).toBe(3);
    expect(runInNewContext("typeof process === 'object'")).toBe(true);
  });

  it("errors carry the filename", () => {
    const context = createContext({});
    let stack = "";
    try {
      runInContext("\nthrow new Error('ctx')", context, { filename: "/ctx.js" });
    } catch (error) {
      stack = (error as Error).stack ?? "";
    }
    expect(stack).toContain("/ctx.js:2");
  });
});

describe("compileFunction", () => {
  it("makes a function with the parameters", () => {
    const add = compileFunction("return a + b", ["a", "b"]);
    expect(add(2, 3)).toBe(5);
    expect(add.length).toBe(2);
  });

  it("keeps the body's line numbers and names the file", () => {
    const fn = compileFunction("\nthrow new Error('cf')", [], { filename: "/cf.js" });
    let stack = "";
    try {
      fn();
    } catch (error) {
      stack = (error as Error).stack ?? "";
    }
    expect(stack).toContain("/cf.js:2");
  });

  it("honours contextExtensions and parsingContext", () => {
    const fn = compileFunction("return ext + fromContext", [], {
      contextExtensions: [{ ext: 1 }],
      parsingContext: createContext({ fromContext: 2 }),
    });
    expect(fn()).toBe(3);
  });

  it("validates params", () => {
    expect(() => compileFunction("1", "a" as unknown as string[])).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});

describe("scanTopLevelDeclarations", () => {
  it("finds top-level var and function declarations only", () => {
    const { vars, functions } = scanTopLevelDeclarations(
      [
        "var a = 1, b = [1, 2], c = { d: 1 }",
        "function top() { var inner = 1; function nested() {} }",
        "async function asyncTop() {}",
        "function* gen() {}",
        "x = function expr() {};",
        "!function iife() {}();",
        "if (1) { var notTop = 1 }",
        "const re = /var fake = 1/; const s = 'var fake2';",
        "const t = `${'var fake3'} function fake4() {}`;",
        "// var commented",
        "obj.var = 1",
      ].join("\n"),
    );
    expect([...vars].sort()).toEqual(["a", "b", "c"]);
    expect([...functions].sort()).toEqual(["asyncTop", "gen", "top"]);
  });
});

describe("unsupported members", () => {
  it("throw named errors", () => {
    expect(() => new SourceTextModule()).toThrow("vm.SourceTextModule is not available in webnode");
    expect(() => measureMemory()).toThrow("vm.measureMemory is not available in webnode");
  });
});
