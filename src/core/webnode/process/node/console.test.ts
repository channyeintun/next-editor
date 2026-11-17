// @vitest-environment node
// The Console against Node's own, each writing to a collecting stream.
import { Console as NodeConsole } from "node:console";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Console } from "./console";

type Run = (c: Console) => void;

function ours(run: Run): string {
  let out = "";
  const stream = { write: (s: string) => (out += s) };
  run(new Console({ stdout: stream, stderr: stream, colorMode: false }));
  return out;
}

function node(run: Run): string {
  let out = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      out += String(chunk);
      callback();
    },
  });
  run(new NodeConsole({ stdout: stream, stderr: stream, colorMode: false }) as unknown as Console);
  return out;
}

describe("console.table", () => {
  const cases: [string, Run][] = [
    [
      "a Map",
      (c) =>
        c.table(
          new Map<unknown, unknown>([
            ["k", { a: 1 }],
            [{ x: 1 }, 2],
          ]),
        ),
    ],
    ["a Set", (c) => c.table(new Set([1, "two", { three: 3 }]))],
    ["an empty Map", (c) => c.table(new Map())],
    [
      "an array of objects",
      (c) =>
        c.table([
          { a: 1, b: "x" },
          { b: 2, c: [1, 2, 3, 4] },
        ]),
    ],
    ["mixed rows", (c) => c.table({ r1: 1, r2: { a: { deep: { er: 1 } } }, r3: null })],
    ["chosen columns", (c) => c.table([{ a: 1, b: 2 }, 3], ["b"])],
    ["a wide object", (c) => c.table([{ o: { a: 1, b: 2, c: 3 } }])],
    ["a primitive", (c) => c.table(5)],
    [
      "inside a group",
      (c) => {
        c.group("g");
        c.table([{ a: 1 }]);
        c.dir({ a: 1, b: { c: 2 } }, { compact: false });
        c.groupEnd();
      },
    ],
  ];
  it.each(cases)("prints %s like Node", (_label, run) => {
    expect(ours(run)).toBe(node(run));
  });

  it("validates properties", () => {
    const error = (run: Run) => {
      try {
        run(new Console({ stdout: { write: () => true } }));
      } catch (e) {
        return [(e as { code?: string }).code, (e as Error).message];
      }
      return null;
    };
    const run: Run = (c) => c.table([], "a" as never);
    expect(error(run)).toEqual(
      (() => {
        try {
          node(run);
        } catch (e) {
          return [(e as { code?: string }).code, (e as Error).message];
        }
        return null;
      })(),
    );
  });
});
