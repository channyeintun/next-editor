import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import { instantiateKiteCompiler, type KiteCompiler } from "../runtime/kitePlayground/compiler";
import { replayTypedFile } from "./crashCourseTestUtils";
import { parseLessonScript, type LessonScript } from "./script/schema";
import { KITE_KEYWORDS } from "../monaco/kiteLanguage";

/**
 * The Kite crash course is the one lesson whose pinned fixture can be checked
 * against the truth, because the compiler it claims to be quoting ships in this
 * repo. So it is: the lesson's typing actions are replayed the way the player
 * applies them, and the resulting program is compiled and run by the same
 * WebAssembly build the lesson uses at runtime.
 *
 * Without this, swapping `kite-compiler.wasm` for a newer build — or editing an
 * anchor by hand — would leave a lesson that plays a recorded success over a
 * program that no longer produces it, and nothing would fail.
 */

const scriptPath = resolve(process.cwd(), "src/studio/scripts/kite-crash-course.yaml");
const wasmPath = resolve(process.cwd(), "src/core/kite/build/kite-compiler.wasm");

describe("kite crash course", () => {
  let kite: KiteCompiler;
  let script: LessonScript;
  let program: string;

  beforeAll(async () => {
    kite = await instantiateKiteCompiler(readFileSync(wasmPath));
    script = parseLessonScript(YAML.parse(readFileSync(scriptPath, "utf8")));
    program = replayTypedFile(script, "main.kite");
  });

  it("types a program the bundled compiler accepts", () => {
    expect(kite.check(program)).toBe("");
  });

  it("prints exactly what the pinned fixture claims", () => {
    const fixture = script.runtime;
    expect(fixture.kind).toBe("kite-playground");
    if (fixture.kind !== "kite-playground") return;
    expect(kite.run(program)).toBe(fixture.fixture.result.stdout);
  });

  it("asserts only output the program really produces", () => {
    const stdout = kite.run(program);
    const asserted = script.scenes
      .flatMap((scene) => scene.actions ?? [])
      .filter((action) => action.type === "expect.output")
      .map((action) => action.contains);
    expect(asserted.length).toBeGreaterThan(0);
    for (const line of asserted) {
      expect(stdout, `asserted line: ${line}`).toContain(line);
    }
  });

  it("leaves the program formatted the one way", () => {
    // A learner who presses Format should see nothing move.
    expect(kite.format(program)).toBe(program);
  });

  it("writes every one of Kite's 27 keywords", () => {
    // Appendix B of the specification. A crash course that skips one is not
    // covering the language, and the census is asserted in the compiler too.
    // The list lives with the Monaco grammar so the editor and the lesson
    // cannot disagree about what a keyword is.
    expect(KITE_KEYWORDS).toHaveLength(27);
    const missing = KITE_KEYWORDS.filter(
      (word) => !new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`).test(program),
    );
    expect(missing).toEqual([]);
  });
});
