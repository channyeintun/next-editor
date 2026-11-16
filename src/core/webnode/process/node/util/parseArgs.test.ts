// @vitest-environment node
// Differential tests: `parseArgs` over a table of configs, against real
// Node's `util.parseArgs` (values, positionals, tokens, and error code/message).
import nodeUtil from "node:util";
import { describe, expect, it } from "vitest";
import { parseArgs, type ParseArgsConfig } from "./parseArgs";

function outcome(run: () => unknown): unknown {
  try {
    const result = run() as { values: object };
    // Compare as plain data: the values object has a null prototype in both.
    return JSON.parse(JSON.stringify({ ...result, values: { ...result.values } }));
  } catch (error) {
    const e = error as { code?: string; message: string; name: string };
    return { error: e.code, name: e.name, message: e.message };
  }
}

const options = {
  verbose: { type: "boolean", short: "v" },
  file: { type: "string", short: "f" },
  color: { type: "boolean" },
  include: { type: "string", multiple: true, short: "I" },
  level: { type: "string", default: "info" },
  flags: { type: "boolean", multiple: true, short: "x" },
} as const;

const cases: [string, ParseArgsConfig][] = [
  ["empty", { args: [] }],
  ["long boolean", { args: ["--verbose"], options }],
  ["short boolean", { args: ["-v"], options }],
  ["long string separate", { args: ["--file", "a.txt"], options }],
  ["long string inline", { args: ["--file=a.txt"], options }],
  ["short string separate", { args: ["-f", "a.txt"], options }],
  ["short string inline", { args: ["-fa.txt"], options }],
  ["short group", { args: ["-vx"], options }],
  ["short group ending in string", { args: ["-vf", "a.txt"], options }],
  ["short group with string in middle", { args: ["-vfa.txt"], options }],
  ["multiple strings", { args: ["-I", "a", "--include", "b", "-Ic"], options }],
  ["multiple booleans", { args: ["-x", "-x", "--flags"], options }],
  ["default applied", { args: [], options }],
  ["default overridden", { args: ["--level", "debug"], options }],
  ["string missing value", { args: ["--file"], options }],
  ["boolean with value", { args: ["--verbose=yes"], options }],
  ["unknown option strict", { args: ["--nope"], options }],
  ["unknown short strict", { args: ["-z"], options }],
  ["unknown with positionals allowed", { args: ["--nope"], options, allowPositionals: true }],
  ["positional strict", { args: ["pos"], options }],
  ["positional allowed", { args: ["pos", "-v"], options, allowPositionals: true }],
  ["terminator", { args: ["-v", "--", "--file", "x"], options, allowPositionals: true }],
  ["terminator without positionals", { args: ["--"], options }],
  ["ambiguous value", { args: ["--file", "-v"], options }],
  ["ambiguous short value", { args: ["-f", "--verbose"], options }],
  ["dash value inline", { args: ["--file=-v"], options }],
  ["single dash positional", { args: ["-"], options, allowPositionals: true }],
  ["non-strict unknown", { args: ["--nope", "--x=1", "-ab", "pos"], strict: false }],
  ["non-strict string missing", { args: ["--file"], options, strict: false }],
  [
    "tokens",
    { args: ["-vf", "a", "--color", "--", "p"], options, tokens: true, allowPositionals: true },
  ],
  ["tokens short group", { args: ["-vx", "-I", "a"], options, tokens: true }],
  ["tokens inline", { args: ["--file=a", "-fb"], options, tokens: true }],
  ["negative", { args: ["--no-color"], options, allowNegative: true }],
  ["negative then positive", { args: ["--no-color", "--color"], options, allowNegative: true }],
  ["negative unknown", { args: ["--no-nope"], options, allowNegative: true }],
  ["negative of string", { args: ["--no-file"], options, allowNegative: true }],
  ["negative disabled", { args: ["--no-color"], options }],
  ["negative multiple", { args: ["--no-flags", "-x"], options, allowNegative: true }],
  ["proto key", { args: ["--__proto__"], strict: false }],
  ["invalid type", { args: [], options: { a: { type: "number" } } as never }],
  ["invalid short", { args: [], options: { a: { type: "boolean", short: "ab" } } }],
  ["short not string", { args: [], options: { a: { type: "boolean", short: 1 } } as never }],
  ["invalid multiple", { args: [], options: { a: { type: "boolean", multiple: 1 } } as never }],
  ["invalid default", { args: [], options: { a: { type: "string", default: 1 } } as never }],
  [
    "invalid multiple default",
    { args: [], options: { a: { type: "string", multiple: true, default: ["a", 1] } } as never },
  ],
  [
    "valid multiple default",
    { args: [], options: { a: { type: "string", multiple: true, default: ["a"] } } },
  ],
  ["boolean default", { args: [], options: { a: { type: "boolean", default: false } } }],
  ["args not array", { args: "x" as never }],
  ["strict not boolean", { args: [], strict: 1 as never }],
  ["options not object", { args: [], options: 1 as never }],
  ["option config not object", { args: [], options: { a: 1 } as never }],
  ["equals in short", { args: ["-f=x"], options }],
  ["long with empty inline", { args: ["--file="], options }],
  ["triple dash", { args: ["---x"], strict: false }],
];

describe("parseArgs", () => {
  for (const [label, config] of cases) {
    it(`${label}`, () => {
      const ours = outcome(() => parseArgs(config));
      const theirs = outcome(() =>
        nodeUtil.parseArgs(config as Parameters<typeof nodeUtil.parseArgs>[0]),
      );
      expect(ours).toEqual(theirs);
    });
  }

  it("returns null-prototype values", () => {
    expect(Object.getPrototypeOf(parseArgs({ args: [] }).values)).toBe(null);
  });

  it("reads process.argv when no args are given", () => {
    const saved = process.argv;
    process.argv = ["node", "script.js", "--x"];
    try {
      expect(parseArgs({ strict: false }).values).toEqual({ x: true });
    } finally {
      process.argv = saved;
    }
  });
});
