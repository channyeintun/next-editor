import { describe, expect, it } from "vite-plus/test";
import { normalizeCues } from "./cues";

describe("normalizeCues", () => {
  it("drops cues that start before zero, end at or before their start, or have no text", () => {
    expect(
      normalizeCues([
        { start: -100, end: 500, text: "before zero" },
        { start: 1000, end: 1000, text: "zero length" },
        { start: 2000, end: 1500, text: "ends first" },
        { start: 3000, end: 4000, text: " \n " },
        { start: 5000, end: 6000, text: "kept" },
      ]),
    ).toEqual([{ start: 5000, end: 6000, text: "kept" }]);
  });

  it("sorts the cues it keeps by start time", () => {
    expect(
      normalizeCues([
        { start: 4000, end: 5000, text: "third" },
        { start: 0, end: 900, text: "first" },
        { start: 1000, end: 2000, text: "second" },
      ]).map((cue) => cue.text),
    ).toEqual(["first", "second", "third"]);
  });
});
