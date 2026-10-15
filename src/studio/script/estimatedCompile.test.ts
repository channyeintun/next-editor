import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import {
  compileWithEstimatedNarration,
  estimateByCharacters,
  estimateByTokens,
  narrationOf,
} from "./estimatedCompile";
import { parseLessonScript, type LessonScript } from "./schema";

const FIXTURE_PATH = resolve(__dirname, "./__fixtures__/go-swap.yaml");

function fixtureWith(locale: string, narration: string): LessonScript {
  const raw = YAML.parse(readFileSync(FIXTURE_PATH, "utf8"));
  raw.lesson.locale = locale;
  raw.scenes[0].narration = `${narration} ${raw.scenes[0].narration}`;
  return parseLessonScript(raw);
}

describe("estimated dialog lengths", () => {
  const dialog = { id: "a.0", sceneId: "a", firstTokenIndex: 0, tokens: ["one", "two", "three"] };

  it("estimates by whitespace tokens", () => {
    expect(estimateByTokens(dialog, "ignored")).toBe(400 + 3 * 320);
  });

  it("estimates by speech-text characters, which Burmese needs", () => {
    // One Burmese "word" can be a whole clause, so tokens say little about its length.
    expect(estimateByCharacters(70)(dialog, "မင်္ဂလာပါ")).toBe(400 + "မင်္ဂလာပါ".length * 70);
  });
});

describe("narrationOf", () => {
  it("speaks each dialog with the lexicon of the script's locale", () => {
    // English gets the Pocket respellings; Burmese only its short list, which leaves HTML alone.
    const english = narrationOf(fixtureWith("en-US", "HTML first."));
    const burmese = narrationOf(fixtureWith("my-MM", "HTML first."));
    expect(english.speechTexts[0]).toMatch(/^H T M L first\./);
    expect(burmese.speechTexts[0]).toMatch(/^HTML first\./);
    expect(english.speechTexts).toHaveLength(english.dialogs.length);
  });
});

describe("compileWithEstimatedNarration", () => {
  it("compiles a plan whose narration is as long as the estimated schedule", () => {
    const script = fixtureWith("en-US", "Quick note.");
    const { plan, schedule } = compileWithEstimatedNarration(script, estimateByTokens);
    expect(plan.narration.expectedDurationMs).toBe(schedule.totalDurationMs);
    expect(plan.actions.map((action) => action.id)).toContain("type-swap");
  });

  it("stretches the narration when dialogs are estimated longer", () => {
    const script = fixtureWith("en-US", "Quick note.");
    const fast = compileWithEstimatedNarration(script, estimateByCharacters(55));
    const slow = compileWithEstimatedNarration(script, estimateByCharacters(95));
    expect(slow.schedule.totalDurationMs).toBeGreaterThan(fast.schedule.totalDurationMs);
  });
});
