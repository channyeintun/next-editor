// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { buildWebnodeBundles, WEBNODE_BUNDLE_FILES, webnodeTransformId } from "./webnodeBundle";

describe("the name of the loader's rewrite", () => {
  // It is a hash of the rewrite's own file and of what that file calls. A
  // module of the engine it came to import would change the rewritten code
  // without changing the name, and a browser would run what an older rewrite
  // made (src/core/webnode/process/loader/preparedEntry.ts).
  it("covers the rewrite: its source imports packages alone", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/core/webnode/process/loader/transform.ts", import.meta.url)),
      "utf8",
    );
    const imported = [...source.matchAll(/^import\b[^;]*?\bfrom\s+"([^"]+)";/gms)].map(
      (match) => match[1],
    );
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((specifier) => specifier.startsWith("."))).toEqual([]);
  });

  it("is in the scripts that make and read prepared modules", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "webnode-bundle-"));
    try {
      await buildWebnodeBundles({ outDir, minify: true });
      const id = webnodeTransformId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(readFileSync(join(outDir, WEBNODE_BUNDLE_FILES.kernel), "utf8")).toContain(id);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("the webnode runtime's scripts", () => {
  const outDir = mkdtempSync(join(tmpdir(), "webnode-bundle-"));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  // One character outside ASCII and the browser keeps the whole script at two
  // bytes a character, in every process worker: 3 MB more for each process.
  it("are written in ASCII alone", async () => {
    await buildWebnodeBundles({ outDir, minify: true });
    for (const file of Object.values(WEBNODE_BUNDLE_FILES)) {
      const found = /[\u0080-￿]/.exec(readFileSync(join(outDir, file), "utf8"));
      expect(found?.[0] ?? null, `a character outside ASCII in ${file}`).toBeNull();
    }
  }, 120_000);
});
