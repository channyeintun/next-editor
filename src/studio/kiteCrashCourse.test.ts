import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import { instantiateKiteCompiler, type KiteCompiler } from "../runtime/kitePlayground/compiler";
import { parseLessonScript, type LessonScript } from "./script/schema";

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

/** Apply the lesson's `editor.type` insertions in order, as the player does. */
function replay(script: LessonScript): string {
  let file = script.lesson.workspace.files["main.kite"] ?? "";
  for (const scene of script.scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === "editor.type") {
        const after = action.target.after ?? "";
        // Insert-only, and the anchor must be unambiguous at this moment —
        // the same two rules the schema documents for authors.
        expect(file.split(after).length - 1, `anchor for ${action.id}`).toBe(1);
        const at = file.indexOf(after) + after.length;
        file = file.slice(0, at) + action.text + file.slice(at);
      } else if (action.type === "editor.select") {
        expect(file.split(action.target.text ?? "").length - 1, `selection ${action.id}`).toBe(1);
      }
    }
  }
  return file;
}

describe("kite crash course", () => {
  let kite: KiteCompiler;
  let script: LessonScript;
  let program: string;

  beforeAll(async () => {
    kite = await instantiateKiteCompiler(readFileSync(wasmPath));
    script = parseLessonScript(YAML.parse(readFileSync(scriptPath, "utf8")));
    program = replay(script);
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
    const census = [
      "async",
      "await",
      "as",
      "break",
      "continue",
      "for",
      "if",
      "else",
      "match",
      "return",
      "check",
      "defer",
      "enum",
      "struct",
      "trait",
      "type",
      "false",
      "true",
      "nil",
      "fn",
      "impl",
      "in",
      "let",
      "var",
      "pub",
      "self",
      "use",
    ];
    expect(census).toHaveLength(27);
    const missing = census.filter(
      (word) => !new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`).test(program),
    );
    expect(missing).toEqual([]);
  });
});
