import { describe, expect, it } from "vitest";
import { parseVtt } from "./parseCaptions";
import { serializeCuesToVtt } from "./serializeVtt";

describe("serializeCuesToVtt", () => {
  it("round-trips cues through parseVtt", () => {
    const cues = [
      { start: 1000, end: 2500, text: "Hello world" },
      { start: 3_661_250, end: 3_665_000, text: "line one\nline two" },
    ];

    const vtt = serializeCuesToVtt(cues);

    expect(vtt.startsWith("WEBVTT\n")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:02.500");
    expect(vtt).toContain("01:01:01.250 --> 01:01:05.000");
    expect(parseVtt(vtt)).toEqual(cues);
  });

  it("drops invalid cues and sorts by start time", () => {
    const vtt = serializeCuesToVtt([
      { start: 5000, end: 6000, text: "second" },
      { start: 2000, end: 1000, text: "end before start" },
      { start: 1000, end: 2000, text: "   " },
      { start: 0, end: 900, text: "first" },
    ]);

    expect(parseVtt(vtt)).toEqual([
      { start: 0, end: 900, text: "first" },
      { start: 5000, end: 6000, text: "second" },
    ]);
  });

  it("flattens blank lines inside cue text so the cue survives parsing whole", () => {
    const vtt = serializeCuesToVtt([{ start: 0, end: 1000, text: "before\n\n\nafter" }]);

    expect(parseVtt(vtt)).toEqual([{ start: 0, end: 1000, text: "before\nafter" }]);
  });
});
