import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  whiteboardAssetProblems,
  whiteboardLabelProblems,
  replayTypedFile,
} from "./crashCourseTestUtils";
import { parseLessonScript, type LessonScript } from "./script/schema";

/**
 * The Zig crash course has no compiler in this repo to check itself against —
 * zig-play.dev is a remote service and CI has no toolchain — so this file
 * guards everything that can be established without one, which is most of the
 * ways the lesson could quietly rot:
 *
 *  - the typing anchors still resolve, through the driver's own resolver, at
 *    the moment they are applied (the failure mode that aborts a render
 *    mid-performance);
 *  - the assertions only claim output the pinned fixture actually contains;
 *  - the program still uses the Zig 0.16 spellings. This is the important one.
 *    0.16 removed `GeneralPurposeAllocator` outright and made `std.ArrayList`
 *    unmanaged, so almost every Zig example written before it — including the
 *    ones a model reproduces from memory — fails to compile. A well-meaning
 *    edit toward the older, more familiar API would produce a lesson that
 *    reads fine and cannot run.
 *
 * The assembled program was compiled with Zig 0.16.0 and executed on
 * zig-play.dev when the lesson was authored; the fixture is that run's output.
 */

const scriptPath = resolve(process.cwd(), "src/studio/scripts/zig-crash-course.yaml");

describe("zig crash course", () => {
  let script: LessonScript;
  let program: string;
  let fixtureOutput: string;

  beforeAll(() => {
    script = parseLessonScript(YAML.parse(readFileSync(scriptPath, "utf8")));
    program = replayTypedFile(script, "main.zig");
    const runtime = script.runtime;
    if (runtime.kind !== "zig-playground") throw new Error("expected a zig-playground runtime");
    fixtureOutput = runtime.fixture.result.output;
  });

  it("runs on the Zig playground with one main.zig", () => {
    expect(script.lesson.workspace.lessonType).toBe("zig");
    expect(script.runtime.kind).toBe("zig-playground");
    expect(Object.keys(script.lesson.workspace.files)).toEqual(["main.zig"]);
  });

  it("asserts only output the pinned fixture really contains", () => {
    const asserted = script.scenes
      .flatMap((scene) => scene.actions ?? [])
      .filter((action) => action.type === "expect.output")
      .map((action) => action.contains);

    expect(asserted.length).toBeGreaterThan(0);
    for (const line of asserted) {
      expect(fixtureOutput, `asserted line: ${line}`).toContain(line);
    }
  });

  it("ends every fixture line, so a checkpoint cannot match a partial write", () => {
    expect(fixtureOutput.endsWith("\n")).toBe(true);
  });

  it("pins a fixture no console line of which can fail runtime.noErrors", () => {
    // qa.ts fails runtime.noErrors on ANY console line containing "error]",
    // and driver.ts aborts waitForOutput on the same prefix — the console is
    // never cleared between actions. A success fixture whose own program text
    // happened to contain that substring would fail the render at QA time
    // rather than here, so it is worth catching while the lesson is authored.
    expect(fixtureOutput).not.toContain("error]");

    const runtime = script.runtime;
    if (runtime.kind !== "zig-playground") throw new Error("expected a zig-playground runtime");
    // The lesson's single run must also succeed, for the same reason: a pinned
    // compile-error or runtime-error result emits "[zig-run error] …" itself.
    expect(runtime.fixture.result.status).toBe("success");
    expect(runtime.fixture.transientErrorKinds).toEqual([]);
  });

  it("prints the fixture's own words, one call per line bar the loop", () => {
    // The count budget is one short on purpose, and the margin is spent: the
    // program's 14 print calls produce the fixture's 15 lines because
    // `for (shapes) |shape| std.debug.print("area {d:.2}\n", …)` fires twice.
    // Drop any other print and this falls under the floor.
    expect(program).toContain("std.debug.print");
    const prints = program.split("std.debug.print").length - 1;
    expect(prints).toBeGreaterThanOrEqual(fixtureOutput.trimEnd().split("\n").length - 1);

    // A count alone cannot tell whether the two were edited apart — renaming
    // what a print says keeps it. So every format string's literal head, the
    // text before its first placeholder, has to appear in the pinned output.
    // The one format that opens on a placeholder has no head to check.
    const heads = [...program.matchAll(/std\.debug\.print\("((?:[^"\\]|\\.)*)"/g)]
      .map((match) => match[1].split("{")[0].replace(/\\n/g, "\n").replace(/\\"/g, '"'))
      .filter((head) => head.length > 0);
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(fixtureOutput, `printed text ${JSON.stringify(head)}`).toContain(head);
    }
  });

  it("uses the Zig 0.16 standard library, not the APIs it replaced", () => {
    expect(program).toContain("std.heap.DebugAllocator(.{})");
    // Unmanaged ArrayList: created empty, allocator handed to each call.
    expect(program).toContain(": std.ArrayList(u32) = .empty");
    expect(program).toContain("squares.append(allocator,");
    expect(program).toContain("squares.deinit(allocator)");

    // Removed in 0.16 — their presence means someone reverted to older Zig.
    expect(program).not.toContain("GeneralPurposeAllocator");
    expect(program).not.toContain("std.fs.File");
    expect(program).not.toContain("ArrayList(u32).init(");
    expect(program).not.toContain("std.io.getStdOut");
  });

  it("covers the ideas the lesson promises", () => {
    // One survey lesson, so the census is the syllabus: a scene that stops
    // typing its example still leaves the narration claiming it.
    const census: Array<[string, string]> = [
      ["optional", "?usize"],
      ["error union", "!u32"],
      ["catch", "catch |err|"],
      ["slice", "scores[1..4]"],
      ["string as bytes", "[]const u8"],
      ["tagged union", "union(enum)"],
      ["switch capture", "switch (self)"],
      ["defer", "defer "],
      ["allocator", "gpa.allocator()"],
      ["comptime generic", "comptime T: type"],
      ["comptime block", "const doubles = blk:"],
    ];
    const missing = census.filter(([, needle]) => !program.includes(needle)).map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("draws every whiteboard asset it references, and no orphans", () => {
    expect(whiteboardAssetProblems(script)).toEqual({ undeclared: [], neverDrawn: [] });
  });

  it("keeps every whiteboard label readable and on the canvas", () => {
    expect(whiteboardLabelProblems(script)).toEqual({
      tooSmall: [],
      overflowing: [],
      offCanvas: [],
    });
  });
});
