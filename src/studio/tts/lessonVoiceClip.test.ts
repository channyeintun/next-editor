import { describe, expect, it } from "vite-plus/test";
import type { OwnedLesson } from "@next-editor/infra";
import {
  CLIP_NAME_TITLE_LIMIT,
  clampClipStart,
  clipLengthChoices,
  clipVoiceName,
  defaultClipLength,
  formatClipTime,
  lessonClipSources,
  lessonNeUrl,
  maxClipStart,
  suggestClipStart,
} from "./lessonVoiceClip";

const ORIGIN = "https://next-editor.example";

function ownedLesson(overrides: Partial<OwnedLesson>): OwnedLesson {
  return {
    id: "lesson-1",
    slug: "lesson-1",
    title: "Lesson",
    description: "",
    thumbnail: "",
    ne: "media/lessons/lesson-1/lesson-1.ne",
    duration: null,
    tags: [],
    status: "published",
    publishedAt: null,
    ...overrides,
  };
}

describe("lessonNeUrl", () => {
  it("resolves the stored media path against the site, as the player's /${lesson.ne}", () => {
    expect(lessonNeUrl("media/lessons/a/a.ne", ORIGIN)).toBe(
      "https://next-editor.example/media/lessons/a/a.ne",
    );
  });

  it("keeps an absolute URL", () => {
    expect(lessonNeUrl("https://cdn.example/x.ne", ORIGIN)).toBe("https://cdn.example/x.ne");
  });

  it("gives nothing for an empty path", () => {
    expect(lessonNeUrl("", ORIGIN)).toBeNull();
  });
});

describe("lessonClipSources", () => {
  it("lists the /api/lessons/mine rows in order, marking drafts", () => {
    const sources = lessonClipSources(
      [
        ownedLesson({ id: "a", title: "Ownership", status: "published", ne: "media/a.ne" }),
        ownedLesson({ id: "b", title: "  Borrowing ", status: "draft", ne: "media/b.ne" }),
      ],
      ORIGIN,
    );
    expect(sources).toEqual([
      {
        id: "a",
        title: "Ownership",
        label: "Ownership",
        neUrl: "https://next-editor.example/media/a.ne",
      },
      {
        id: "b",
        title: "Borrowing",
        label: "Borrowing (draft)",
        neUrl: "https://next-editor.example/media/b.ne",
      },
    ]);
  });

  it("skips a lesson without a .ne and names an untitled one", () => {
    const sources = lessonClipSources(
      [ownedLesson({ id: "a", ne: "" }), ownedLesson({ id: "b", title: " " })],
      ORIGIN,
    );
    expect(sources.map((source) => [source.id, source.label])).toEqual([["b", "Untitled lesson"]]);
  });
});

describe("clip lengths", () => {
  it("offers the standard lengths that fit the narration", () => {
    expect(clipLengthChoices(600)).toEqual([10, 15, 20]);
    expect(clipLengthChoices(16)).toEqual([10, 15]);
    expect(clipLengthChoices(12.3)).toEqual([10]);
  });

  it("offers the whole of a short narration down to the VoxCPM2 minimum, and nothing below it", () => {
    expect(clipLengthChoices(7.8)).toEqual([7.5]);
    expect(clipLengthChoices(5)).toEqual([5]);
    expect(clipLengthChoices(4.9)).toEqual([]);
  });

  it("starts at 15s, or the longest shorter length that fits", () => {
    expect(defaultClipLength([10, 15, 20])).toBe(15);
    expect(defaultClipLength([10])).toBe(10);
    expect(defaultClipLength([7.5])).toBe(7.5);
    expect(defaultClipLength([])).toBeNull();
  });
});

describe("clampClipStart", () => {
  it("keeps the window inside the narration, on the half-second step", () => {
    expect(maxClipStart(15, 100.7)).toBe(85.5);
    expect(clampClipStart(90, 15, 100.7)).toBe(85.5);
    expect(clampClipStart(-3, 15, 100)).toBe(0);
    expect(clampClipStart(12.74, 15, 100)).toBe(12.5);
    expect(clampClipStart(Number.NaN, 15, 100)).toBe(0);
  });

  it("starts at 0 when the clip is the whole narration", () => {
    expect(maxClipStart(10, 10)).toBe(0);
    expect(clampClipStart(4, 10, 10)).toBe(0);
  });
});

