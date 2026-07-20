import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { CRITIC_VERSION, critiqueScript } from "./critic";
import { extractNarration } from "./markers";
import { parseLessonScript, type LessonScript } from "./schema";

function loadPilot(name: string): LessonScript {
  return parseLessonScript(
    YAML.parse(readFileSync(resolve(__dirname, `../scripts/${name}.yaml`), "utf8")),
  );
}

function extractedOf(script: LessonScript) {
  return extractNarration(
    script.scenes.map((scene) => ({ sceneId: scene.id, narration: scene.narration })),
  );
}

describe("critiqueScript", () => {
  it("leaves clean pilots without blocking notes", () => {
    const script = loadPilot("go-swap");
    const critique = critiqueScript(script, extractedOf(script), 19_375);
    expect(critique.version).toBe(CRITIC_VERSION);
    expect(critique.notes.filter((note) => note.id.startsWith("phrase."))).toEqual([]);
    expect(critique.notes.filter((note) => note.id === "sources.missing")).toEqual([]);
  });

  it("flags banned phrases with the scene they occur in", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].narration = "This is obviously easy. Simply run it.";
    const critique = critiqueScript(script, extractedOf(script), 19_375);
    const phraseNotes = critique.notes.filter((note) => note.id.startsWith("phrase."));
    expect(phraseNotes.length).toBeGreaterThan(0);
    expect(phraseNotes[0].sceneId).toBe("swap-function");
  });

  it("flags missing sources and over-long sentences", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].sources = [];
    script.scenes[0].narration =
      "This sentence keeps going and going and going and going and going and going and going and going and going and going and going and going far past the ceiling.";
    const critique = critiqueScript(script, extractedOf(script), 19_375);
    const ids = critique.notes.map((note) => note.id);
    expect(ids).toContain("sources.missing");
    expect(ids).toContain("sentence.long");
  });

  it("flags out-of-band pacing in both directions", () => {
    const script = loadPilot("go-swap");
    const extracted = extractedOf(script);
    const fast = critiqueScript(script, extracted, 10_000);
    const slow = critiqueScript(script, extracted, 60_000);
    expect(fast.notes.some((note) => note.id === "pacing.fast")).toBe(true);
    expect(slow.notes.some((note) => note.id === "pacing.slow")).toBe(true);
  });

  it("flags markers no action references", () => {
    const script = loadPilot("go-swap");
    script.scenes[1].narration += " [[mark:leftover]] Done.";
    const critique = critiqueScript(script, extractedOf(script), 19_375);
    expect(critique.notes.some((note) => note.id === "marker.unused")).toBe(true);
  });

  it("only proposes — no note carries a blocking severity", () => {
    const script = loadPilot("go-cube-tour");
    const critique = critiqueScript(script, extractedOf(script), 42_323);
    expect(
      critique.notes.every((note) => note.severity === "note" || note.severity === "suggestion"),
    ).toBe(true);
  });
});
