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
 * The Haskell crash course has no compiler in this repo to check itself
 * against — play.haskell.org is a remote service and CI has no GHC — so this
 * file guards everything that can be established without one:
 *
 *  - the typing anchors still resolve, through the driver's own resolver, at
 *    the moment they are applied (the failure mode that aborts a render
 *    mid-performance);
 *  - the assertions only claim output the pinned fixture actually contains;
 *  - the program stays inside what the playground can actually run. That is
 *    the important one here, and it is a different hazard from Zig's. Haskell's
 *    library APIs are stable, so nothing rots by age; what breaks a Haskell
 *    lesson is *scope*. The service compiles one string as a single module
 *    named Main, with only GHC's boot packages available and an empty stdin.
 *    An edit that adds a second module, imports something from Hackage, or
 *    reads input would read perfectly and could never run.
 *  - the program still compiles WITHOUT warnings. GHC reports warnings on a
 *    successful compile in its own channel, which the runner renders as
 *    `[haskell-warn]` console lines. The pinned fixture has no `warnings`
 *    field, so introducing a warning would make a live render disagree with
 *    the fixture the recorded lesson was built from.
 *
 * The assembled program was compiled with GHC 9.12.4 at -O1 and executed on
 * play.haskell.org when the lesson was authored; the fixture is that run's
 * exact stdout.
 */

const scriptPath = resolve(process.cwd(), "src/studio/scripts/haskell-crash-course.yaml");

/** The statements of `main`'s do block — one per line the program prints. */
function mainDoStatements(program: string): string[] {
  const start = program.indexOf("main = do\n");
  if (start < 0) throw new Error("expected a `main = do` block");
  return program
    .slice(start + "main = do\n".length)
    .split("\n")
    .filter((line) => line.startsWith("  ") && line.trim().length > 0);
}

