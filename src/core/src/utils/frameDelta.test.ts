import { describe, expect, it } from "vite-plus/test";
import type { EditorFrame, EditorSelection } from "../types";
import type { PreviewState } from "../slides";
import type { Keyframe } from "./deltaTypes";
import {
  ContentEditBaseMismatchError,
  applyContentDelta,
  applyFrameDelta,
  applySelectionDelta,
  createAppendContentDelta,
  createContentDelta,
  createContentEditDelta,
  createFrameDelta,
  createSelectionDelta,
  findNearestKeyframeIndex,
  reconstructFrameAtIndex,
} from "./frameDelta";
import { compressFrames } from "./frameStreamEncoder";
import { DmpBaseMismatchError } from "../../../storage/dmpCodec/dmpCodec";

const frameAt = (timestamp: number, content: string): EditorFrame => ({
  timestamp,
  state: {
    content,
    selection: {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 1,
    },
    position: { lineNumber: 1, column: 1 },
    viewState: null,
    mouseCursor: { x: 0, y: 0, visible: false },
  },
});

describe("Monaco content edit deltas", () => {
  const base = "const one = 1;\nconst two = 2;\n";
  const event = {
    fileId: "/index.ts",
    path: "/index.ts",
    beforeVersion: 10,
    afterVersion: 11,
    beforeLength: base.length,
    afterLength: base.length + 3,
    changes: [
      { offset: base.indexOf("one"), deleteLength: 3, text: "first" },
      { offset: base.lastIndexOf("2"), deleteLength: 1, text: "20" },
    ],
  };

  it("stores and replays exact multi-edits without a DMP payload", () => {
    const created = createContentEditDelta(base, event);
    expect(created).not.toBeNull();
    if (!created) throw new Error("Expected an exact content edit delta");

    const prev = frameAt(0, base);
    const next = frameAt(16, created.content);
    const delta = createFrameDelta(prev, next, created);

    expect(delta.contentDelta).toBeUndefined();
    expect(delta.contentEditDelta).toEqual(created.delta);
    expect(applyFrameDelta(prev, delta, 1).state.content).toBe(created.content);
  });

  it("attributes a stale-base failure to the replay frame", () => {
    const created = createContentEditDelta(base, event);
    if (!created) throw new Error("Expected an exact content edit delta");
    const delta = createFrameDelta(frameAt(0, base), frameAt(16, created.content), created);
    const staleBase = frameAt(0, base.replace("one", "ONE"));

    let caught: unknown;
    try {
      applyFrameDelta(staleBase, delta, 7);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ContentEditBaseMismatchError);
    expect((caught as Error).message).toMatch(/at frame 7/);
  });

  it("keeps full-document replacement on the DMP fallback path", () => {
    expect(
      createContentEditDelta(base, {
        ...event,
        afterLength: 12,
        changes: [{ offset: 0, deleteLength: base.length, text: "replacement\n" }],
      }),
    ).toBeNull();
  });
});

describe("frameDelta reconstruction errors", () => {
  it("encodes append-only text as one codec-compatible suffix delta", () => {
    const base = "existing streamed response ".repeat(8);
    const appended = "plus a final 🌍 suffix";
    const created = createAppendContentDelta(base, appended);
    expect(created).not.toBeNull();
    if (!created) throw new Error("Expected an append-only content delta");

    const appendedBytes = new TextEncoder().encode(appended);
    expect(applyContentDelta(base, created)).toBe(base + appended);
    expect(created.delta.byteLength).toBeLessThan(new TextEncoder().encode(base + appended).length);
    expect(Array.from(created.delta.slice(-appendedBytes.byteLength))).toEqual(
      Array.from(appendedBytes),
    );
    expect(createAppendContentDelta(base, "")).toBeNull();
    expect(() => applyContentDelta(`${base}!`, created)).toThrow(DmpBaseMismatchError);

    const splitSurrogateBase = "split emoji: \ud83c";
    const splitSurrogateSuffix = "\udf0d";
    expect(createAppendContentDelta(splitSurrogateBase, splitSurrogateSuffix)).toBeNull();
    const fallback = createContentDelta(
      splitSurrogateBase,
      splitSurrogateBase + splitSurrogateSuffix,
    );
    expect(fallback).not.toBeNull();
    if (!fallback) throw new Error("Expected a split-surrogate fallback delta");
    expect(applyContentDelta("split emoji: �", fallback)).toBe("split emoji: 🌍");
  });

  it("attributes a base-mismatch failure to the failing frame index", () => {
    const base = "const value = 1;\nconst other = 2;\n";
    const edited = base.replace("= 1", "= 9");
    const frames = compressFrames([frameAt(0, base), frameAt(100, edited)]);

    // Tamper the keyframe with same-length different content so the delta's
    // base-integrity check op fails only at apply time.
    (frames[0] as Keyframe).state.content = base.replace("value", "vAlue");

    let caught: unknown;
    try {
      reconstructFrameAtIndex(frames, 1);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DmpBaseMismatchError);
    expect((caught as Error).message).toMatch(/at frame 1/);
  });
});

