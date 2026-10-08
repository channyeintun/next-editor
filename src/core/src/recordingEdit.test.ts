import { describe, expect, it } from "vite-plus/test";
import {
  applyRecordingEdit,
  CUT_WINDOW_MS,
  mapTimeThroughCuts,
  unmapTimeThroughCuts,
} from "./recordingEdit";
import { compressFrames } from "./utils/frameStreamEncoder";
import { reconstructFrameAtIndex } from "./utils/frameDelta";
import { getRrwebReplayLead } from "./utils/previewReplayLead";
import type { EditorFrame, Recording } from "./types";

const selection = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
  selectionStartLineNumber: 1,
  selectionStartColumn: 1,
  positionLineNumber: 1,
  positionColumn: 1,
};

const frame = (timestamp: number, content: string): EditorFrame => ({
  timestamp,
  state: {
    content,
    selection,
    position: { lineNumber: 1, column: 1 },
    viewState: null,
  },
});

const recordingWith = (overrides: Partial<Recording> = {}): Recording => ({
  version: 4,
  id: "take",
  name: "Take",
  createdAt: 1,
  duration: 10_000,
  keyframeInterval: 120,
  frames: compressFrames([
    frame(0, "a"),
    frame(1_000, "ab"),
    // Typed and deleted inside the cut below.
    frame(3_000, "ab oops"),
    frame(4_000, "ab"),
    frame(6_000, "abc"),
  ]),
  ...overrides,
});

describe("mapping time through cuts", () => {
  const cuts = [
    { start: 2_000, end: 5_000 },
    { start: 7_000, end: 8_000 },
  ];

  it("collapses each cut into its window and moves what follows earlier", () => {
    expect(mapTimeThroughCuts(1_500, cuts)).toBe(1_500);
    expect(mapTimeThroughCuts(2_000, cuts)).toBe(2_000);
    expect(mapTimeThroughCuts(3_500, cuts)).toBeCloseTo(2_000 + CUT_WINDOW_MS / 2);
    expect(mapTimeThroughCuts(5_000, cuts)).toBe(2_000 + CUT_WINDOW_MS);
    expect(mapTimeThroughCuts(6_000, cuts)).toBe(3_000 + CUT_WINDOW_MS);
    expect(mapTimeThroughCuts(9_000, cuts)).toBe(5_000 + 2 * CUT_WINDOW_MS);
  });

  it("keeps every track's order", () => {
    let previous = -Infinity;
    for (let time = 0; time <= 10_000; time += 250) {
      const mapped = mapTimeThroughCuts(time, cuts);
      expect(mapped).toBeGreaterThanOrEqual(previous);
      previous = mapped;
    }
  });

  it("maps moments after a cut back to where they were", () => {
    expect(unmapTimeThroughCuts(mapTimeThroughCuts(6_000, cuts), cuts)).toBe(6_000);
    expect(unmapTimeThroughCuts(1_000, cuts)).toBe(1_000);
  });
});

