// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lessonScriptPath } from "../lessonScriptsDir.ts";
import { publishedScriptFileOf } from "../../src/studio/plans/publishedScriptEntry.ts";
import { localScriptId } from "./publishedCheck.ts";

describe("local script id", () => {
  it("is the id a publish gives the same file", async () => {
    const published = await publishedScriptFileOf(readFileSync(lessonScriptPath("rust-borrow")));
    expect(await localScriptId("rust-borrow")).toBe(published.entry.id);
  });

  it("is null for a lesson this checkout has no script for", async () => {
    expect(await localScriptId("no-such-lesson-anywhere")).toBeNull();
  });
});
