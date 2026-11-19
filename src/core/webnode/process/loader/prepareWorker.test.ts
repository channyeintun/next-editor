// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodePreparedEntry } from "./preparedEntry";
import { prepareForKernel } from "./prepareWorker";
import { prepareSource, transformReady } from "./transform";

const text = (value: string) => new TextEncoder().encode(value);
const FILE = "/p/node_modules/pkg/index.mjs";

describe("the worker asked to prepare a module", () => {
  it("makes the entry with the Rust rewriter, with no need of sucrase", async () => {
    const source = 'import fs from "node:fs";\nexport const read = fs.readFileSync;\n';
    const reply = await prepareForKernel({
      type: "prepare",
      filename: FILE,
      source: text(source),
      fallback: false,
    });
    await transformReady;
    const entry = decodePreparedEntry(reply.entry!)!;
    const bySucrase = prepareSource(source, FILE, "esm");
    // The rewriter's own names: sucrase did not write this code.
    expect(entry.code).toContain("__wnr_");
    expect({ ...entry, code: "" }).toEqual({ ...bySucrase, code: "" });
  });

  it("makes no entry of a module the rewriter declines, unless sucrase may", async () => {
    // A module that uses the rewriter's own names is one it leaves alone.
    const source = 'import fs from "node:fs";\nexport const __wnr_taken = fs;\n';
    const request = { type: "prepare", filename: FILE, source: text(source) } as const;
    expect(await prepareForKernel({ ...request, fallback: false })).toEqual({
      type: "prepared",
      entry: null,
    });
    const reply = await prepareForKernel({ ...request, source: text(source), fallback: true });
    expect(decodePreparedEntry(reply.entry!)).toEqual(prepareSource(source, FILE, "esm"));
  });
});
