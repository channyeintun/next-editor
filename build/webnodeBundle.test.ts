// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildWebnodeBundles, WEBNODE_BUNDLE_FILES } from "./webnodeBundle";

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
