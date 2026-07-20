import { describe, expect, it } from "vite-plus/test";
import { MarkerError, displayTextOf, extractNarration, requireMarker } from "./markers";

describe("extractNarration", () => {
  it("extracts tokens and binds markers to the next token", () => {
    const extracted = extractNarration([
      { sceneId: "a", narration: "Hello there. [[mark:mid]] General Kenobi." },
    ]);
    expect(extracted.tokens).toEqual(["Hello", "there.", "General", "Kenobi."]);
    expect(requireMarker(extracted, "mid").beforeTokenIndex).toBe(2);
    expect(displayTextOf(extracted)).toBe("Hello there. General Kenobi.");
  });

  it("binds a trailing marker to the narration end", () => {
    const extracted = extractNarration([{ sceneId: "a", narration: "Run it. [[mark:end]]" }]);
    expect(requireMarker(extracted, "end").beforeTokenIndex).toBe(2);
  });

  it("tracks scene token offsets across scenes", () => {
    const extracted = extractNarration([
      { sceneId: "a", narration: "one two" },
      { sceneId: "b", narration: "[[mark:b-start]] three four" },
    ]);
    expect(extracted.scenes[1].firstTokenIndex).toBe(2);
    expect(requireMarker(extracted, "b-start").beforeTokenIndex).toBe(2);
  });

  it("rejects duplicate markers across scenes", () => {
    expect(() =>
      extractNarration([
        { sceneId: "a", narration: "x [[mark:dup]] y" },
        { sceneId: "b", narration: "z [[mark:dup]] w" },
      ]),
    ).toThrow(MarkerError);
  });

  it("rejects malformed markers instead of narrating them", () => {
    expect(() => extractNarration([{ sceneId: "a", narration: "x [[mark:oops y" }])).toThrow(
      /malformed marker/,
    );
  });

  it("rejects scenes that are only markers", () => {
    expect(() => extractNarration([{ sceneId: "a", narration: "[[mark:only]]" }])).toThrow(
      /no narration text/,
    );
  });

  it("names known markers when an unknown one is requested", () => {
    const extracted = extractNarration([{ sceneId: "a", narration: "x [[mark:known]] y" }]);
    expect(() => requireMarker(extracted, "missing")).toThrow(/known markers: known/);
  });
});