describe("applying an edit to a recording", () => {
  const cut = { start: 2_000, end: 5_000 };

  it("leaves nothing of the code typed and deleted inside a cut", () => {
    const edited = applyRecordingEdit(recordingWith(), { cuts: [cut], mutes: [] });
    const contents = edited.frames.map(
      (_, index) => reconstructFrameAtIndex(edited.frames, index)?.state.content,
    );
    expect(contents).toEqual(["a", "ab", "ab", "abc"]);
    expect(edited.frames.map((entry) => entry.timestamp)).toEqual([
      0,
      1_000,
      // The cut's frames squashed into one, where the last of them fell in the window.
      mapTimeThroughCuts(4_000, [cut]),
      3_000 + CUT_WINDOW_MS,
    ]);
    expect(edited.duration).toBe(7_000 + CUT_WINDOW_MS);
    expect(edited.id).not.toBe("take");
  });

  it("keeps where the pointer ended up inside a cut, and only that", () => {
    const edited = applyRecordingEdit(
      recordingWith({
        cursorEvents: [
          { timestamp: 1_000, x: 1, y: 1, visible: true },
          { timestamp: 2_500, x: 2, y: 2, visible: true },
          { timestamp: 4_500, x: 3, y: 3, visible: true },
          { timestamp: 6_000, x: 4, y: 4, visible: true },
        ],
      }),
      { cuts: [cut], mutes: [] },
    );
    expect(edited.cursorEvents?.map(({ x }) => x)).toEqual([1, 3, 4]);
  });

  it("drops captions said inside a cut and shortens those across it", () => {
    const edited = applyRecordingEdit(
      recordingWith({
        captions: [
          {
            id: "en",
            language: "en",
            cues: [
              { start: 2_500, end: 3_500, text: "gone" },
              { start: 1_500, end: 6_000, text: "kept" },
            ],
          },
        ],
      }),
      { cuts: [cut], mutes: [] },
    );
    expect(edited.captions?.[0].cues).toEqual([
      { start: 1_500, end: 3_000 + CUT_WINDOW_MS, text: "kept" },
    ]);
  });

  it("drops the words cut from the narration from a timed cue's text", () => {
    const edited = applyRecordingEdit(
      recordingWith({
        captions: [
          {
            id: "en",
            language: "en",
            cues: [
              {
                start: 500,
                end: 1_400,
                text: "Untouched cue.",
                words: [
                  { start: 500, end: 900, text: "Untouched" },
                  { start: 900, end: 1_400, text: "cue." },
                ],
              },
              {
                start: 1_500,
                end: 6_000,
                text: "before a lost words after",
                words: [
                  { start: 1_500, end: 1_900, text: "before" },
                  // Too short to measure, but never cut.
                  { start: 1_900, end: 1_901, text: "a" },
                  { start: 2_500, end: 3_000, text: "lost" },
                  { start: 3_200, end: 4_000, text: "words" },
                  { start: 5_200, end: 6_000, text: "after" },
                ],
              },
            ],
          },
        ],
      }),
      { cuts: [cut], mutes: [] },
    );
    const [untouched, across] = edited.captions![0].cues;
    expect(untouched.text).toBe("Untouched cue.");
    expect(untouched.words).toHaveLength(2);
    expect(across.text).toBe("before a after");
    expect(across.words).toEqual([
      { start: 1_500, end: 1_900, text: "before" },
      { start: 1_900, end: 1_901, text: "a" },
      { start: 2_200 + CUT_WINDOW_MS, end: 3_000 + CUT_WINDOW_MS, text: "after" },
    ]);
    expect(across.end).toBe(3_000 + CUT_WINDOW_MS);
  });

  it("drops a timed cue whose every word was cut, even across two cuts", () => {
    const edited = applyRecordingEdit(
      recordingWith({
        captions: [
          {
            id: "en",
            language: "en",
            cues: [
              {
                start: 2_500,
                end: 7_800,
                text: "both gone",
                words: [
                  { start: 2_600, end: 3_000, text: "both" },
                  { start: 7_200, end: 7_700, text: "gone" },
                ],
              },
            ],
          },
        ],
      }),
      { cuts: [cut, { start: 7_000, end: 8_000 }], mutes: [] },
    );
    expect(edited.captions?.[0].cues).toEqual([]);
  });

  it("re-bases the preview's rrweb stamps onto recorded time so replay's offset is 0", () => {
    const edited = applyRecordingEdit(
      recordingWith({
        previewInitialDocuments: [
          {
            version: 2,
            time: 10,
            documentId: "d",
            events: [{ type: 2, data: {}, timestamp: 60_000 }],
          },
        ],
        previewPatchBatches: [
          {
            version: 2,
            time: 6_020,
            source: "runtime-preview",
            documentId: "d",
            events: [{ type: 3, data: {}, timestamp: 66_000 }],
          },
        ],
      }),
      { cuts: [cut], mutes: [] },
    );
    const [document] = edited.previewInitialDocuments!;
    const [batch] = edited.previewPatchBatches!;
    // The seed had the larger lead (60_000 - 10), so every stamp moves by it.
    expect(document.events![0].timestamp).toBe(10);
    expect(batch.events![0].timestamp).toBe(mapTimeThroughCuts(66_000 - 59_990, [cut]));
    expect(document.events![0].timestamp - document.time).toBe(0);
    expect(batch.time).toBeGreaterThanOrEqual(batch.events![0].timestamp);
    // What replay rebases the edited stamps by.
    expect(getRrwebReplayLead(edited.previewInitialDocuments!, edited.previewPatchBatches!)).toBe(
      0,
    );
  });

  it("leaves the narration edit for loading, on the audio's own clock", () => {
    const edited = applyRecordingEdit(
      recordingWith({
        audioBlob: new Blob(["narration"]),
        audioStartOffsetMs: 100,
        audioFile: "take.weba",
      }),
      { cuts: [cut], mutes: [{ start: 6_000, end: 6_500 }] },
    );
    expect(edited.pendingAudioEdit).toEqual({
      cuts: [{ start: 1_900, end: 4_900 - CUT_WINDOW_MS }],
      mutes: [{ start: 5_900, end: 6_400 }],
    });
    // The edited narration will be a new file.
    expect(edited.audioFile).toBeUndefined();
  });

  it("maps the camera around the cut on top of a retake's", () => {
    const edited = applyRecordingEdit(
      recordingWith({
        cameraBlob: new Blob(["video"]),
        cameraCuts: [{ start: 500, end: 1_500 }],
      }),
      { cuts: [cut], mutes: [] },
    );
    // Recorded 2_000 was 3_000 on the camera's media timeline.
    expect(edited.cameraCuts).toEqual([
      { start: 500, end: 1_500 },
      { start: 3_000, end: 6_000 - CUT_WINDOW_MS },
    ]);
  });

  it("moves chapters with the time around them", () => {
    const edited = applyRecordingEdit(
      recordingWith({
        chapters: [
          { time: 1_000, title: "Before" },
          { time: 3_000, title: "Inside" },
          { time: 6_000, title: "After" },
        ],
      }),
      { cuts: [cut], mutes: [] },
    );
    expect(edited.chapters?.map(({ time }) => time)).toEqual([
      1_000,
      mapTimeThroughCuts(3_000, [cut]),
      3_000 + CUT_WINDOW_MS,
    ]);
  });

  it("will not cut narration it only has a link to", () => {
    expect(() =>
      applyRecordingEdit(recordingWith({ audioUrl: "https://example.com/a.weba" }), {
        cuts: [cut],
        mutes: [],
      }),
    ).toThrow("must be loaded");
  });

  it("will not replace a retake's narration cut that is still pending", () => {
    const retaken = recordingWith({ pendingAudioEdit: { cuts: [{ start: 100, end: 900 }] } });
    expect(() => applyRecordingEdit(retaken, { cuts: [cut], mutes: [] })).toThrow(
      "still being cut",
    );
  });
});
