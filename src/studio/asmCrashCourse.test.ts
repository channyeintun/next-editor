import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import { parseLessonScript, type LessonScript } from "./script/schema";
import { AsmPlaygroundClient } from "../runtime/asmPlayground/client";
import {
  asmRegisterConsoleLines,
  asmRunResultToConsoleLines,
} from "../runtime/asmPlayground/console";

/**
 * The assembly crash course is the one lesson that can prove its own fixture.
 *
 * Every other language's authoring guide has to say "mentally execute the final
 * code and transcribe its output", because its compiler is a remote service and
 * CI has no toolchain. Assembly's assembler and machine are in this repo, so
 * this test does the thing the guide can only ask for: it replays the lesson's
 * typing insertions to reconstruct the exact program the viewer ends up with,
 * runs it, and compares the real output — and the real register readout —
 * against what the fixture pins.
 *
 * That closes the gap the "fixture must be the truth" rule exists to warn
 * about. If someone edits the program and forgets the fixture, or edits the
 * fixture and forgets the program, this fails here instead of failing a live
 * render later.
 *
 * It also guards the two mechanical ways a lesson rots: a typing anchor that no
 * longer resolves (which aborts a render mid-performance), and an
 * `expect.output` that claims something the console never prints.
 */

const scriptPath = resolve(process.cwd(), "src/studio/scripts/x86-64-assembly-crash-course.yaml");

/**
 * Where the `occurrence`-th match of `needle` ends, or -1.
 *
 * The player resolves anchors this way, so the replay has to as well: a
 * one-based occurrence, counted in the file *as it is at that moment*. A test
 * that demanded every anchor be unique would be stricter than the contract and
 * would reject `occurrence: 1` on a string that legitimately appears twice.
 */
function endOfOccurrence(haystack: string, needle: string, occurrence: number): number {
  if (needle === "") return 0;
  let index = -1;
  for (let found = 0; found < occurrence; found += 1) {
    index = haystack.indexOf(needle, index + 1);
    if (index === -1) return -1;
  }
  return index + needle.length;
}

/** Apply the lesson's `editor.type` insertions in order, as the player does. */
function replay(script: LessonScript): string {
  let file = script.lesson.workspace.files["main.asm"] ?? "";
  for (const scene of script.scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === "editor.type") {
        const after = action.target.after ?? "";
        const occurrence = action.target.occurrence ?? 1;
        const at = endOfOccurrence(file, after, occurrence);
        // Insert-only, and the anchor has to resolve at this moment — this is
        // the failure that aborts a render mid-performance.
        expect(at, `anchor for ${action.id}`).toBeGreaterThan(-1);
        file = file.slice(0, at) + action.text + file.slice(at);
      } else if (action.type === "editor.select") {
        const text = action.target.text ?? "";
        const occurrence = action.target.occurrence ?? 1;
        expect(endOfOccurrence(file, text, occurrence), `selection ${action.id}`).toBeGreaterThan(
          -1,
        );
      }
    }
  }
  return file;
}

describe("x86-64 assembly crash course", () => {
  let script: LessonScript;
  let program: string;
  let fixture: Extract<LessonScript["runtime"], { kind: "asm-playground" }>["fixture"];
  let result: Awaited<ReturnType<AsmPlaygroundClient["run"]>>;
  let consoleLines: string[];

  beforeAll(async () => {
    script = parseLessonScript(YAML.parse(readFileSync(scriptPath, "utf8")));
    program = replay(script);

    const runtime = script.runtime;
    if (runtime.kind !== "asm-playground") throw new Error("expected an asm-playground runtime");
    fixture = runtime.fixture;

    // One run, shared: the engine is deterministic, so running it four times
    // would only prove that four times.
    result = await new AsmPlaygroundClient().run({
      files: [{ path: "main.asm", content: program }],
    });
    consoleLines = [...asmRunResultToConsoleLines(result), ...asmRegisterConsoleLines(result)];
  });

  it("assembles and runs the program the lesson actually builds", () => {
    expect(result.status).toBe("success");
  });

  it("pins a fixture that is exactly what the program prints and exits with", () => {
    expect(result.stdout).toBe(fixture.result.stdout);
    expect(result.stderr).toBe(fixture.result.stderr);
    expect(result.exitCode).toBe(fixture.result.exitCode);
  });

  it("pins the registers the run really leaves behind", () => {
    // A fixture that names different registers, or the same ones with
    // different values, would replay a console the live runner never produces.
    expect(result.registers).toEqual(fixture.result.registers);
    expect(result.flags).toEqual(fixture.result.flags);
  });

  it("only asserts output the console really contains", () => {
    const asserted = script.scenes
      .flatMap((scene) => scene.actions ?? [])
      .filter((action) => action.type === "expect.output")
      .map((action) => (action as { contains: string }).contains);

    expect(asserted.length).toBeGreaterThan(0);
    for (const needle of asserted) {
      expect(consoleLines.join("\n"), `expect.output "${needle}"`).toContain(needle);
    }
  });

  it("asserts a final file the typing really produces", () => {
    const asserted = script.scenes
      .flatMap((scene) => scene.actions ?? [])
      .filter((action) => action.type === "expect.file")
      .map((action) => (action as { contains: string }).contains);

    for (const needle of asserted) {
      expect(program, `expect.file "${needle}"`).toContain(needle);
    }
  });

  it("teaches the Linux convention, not an invented one", () => {
    // The lesson's whole claim is that this is the real interface: the call
    // number in rax, the arguments in rdi/rsi/rdx, and exit as call 60. A
    // well-meaning edit toward a different register would make it fiction.
    expect(program).toContain("mov     rax, 1          ; 1 is write");
    expect(program).toContain("mov     rdi, 1          ; 1 is standard output");
    expect(program).toContain("mov     rax, 60");
    expect(program).toContain("$ - msg");
  });
});