// The delta format must stay incremental for previewState too: its `content`
// is the full static-preview HTML (tens of KB) and scroll ticks change
// previewState at animation-frame rate, so copying the object whole would
// re-embed the unchanged content per tick (a measured 30s lesson carried 337
// identical ~60KB copies).
describe("previewState delta stays incremental", () => {
  const PREVIEW_HTML = "<article>static preview document</article>".repeat(50);

  const withPreview = (timestamp: number, previewState: PreviewState | undefined): EditorFrame => {
    const frame = frameAt(timestamp, "editor content");
    return { ...frame, state: { ...frame.state, previewState } };
  };

  const preview = (content: string | undefined, scrollTop: number): PreviewState => ({
    size: { width: 400, height: 300 },
    isOpen: true,
    content,
    scrollTop,
  });

  it("omits unchanged content from a scroll-only previewState delta", () => {
    const prev = withPreview(0, preview(PREVIEW_HTML, 0));
    const next = withPreview(16, preview(PREVIEW_HTML, 120));

    const delta = createFrameDelta(prev, next);

    expect(delta.previewState).toEqual({
      size: { width: 400, height: 300 },
      isOpen: true,
      scrollTop: 120,
      contentUnchanged: true,
    });
    expect(JSON.stringify(delta)).not.toContain(PREVIEW_HTML.slice(0, 40));

    const applied = applyFrameDelta(prev, delta);
    expect(applied.state.previewState).toEqual(preview(PREVIEW_HTML, 120));
  });

  it("carries content through a chain of content-unchanged deltas", () => {
    const frames = [
      withPreview(0, preview(PREVIEW_HTML, 0)),
      withPreview(16, preview(PREVIEW_HTML, 40)),
      withPreview(32, preview(PREVIEW_HTML, 80)),
    ];

    let reconstructed = frames[0];
    for (let index = 1; index < frames.length; index += 1) {
      reconstructed = applyFrameDelta(
        reconstructed,
        createFrameDelta(frames[index - 1], frames[index]),
      );
    }

    expect(reconstructed.state.previewState).toEqual(preview(PREVIEW_HTML, 80));
  });

  it("reconstructs a content change exactly (patched or full form)", () => {
    const prev = withPreview(0, preview(PREVIEW_HTML, 0));
    const next = withPreview(16, preview("<p>new</p>", 0));

    // vitest.setup.ts installs the dmp codec, so this delta is always a dmp patch.
    const delta = createFrameDelta(prev, next);

    expect(delta.previewState).toBeDefined();
    const applied = applyFrameDelta(prev, delta);
    expect(applied.state.previewState).toEqual(preview("<p>new</p>", 0));
  });

  it("emits full previewState when the preview appears for the first time", () => {
    const prev = withPreview(0, undefined);
    const next = withPreview(16, preview(PREVIEW_HTML, 0));

    const delta = createFrameDelta(prev, next);

    expect(delta.previewState).toEqual(preview(PREVIEW_HTML, 0));
    expect(applyFrameDelta(prev, delta).state.previewState).toEqual(preview(PREVIEW_HTML, 0));
  });

  // With the dmp codec installed, preview-content EDITS are stored as patches
  // against the base chain — like editor content — so live typing (and
  // undo/redo walking back through earlier versions) never re-embeds the full
  // preview HTML per change. A measured 40s editing session stored 60 full
  // ~58KB copies (27 distinct versions) before this.
  describe("content edits become dmp patches", () => {
    const versions = [
      PREVIEW_HTML,
      PREVIEW_HTML.replace("static preview", "static preview edited"),
      PREVIEW_HTML.replace("static preview", "static preview edited twice"),
    ];

    it("stores a typing + undo chain without re-embedding full contents", () => {
      // Type forward through the versions, then undo back down.
      const contents = [...versions, versions[1], versions[0]];
      const frames = contents.map((content, index) =>
        withPreview(index * 16, preview(content, index)),
      );

      let reconstructed = frames[0];
      for (let index = 1; index < frames.length; index += 1) {
        const delta = createFrameDelta(frames[index - 1], frames[index]);

        // The delta must carry a patch, never the full HTML.
        const encoded = JSON.stringify(delta.previewState);
        expect(encoded).toContain("contentDelta");
        expect(encoded.length).toBeLessThan(versions[0].length / 2);

        reconstructed = applyFrameDelta(reconstructed, delta, index);
        expect(reconstructed.state.previewState).toEqual(preview(contents[index], index));
      }
    });
  });
});