describe("formatClipTime", () => {
  it("formats m:ss, rounding down", () => {
    expect(formatClipTime(0)).toBe("0:00");
    expect(formatClipTime(2.5)).toBe("0:02");
    expect(formatClipTime(65.9)).toBe("1:05");
    expect(formatClipTime(600)).toBe("10:00");
  });
});

describe("clipVoiceName", () => {
  it("names the clip after its lesson and start", () => {
    expect(clipVoiceName("Ownership in Rust", 62)).toBe("Ownership in Rust · 1:02");
  });

  it("cuts a long title at a word break and marks it", () => {
    const title = "Understanding lifetimes and the borrow checker in practice, part two";
    const name = clipVoiceName(title, 2);
    expect(name).toBe("Understanding lifetimes and the borrow… · 0:02");
    expect(name.split(" · ")[0].length).toBeLessThanOrEqual(CLIP_NAME_TITLE_LIMIT);
  });

  it("cuts a title without word breaks between whole characters", () => {
    const title = "ကွန်ပျူတာ".repeat(10);
    const shown = clipVoiceName(title, 0).split(" · ")[0];
    expect(shown.endsWith("…")).toBe(true);
    expect(title.startsWith(shown.slice(0, -1))).toBe(true);
  });

  it("names an untitled lesson", () => {
    expect(clipVoiceName("   ", 0)).toBe("Lesson · 0:00");
  });
});

describe("suggestClipStart", () => {
  const RATE = 1000;

  /** Narration from [seconds, "speech" | "silence"] spans: speech is a 0.3-amplitude tone. */
  function narration(...spans: [number, "speech" | "silence"][]): Float32Array {
    const total = spans.reduce((sum, [seconds]) => sum + seconds, 0);
    const samples = new Float32Array(Math.round(total * RATE));
    let offset = 0;
    for (const [seconds, kind] of spans) {
      const length = Math.round(seconds * RATE);
      if (kind === "speech") {
        for (let i = 0; i < length; i++) samples[offset + i] = 0.3 * Math.sin(i * 0.9);
      }
      offset += length;
    }
    return samples;
  }

  /** Speech broken by short `pause`-second pauses, for `seconds` in all. */
  function steadySpeech(seconds: number, pause = 0.3): [number, "speech" | "silence"][] {
    const spans: [number, "speech" | "silence"][] = [];
    for (let elapsed = 0; elapsed < seconds; elapsed += 2) {
      spans.push([2 - pause, "speech"], [pause, "silence"]);
    }
    return spans;
  }

  it("skips the quiet handle a Studio render opens with", () => {
    const samples = narration([2, "silence"], ...steadySpeech(40));
    expect(suggestClipStart(samples, RATE, 15)).toBe(2);
  });

  it("skips a stretch broken by a long pause", () => {
    const samples = narration([2, "silence"], [4, "speech"], [3, "silence"], ...steadySpeech(30));
    expect(suggestClipStart(samples, RATE, 15)).toBe(9);
  });

  it("keeps short pauses between sentences", () => {
    const samples = narration([0.5, "silence"], ...steadySpeech(30, 0.6));
    expect(suggestClipStart(samples, RATE, 20)).toBe(0.5);
  });

  it("starts at 0 when the narration is no longer than the clip", () => {
    expect(suggestClipStart(narration([2, "silence"], [8, "speech"]), RATE, 10)).toBe(0);
  });

  it("falls back to the window with the most speech when none is steady", () => {
    const samples = narration(
      [20, "silence"],
      ...Array.from({ length: 10 }, () => [
        [1, "speech"] as [number, "speech"],
        [1.5, "silence"] as [number, "silence"],
      ]).flat(),
    );
    // 18.5 s holds as much speech as 20 s, but opens in a pause.
    expect(suggestClipStart(samples, RATE, 10)).toBe(20);
  });

  it("is judged against the narration's own level", () => {
    const quiet = narration([2, "silence"], ...steadySpeech(30)).map((value) => value * 0.05);
    expect(suggestClipStart(quiet, RATE, 15)).toBe(2);
  });
});
