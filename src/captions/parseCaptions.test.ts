import { describe, expect, it } from "vitest";
import { parseVtt, parseSrt, detectAndParse, inferLanguageFromFilename } from "./parseCaptions";

describe("parseVtt", () => {
  it("parses basic VTT with WEBVTT header", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.500
This is a test`;

    const cues = parseVtt(vtt);
    expect(cues).toEqual([
      { start: 1000, end: 4000, text: "Hello world" },
      { start: 5000, end: 8500, text: "This is a test" },
    ]);
  });

  it("handles HH:MM:SS.mmm timestamps", () => {
    const vtt = `WEBVTT

01:02:03.456 --> 01:02:10.000
Long video cue`;

    const cues = parseVtt(vtt);
    expect(cues).toEqual([{ start: 3723456, end: 3730000, text: "Long video cue" }]);
  });

  it("handles MM:SS.mmm timestamps (no hours)", () => {
    const vtt = `WEBVTT

02:03.456 --> 02:10.000
Short format`;

    const cues = parseVtt(vtt);
    expect(cues).toEqual([{ start: 123456, end: 130000, text: "Short format" }]);
  });

  it("strips inline VTT tags", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Speaker>Hello <c.highlight>world</c></v>`;

    const cues = parseVtt(vtt);
    expect(cues[0].text).toBe("Hello world");
  });

  it("skips NOTE and STYLE blocks", () => {
    const vtt = `WEBVTT

NOTE
This is a comment

STYLE
::cue { color: white; }

00:00:01.000 --> 00:00:04.000
Actual content`;

    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Actual content");
  });

  it("skips cue identifiers", () => {
    const vtt = `WEBVTT

intro
00:00:01.000 --> 00:00:04.000
First cue

outro
00:00:05.000 --> 00:00:08.000
Second cue`;

    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("First cue");
    expect(cues[1].text).toBe("Second cue");
  });

  it("handles multi-line cue text", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Line one
Line two`;

    const cues = parseVtt(vtt);
    expect(cues[0].text).toBe("Line one\nLine two");
  });

  it("handles cue settings after timestamp", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000 position:10% align:start
Positioned cue`;

    const cues = parseVtt(vtt);
    expect(cues[0]).toEqual({
      start: 1000,
      end: 4000,
      text: "Positioned cue",
    });
  });

  it("drops zero/negative duration cues", () => {
    const vtt = `WEBVTT

00:00:04.000 --> 00:00:04.000
Zero duration

00:00:05.000 --> 00:00:03.000
Negative duration

00:00:06.000 --> 00:00:08.000
Valid cue`;

    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Valid cue");
  });

  it("sorts cues by start time", () => {
    const vtt = `WEBVTT

00:00:05.000 --> 00:00:08.000
Second

00:00:01.000 --> 00:00:04.000
First`;

    const cues = parseVtt(vtt);
    expect(cues[0].text).toBe("First");
    expect(cues[1].text).toBe("Second");
  });

  it("returns empty array for empty input", () => {
    expect(parseVtt("")).toEqual([]);
    expect(parseVtt("WEBVTT\n\n")).toEqual([]);
  });

  it("handles \\r\\n line endings", () => {
    const vtt = "WEBVTT\r\n\r\n00:00:01.000 --> 00:00:04.000\r\nHello\r\n";
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Hello");
  });
});

describe("parseSrt", () => {
  it("parses basic SRT with comma milliseconds", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,500
This is a test`;

    const cues = parseSrt(srt);
    expect(cues).toEqual([
      { start: 1000, end: 4000, text: "Hello world" },
      { start: 5000, end: 8500, text: "This is a test" },
    ]);
  });

  it("handles SRT with dot milliseconds", () => {
    const srt = `1
00:00:01.000 --> 00:00:04.000
Dot format`;

    const cues = parseSrt(srt);
    expect(cues[0]).toEqual({ start: 1000, end: 4000, text: "Dot format" });
  });

  it("handles multi-line cue text", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two
Line three`;

    const cues = parseSrt(srt);
    expect(cues[0].text).toBe("Line one\nLine two\nLine three");
  });

  it("strips HTML-like tags from SRT", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
<i>Italic</i> and <b>bold</b>`;

    const cues = parseSrt(srt);
    expect(cues[0].text).toBe("Italic and bold");
  });

  it("drops invalid cues and sorts by start time", () => {
    const srt = `2
00:00:05,000 --> 00:00:08,000
Second

1
00:00:01,000 --> 00:00:04,000
First

3
00:00:10,000 --> 00:00:10,000
Zero duration`;

    const cues = parseSrt(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("First");
    expect(cues[1].text).toBe("Second");
  });

  it("returns empty array for empty input", () => {
    expect(parseSrt("")).toEqual([]);
  });

  it("handles \\r\\n line endings", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\n";
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Hello");
  });
});

describe("detectAndParse", () => {
  it("detects VTT by extension", () => {
    const cues = detectAndParse("captions.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello");
    expect(cues).toHaveLength(1);
  });

  it("detects SRT by extension", () => {
    const cues = detectAndParse("captions.srt", "1\n00:00:01,000 --> 00:00:04,000\nHello");
    expect(cues).toHaveLength(1);
  });

  it("detects VTT by content when extension is unknown", () => {
    const cues = detectAndParse("captions.txt", "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello");
    expect(cues).toHaveLength(1);
  });

  it("detects SRT by content when extension is unknown", () => {
    const cues = detectAndParse("captions.txt", "1\n00:00:01,000 --> 00:00:04,000\nHello");
    expect(cues).toHaveLength(1);
  });
});

describe("inferLanguageFromFilename", () => {
  it("extracts language from filename suffix", () => {
    expect(inferLanguageFromFilename("captions.en.vtt")).toBe("en");
    expect(inferLanguageFromFilename("captions.es.srt")).toBe("es");
    expect(inferLanguageFromFilename("my-video.ar.vtt")).toBe("ar");
  });

  it("handles BCP-47 tags with region", () => {
    expect(inferLanguageFromFilename("captions.en-US.vtt")).toBe("en-us");
    expect(inferLanguageFromFilename("captions.pt-BR.srt")).toBe("pt-br");
  });

  it("returns null when no language suffix", () => {
    expect(inferLanguageFromFilename("captions.vtt")).toBeNull();
    expect(inferLanguageFromFilename("my-file.srt")).toBeNull();
  });
});
