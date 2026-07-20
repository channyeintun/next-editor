import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { canonicalJson } from "../hash";
import { estimateAlignment } from "./alignment";
import { CompileError, compileLessonScript, type CompileInput } from "./compile";
import { LEXICON_V1, speechTextOf, spokenFormOf } from "./lexicon";
import { extractNarration } from "./markers";
import { parseLessonScript, type LessonScript } from "./schema";

const PILOT_PATH = resolve(__dirname, "../scripts/go-cube.yaml");
const PILOT_DURATION_MS = 21_778;

function loadPilotScript(): LessonScript {
  return parseLessonScript(YAML.parse(readFileSync(PILOT_PATH, "utf8")));
}

function compileInputFor(script: LessonScript, durationMs = PILOT_DURATION_MS): CompileInput {
  const extracted = extractNarration(
    script.scenes.map((scene) => ({ sceneId: scene.id, narration: scene.narration })),
  );
  return {
    script,
    extracted,
    alignment: estimateAlignment(extracted.tokens, durationMs, LEXICON_V1),
    narration: { audioPath: "/studio-fixtures/cache/test.m4a", mimeType: "audio/mp4", durationMs },
  };
}

describe("lexicon", () => {
  it("applies to the token core and keeps punctuation", () => {
    expect(spokenFormOf("Println,", LEXICON_V1)).toBe("print linn,");
    expect(spokenFormOf("(fmt)", LEXICON_V1)).toBe("(fumt)");
    expect(spokenFormOf("unknown.", LEXICON_V1)).toBe("unknown.");
  });

  it("builds speech text without touching display tokens", () => {
    const tokens = ["Call", "Println", "now."];
    expect(speechTextOf(tokens, LEXICON_V1)).toBe("Call print linn now.");
    expect(tokens[1]).toBe("Println");
  });
});

describe("compileLessonScript", () => {
  it("compiles the checked-in pilot script into a valid plan", () => {
    const { plan, warnings } = compileLessonScript(compileInputFor(loadPilotScript()));

    expect(plan.lesson.slug).toBe("go-cube");
    expect(plan.gates?.timingP95MaxMs).toBe(300);
    expect(plan.narration.captions.cues.length).toBeGreaterThan(3);
    // Derived attention-cursor moves precede the actions they announce.
    const ids = plan.actions.map((action) => action.id);
    expect(ids.indexOf("cursor-open-square")).toBeLessThan(ids.indexOf("open-square"));
    expect(ids.indexOf("cursor-run")).toBeLessThan(ids.indexOf("run"));
    expect(warnings.length).toBeLessThanOrEqual(2);
  });

  it("is deterministic — identical inputs produce identical plans", () => {
    const first = compileLessonScript(compileInputFor(loadPilotScript()));
    const second = compileLessonScript(compileInputFor(loadPilotScript()));
    expect(canonicalJson(second.plan)).toBe(canonicalJson(first.plan));
  });

  it("fails before render on an unknown marker", () => {
    const script = loadPilotScript();
    const open = script.scenes[0].actions.find((action) => action.id === "open-square")!;
    open.at = { mark: "no-such-mark", offsetMs: 0 };
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(/Unknown marker/);
  });

  it("fails before render when typing cannot fit before the next action", () => {
    const script = loadPilotScript();
    const typeCube = script.scenes[0].actions.find((action) => action.id === "type-cube");
    if (typeCube?.type !== "editor.type") throw new Error("pilot lost its typing action");
    // Repeat the payload until it cannot finish before the next authored action.
    typeCube.text = typeCube.text.repeat(6);
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(CompileError);
  });

  it("fails before render when an action lands after the narration ends", () => {
    const script = loadPilotScript();
    const run = script.scenes[1].actions.find((action) => action.id === "run")!;
    run.at = { mark: "run", offsetMs: 25_000 };
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(CompileError);
  });

  it("resolves afterAction chains and rejects cycles", () => {
    const script = loadPilotScript();
    const expectOutput = script.scenes[1].actions.find((action) => action.id === "expect-output")!;
    const run = script.scenes[1].actions.find((action) => action.id === "run")!;
    // run → after expect-output → after run: a cycle.
    run.at = { afterAction: "expect-output" };
    expectOutput.at = { afterAction: "run" };
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(/cycle/);
  });
});

describe("lessonScriptSchema", () => {
  it("accepts the checked-in pilot", () => {
    const script = loadPilotScript();
    expect(script.scenes).toHaveLength(2);
    expect(script.scenes.every((scene) => scene.sources.length > 0)).toBe(true);
  });

  it("rejects actions referencing files outside the pinned workspace", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.scenes[0].actions[0].path = "missing.go";
    expect(() => parseLessonScript(raw)).toThrow(/not in the pinned workspace/);
  });

  it("rejects unknown afterAction references", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.scenes[1].actions[3].at = { afterAction: "ghost" };
    expect(() => parseLessonScript(raw)).toThrow(/unknown action "ghost"/);
  });
});
