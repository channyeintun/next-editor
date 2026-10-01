import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { CRITIC_VERSION, PERSONA_GUIDE_VERSION, critiqueScript } from "./critic";
import { extractNarration } from "./markers";
import { parseLessonScript, type LessonScript } from "./schema";

function loadPilot(name: string): LessonScript {
  return parseLessonScript(
    YAML.parse(readFileSync(resolve(__dirname, `./__fixtures__/${name}.yaml`), "utf8")),
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
    const critique = critiqueScript(script, extractedOf(script));
    expect(critique.version).toBe(CRITIC_VERSION);
    expect(critique.notes.filter((note) => note.id.startsWith("phrase."))).toEqual([]);
    expect(critique.notes.filter((note) => note.id === "sources.missing")).toEqual([]);
  });

  it("flags read-aloud register and suggests the contraction", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].narration = "It is a value. The compiler does not copy it. Let us run it.";
    const critique = critiqueScript(script, extractedOf(script));
    const register = critique.notes.filter((note) => note.id === "register.read-aloud");
    expect(register).toHaveLength(1);
    expect(register[0].sceneId).toBe(script.scenes[0].id);
    expect(register[0].message).toContain('"it is" → "it\'s"');
    expect(register[0].message).toContain('"does not" → "doesn\'t"');
    expect(register[0].message).toContain('"let us" → "let\'s"');
  });

  // The note is mandatory-fix, so it must never name a form that cannot contract
  // where it appears — an author applying it would otherwise write bad English.
  it("leaves uncontractible and ambiguous forms alone", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].narration =
      "Leave it as it is. Yes we will. And we have to name the owner, so you have two files.";
    const critique = critiqueScript(script, extractedOf(script));
    expect(critique.notes.filter((note) => note.id === "register.read-aloud")).toEqual([]);
  });

  it("accepts contracted, conversational narration", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].narration = "It's a value. The compiler doesn't copy it. Let's run it.";
    const critique = critiqueScript(script, extractedOf(script));
    expect(critique.notes.filter((note) => note.id === "register.read-aloud")).toEqual([]);
  });

  it("flags banned phrases with the scene they occur in", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].narration = "This is obviously easy. Simply run it.";
    const critique = critiqueScript(script, extractedOf(script));
    const phraseNotes = critique.notes.filter((note) => note.id.startsWith("phrase."));
    // Every distinct banned phrase, not just the first one found.
    expect(phraseNotes.map((note) => note.id).sort()).toEqual([
      "phrase.easy",
      "phrase.obviously",
      "phrase.simply",
    ]);
    expect(phraseNotes[0].sceneId).toBe("swap-function");
  });

  it("does not double-report a short banned phrase nested in a longer one", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].narration = "You just simply call it.";
    const critique = critiqueScript(script, extractedOf(script));
    expect(
      critique.notes.filter((note) => note.id.startsWith("phrase.")).map((note) => note.id),
    ).toEqual(["phrase.just-simply"]);
  });

  it("flags missing sources", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].sources = [];
    const critique = critiqueScript(script, extractedOf(script));
    expect(critique.notes.map((note) => note.id)).toContain("sources.missing");
  });

  // Scope and sentence length are shape, not defects: a survey lesson tours many
  // ideas across many scenes, and a word count says nothing about clarity.
  // Pacing is not judged either — before synthesis there is no audio to time.
  it("never flags a lesson for its length, scene count, sentence length, or pacing", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].narration =
      "This sentence keeps going and going and going and going and going and going and going and going and going and going and going and going far past any old ceiling.";
    const scene = script.scenes[0];
    script.scenes = Array.from({ length: 14 }, (_, index) => ({
      ...scene,
      id: `${scene.id}-${index}`,
    }));
    const ids = critiqueScript(script, extractedOf(script)).notes.map((note) => note.id);
    expect(ids).not.toContain("sentence.long");
    expect(ids).not.toContain("scope.scenes");
    expect(ids).not.toContain("scope.length");
    expect(ids.filter((id) => id.startsWith("pacing."))).toEqual([]);
  });

  it("cites the persona guide version, not the critic version", () => {
    const script = loadPilot("go-swap");
    script.scenes[0].narration = "This is obviously right.";
    const [note] = critiqueScript(script, extractedOf(script)).notes.filter(
      (candidate) => candidate.id === "phrase.obviously",
    );
    expect(note.message).toContain(`(persona guide v${PERSONA_GUIDE_VERSION})`);
  });

  it("flags markers no action references", () => {
    const script = loadPilot("go-swap");
    script.scenes[1].narration += " [[mark:leftover]] Done.";
    const critique = critiqueScript(script, extractedOf(script));
    expect(critique.notes.some((note) => note.id === "marker.unused")).toBe(true);
  });

  it("only proposes — no note carries a blocking severity", () => {
    const script = loadPilot("go-cube-tour");
    const critique = critiqueScript(script, extractedOf(script));
    expect(
      critique.notes.every((note) => note.severity === "note" || note.severity === "suggestion"),
    ).toBe(true);
  });
});