describe("keyframe index cache", () => {
  // Streaming playback (APPEND_RECORDING_DELTA) pushes decoded frames into the
  // same array the cache is keyed on, so the scan has to keep up with it.
  it("sees keyframes appended after the index was first built", () => {
    const keyframe = (timestamp: number, content: string): Keyframe => ({
      ...frameAt(timestamp, content),
      isKeyframe: true,
    });
    const frames = [keyframe(0, "one"), { timestamp: 100, isKeyframe: false as const }];

    expect(findNearestKeyframeIndex(frames, 1)).toBe(0);

    frames.push(keyframe(200, "two"), { timestamp: 300, isKeyframe: false as const });

    expect(findNearestKeyframeIndex(frames, 3)).toBe(2);
    expect(findNearestKeyframeIndex(frames, 2)).toBe(2);
    expect(findNearestKeyframeIndex(frames, 1)).toBe(0);
  });
});

// The selection delta leaves out every field that did not move, so replay must
// read a missing anchor or caret field as "stayed put", not borrow the start or
// end delta in its place: on a backward selection start is the caret, not the
// anchor.
describe("selection deltas", () => {
  type Point = readonly [lineNumber: number, column: number];

  // A Monaco selection from its anchor and caret; start and end are the same
  // two points in document order.
  const selectionFrom = (anchor: Point, caret: Point): EditorSelection => {
    const anchorFirst = anchor[0] < caret[0] || (anchor[0] === caret[0] && anchor[1] <= caret[1]);
    const [start, end] = anchorFirst ? [anchor, caret] : [caret, anchor];
    return {
      startLineNumber: start[0],
      startColumn: start[1],
      endLineNumber: end[0],
      endColumn: end[1],
      selectionStartLineNumber: anchor[0],
      selectionStartColumn: anchor[1],
      positionLineNumber: caret[0],
      positionColumn: caret[1],
    };
  };

  const roundTrip = (prev: EditorSelection, next: EditorSelection): EditorSelection =>
    applySelectionDelta(prev, createSelectionDelta(prev, next) ?? {});

  it("keeps the anchor when a backward selection grows from it", () => {
    const collapsed = selectionFrom([2, 5], [2, 5]);
    const shiftUp = selectionFrom([2, 5], [1, 5]);

    expect(roundTrip(collapsed, shiftUp)).toEqual(shiftUp);
  });

  it("keeps the caret when only the anchor end moves", () => {
    const prev = selectionFrom([2, 5], [1, 1]);
    const next = selectionFrom([3, 1], [1, 1]);

    expect(roundTrip(prev, next)).toEqual(next);
  });

  it("round-trips every anchor/caret pair", () => {
    const points: Point[] = [];
    for (let line = 1; line <= 3; line += 1) {
      for (let column = 1; column <= 3; column += 1) points.push([line, column]);
    }
    const selections = points.flatMap((anchor) =>
      points.map((caret) => selectionFrom(anchor, caret)),
    );

    for (const prev of selections) {
      for (const next of selections) {
        expect(roundTrip(prev, next)).toEqual(next);
      }
    }
  });

  it("reconstructs a selection-only frame without a view state", () => {
    // frameAt records no view state, so replay has only the selection delta to
    // go on; a recorded view state would supply the selection itself.
    const frameWith = (timestamp: number, selection: EditorSelection): EditorFrame => {
      const frame = frameAt(timestamp, "hello\nworld\n");
      const position = {
        lineNumber: selection.positionLineNumber,
        column: selection.positionColumn,
      };
      return { ...frame, state: { ...frame.state, selection, position } };
    };
    const frames = [
      frameWith(0, selectionFrom([2, 5], [2, 5])),
      frameWith(100, selectionFrom([2, 5], [1, 5])), // shift+up
      frameWith(200, selectionFrom([2, 5], [1, 4])), // shift+left
    ];

    const compressed = compressFrames(frames);

    expect(compressed).toHaveLength(frames.length);
    frames.forEach((frame, index) => {
      expect(reconstructFrameAtIndex(compressed, index)?.state.selection).toEqual(
        frame.state.selection,
      );
    });
  });

  it("reads a start/end-only delta the old way", () => {
    const forward = selectionFrom([2, 3], [3, 4]);

    expect(applySelectionDelta(forward, { startLineDelta: -1, endColumnDelta: 2 })).toEqual(
      selectionFrom([1, 3], [3, 6]),
    );
  });
});