describe("haskell crash course", () => {
  let script: LessonScript;
  let program: string;
  let fixtureStdout: string;

  beforeAll(() => {
    script = parseLessonScript(YAML.parse(readFileSync(scriptPath, "utf8")));
    program = replayTypedFile(script, "Main.hs");
    const runtime = script.runtime;
    if (runtime.kind !== "haskell-playground") {
      throw new Error("expected a haskell-playground runtime");
    }
    fixtureStdout = runtime.fixture.result.stdout;
  });

  it("runs on the Haskell playground with one Main.hs", () => {
    expect(script.lesson.workspace.lessonType).toBe("haskell");
    expect(script.runtime.kind).toBe("haskell-playground");
    expect(Object.keys(script.lesson.workspace.files)).toEqual(["Main.hs"]);
    expect(script.lesson.workspace.entryFilePath).toBe("Main.hs");
  });

  it("asserts only output the pinned fixture really contains", () => {
    const asserted = script.scenes
      .flatMap((scene) => scene.actions ?? [])
      .filter((action) => action.type === "expect.output")
      .map((action) => action.contains);

    expect(asserted.length).toBeGreaterThan(0);
    for (const line of asserted) {
      expect(fixtureStdout, `asserted line: ${line}`).toContain(line);
    }
  });

  it("ends every fixture line, so a checkpoint cannot match a partial write", () => {
    expect(fixtureStdout.endsWith("\n")).toBe(true);
  });

  it("asserts a final file the typing really produces", () => {
    // An expect.file needle the program never contains aborts the render at the
    // very last action, after every minute of narration has been synthesized —
    // and nothing offline catches it: the schema checks the path, not the text.
    const asserted = script.scenes
      .flatMap((scene) => scene.actions ?? [])
      .filter((action) => action.type === "expect.file")
      .map((action) => action.contains);

    expect(asserted.length).toBeGreaterThan(0);
    for (const needle of asserted) {
      expect(program, `expect.file "${needle}"`).toContain(needle);
    }
  });

  it("pins a fixture no console line of which can fail runtime.noErrors", () => {
    // qa.ts fails runtime.noErrors on ANY console line containing "error]",
    // and driver.ts aborts waitForOutput on the same prefix — the console is
    // never cleared between actions. A success fixture whose own program text
    // happened to contain that substring would fail the render at QA time
    // rather than here, so it is worth catching while the lesson is authored.
    expect(fixtureStdout).not.toContain("error]");

    const runtime = script.runtime;
    if (runtime.kind !== "haskell-playground") {
      throw new Error("expected a haskell-playground runtime");
    }
    // The lesson's single run must also succeed, for the same reason: a pinned
    // compile-error or runtime-error result emits "[haskell-run error] …".
    expect(runtime.fixture.result.status).toBe("success");
    expect(runtime.fixture.transientErrorKinds).toEqual([]);
    // The program writes nothing to stderr and produces no compiler warnings,
    // so a live render's console has to match the fixture's exactly.
    expect(runtime.fixture.result.stderr).toBe("");
    expect(runtime.fixture.result.warnings).toBeUndefined();
  });

  it("prints exactly one line per statement of main", () => {
    // Every statement in the do block is a putStrLn or a print of one value,
    // so the two counts are the same number or the fixture and the program
    // were edited apart.
    const statements = mainDoStatements(program);
    const fixtureLines = fixtureStdout.trimEnd().split("\n");
    expect(statements).toHaveLength(fixtureLines.length);
    for (const statement of statements) {
      expect(statement, "every do-block statement prints").toMatch(/^ {2}(putStrLn|print) /);
    }
  });

  it("stays inside what the playground can run: one module, no imports, no stdin", () => {
    // play.haskell.org compiles the editor's single file as module Main. There
    // is no cabal file, no package manager, and no second module.
    expect(program.match(/^module .* where$/gm)).toHaveLength(1);
    expect(program).toContain("module Main where");
    // Only GHC boot packages exist upstream, and this lesson deliberately needs
    // none of them — an import added later is the first thing to check when a
    // live render starts failing.
    expect(program.match(/^import /gm)).toBeNull();
    // stdin is empty upstream: getContents returns "" and getLine throws.
    expect(program).not.toMatch(/\bgetContents\b|\bgetLine\b|\breadLn\b|\binteract\b/);
  });

  it("compiles clean: no partial functions GHC warns about", () => {
    // `head` and `tail` are the two the default `-Wx-partial` actually fires
    // on (checked against GHC 9.12.4 on the playground — `last`, `init`,
    // `maximum`, `foldr1` and `!!` are equally partial but warn-free), and a
    // single warning would add "[haskell-warn]" console lines the fixture does
    // not pin. They are also the two a rewrite reaches for first.
    const warned = ["head", "tail"];
    const used = warned.filter((name) => new RegExp(`\\b${name}\\b`).test(program));
    expect(used, "partial Prelude functions that warn under -Wx-partial").toEqual([]);
  });

  it("covers the ideas the lesson promises", () => {
    // One survey lesson, so the census is the syllabus: a scene that stops
    // typing its example still leaves the narration claiming it.
    const census: Array<[string, string]> = [
      ["type signature on its own line", "add :: Int -> Int -> Int"],
      ["currying / partial application", "(add 10)"],
      ["guards", '  | otherwise = "C"'],
      ["sum type", "  = Square Int\n  | Rect Int Int"],
      ["deriving", "deriving (Show)"],
      ["pattern match on constructors", "area (Square side) = side * side"],
      ["Maybe", "Maybe Int"],
      ["Nothing", "firstEven [] = Nothing"],
      ["recursion", "| otherwise = firstEven xs"],
      ["Either", "Either String Int"],
      ["Left carries a reason", 'Left "cannot divide by zero"'],
      ["laziness / infinite list", "[1 ..]"],
      ["fold", "foldr (+) 0"],
      ["record fields", "  { name :: String"],
      ["type class", "class Describe a where"],
      ["two instances of one class", "instance Describe User where"],
      ["IO do block", "main = do"],
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
