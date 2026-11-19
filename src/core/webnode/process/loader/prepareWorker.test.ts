// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodePreparedEntry } from "./preparedEntry";
import { prepareForKernel } from "./prepareWorker";
import { prepareSource, transformReady } from "./transform";

const text = (value: string) => new TextEncoder().encode(value);

describe("a worker asked to prepare one module", () => {
  it("answers with the entry of the source it was handed, as that file's", async () => {
    const source = 'import fs from "node:fs";\nexport const read = fs.readFileSync;\n';
    const filename = "/p/node_modules/pkg/index.mjs";
    const reply = await prepareForKernel({ type: "prepare", filename, source: text(source) });
    await transformReady;
    expect(reply.type).toBe("prepared");
    expect(decodePreparedEntry(reply.entry!)).toEqual(prepareSource(source, filename, "esm"));
  });

  it("answers with what a process would make itself of a source that does not parse", async () => {
    const source = 'import a from "a";\nexport const b = (;\n';
    const filename = "/p/node_modules/pkg/broken.mjs";
    const reply = await prepareForKernel({ type: "prepare", filename, source: text(source) });
    // The text as it is: the engine reports the error when it compiles it.
    expect(decodePreparedEntry(reply.entry!)).toEqual(prepareSource(source, filename, "esm"));
  });
});
