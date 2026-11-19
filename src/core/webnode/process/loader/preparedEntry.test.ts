// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import {
  PREPARED_MIN_BYTES,
  decodePreparedEntry,
  encodePreparedEntry,
  isPreparable,
} from "./preparedEntry";
import { prepareSource, transformReady } from "./transform";

beforeAll(async () => {
  await transformReady;
});

const text = (value: string) => new TextEncoder().encode(value);

describe("a large module's entry", () => {
  it("gives back the prepared module it was made of, code and all", () => {
    const prepared = prepareSource(
      [
        'import fs, { readFileSync as read } from "node:fs";',
        'export * from "./more.mjs";',
        "export function hoisted() { return read; }",
        'export const snowman = "☃ \\n";',
        "export default fs;",
      ].join("\n"),
      "/p/node_modules/pkg/index.mjs",
      "esm",
    );
    expect(prepared.specifiers).toEqual(["node:fs", "./more.mjs"]);
    expect(decodePreparedEntry(encodePreparedEntry(prepared))).toEqual(prepared);
  });

  it("is not read from bytes that are no entry", () => {
    const head = (value: unknown) => text(`${JSON.stringify(value)}\ncode`);
    const good = {
      format: "esm",
      specifiers: [],
      prologue: "",
      exportNames: null,
      starExports: [],
      importedNames: [],
    };
    expect(decodePreparedEntry(head(good))).toEqual({ ...good, code: "code" });
    expect(decodePreparedEntry(new Uint8Array(0))).toBeNull();
    expect(decodePreparedEntry(text("no line break"))).toBeNull();
    expect(decodePreparedEntry(text("not json\ncode"))).toBeNull();
    expect(decodePreparedEntry(head(null))).toBeNull();
    expect(decodePreparedEntry(head({ ...good, format: "cjs" }))).toBeNull();
    expect(decodePreparedEntry(head({ ...good, specifiers: [1] }))).toBeNull();
    expect(decodePreparedEntry(head({ ...good, exportNames: "a" }))).toBeNull();
    expect(decodePreparedEntry(head({ ...good, importedNames: [{ specifier: "a" }] }))).toBeNull();
  });
});

describe("which files get an entry", () => {
  it("a large file of an installed package, and no other", () => {
    const inPackage =
      "/home/projects/app/node_modules/.pnpm/vite@5.4.21/node_modules/vite/dist/chunk.js";
    expect(isPreparable(inPackage, PREPARED_MIN_BYTES)).toBe(true);
    expect(isPreparable(inPackage, PREPARED_MIN_BYTES - 1)).toBe(false);
    expect(isPreparable("/home/projects/app/src/big.mjs", 10 * PREPARED_MIN_BYTES)).toBe(false);
  });
});
