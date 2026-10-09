import { describe, expect, it } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorFrame } from "../types";
import { DELTA_CONFIG, isKeyframe, type DeltaFrame } from "./deltaTypes";
import { createContentEditDelta } from "./contentDelta";
import { applyFrameDelta, reconstructFrameAtIndex } from "./frameDelta";
import {
  compressFrames,
  createFrameStreamEncoder,
  pushFrame,
  resumeFrameStreamEncoder,
} from "./frameStreamEncoder";

const INTERVAL = DELTA_CONFIG.KEYFRAME_INTERVAL;

const frameAt = (timestamp: number, content: string): EditorFrame => ({
  timestamp,
  state: {
    content,
    selection: {
      startLineNumber: 1,
      startColumn: content.length + 1,
      endLineNumber: 1,
      endColumn: content.length + 1,
      selectionStartLineNumber: 1,
      selectionStartColumn: content.length + 1,
      positionLineNumber: 1,
      positionColumn: content.length + 1,
    },
    position: { lineNumber: 1, column: content.length + 1 },
    viewState: null,
    mouseCursor: { x: 0, y: 0, visible: false },
  },
});

// A no-op capture shares the previous capture's state by reference, as the
// cursor-position and selection captures that follow a keystroke do.
const repeatAt = (frame: EditorFrame, timestamp: number): EditorFrame => ({ ...frame, timestamp });

/**
 * Monaco captures three times per keystroke: the content change, then the
 * cursor-position and selection events, which see the already-moved cursor.
 */
const typingCaptures = (keystrokes: number, leadingNoOps: number): EditorFrame[] => {
  let timestamp = 0;
  const first = frameAt(timestamp, "");
  const captures = [first];
  for (let i = 0; i < leadingNoOps; i++) captures.push(repeatAt(first, (timestamp += 5)));
  let content = "";
  for (let i = 0; i < keystrokes; i++) {
    content += String.fromCharCode(97 + (i % 26));
    const typed = frameAt((timestamp += 5), content);
    captures.push(typed, repeatAt(typed, (timestamp += 5)), repeatAt(typed, (timestamp += 5)));
  }
  return captures;
};

const encode = (captures: EditorFrame[]) => {
  let state = createFrameStreamEncoder();
  const stored: DeltaFrame[] = [];
  const storedInputIndices: number[] = [];
  captures.forEach((capture, inputIndex) => {
    const pushed = pushFrame(state, capture);
    state = pushed.state;
    if (pushed.emitted) {
      stored.push(pushed.emitted);
      storedInputIndices.push(inputIndex);
    }
  });
  return { stored, storedInputIndices };
};

const keyframeIndices = (frames: DeltaFrame[]) =>
  frames.flatMap((frame, index) => (isKeyframe(frame) ? [index] : []));

describe("pushFrame keyframe cadence", () => {
  // The cadence used to follow the capture index. 120 is a multiple of 3, so
  // every keyframe slot of a take landed on the same keystroke phase: two of
  // the three phases are no-ops and got no keyframe for the whole take, and
  // the third got one every 40 keystrokes.
  it.each([0, 1, 2])(
    `keeps a keyframe every ${INTERVAL} stored frames while typing after %i no-op captures`,
    (leadingNoOps) => {
      const { stored } = encode(typingCaptures(1000, leadingNoOps));

      expect(stored).toHaveLength(1001);
      expect(keyframeIndices(stored)).toEqual(
        Array.from({ length: Math.ceil(1001 / INTERVAL) }, (_, index) => index * INTERVAL),
      );
    },
  );

  it("keyframes captures that all change at input indices 0, 120 and 240", () => {
    const captures = Array.from({ length: 250 }, (_, index) => frameAt(index * 10, `v${index}`));
    const { stored, storedInputIndices } = encode(captures);

    expect(stored).toHaveLength(250);
    expect(keyframeIndices(stored).map((index) => storedInputIndices[index])).toEqual([
      0,
      INTERVAL,
      2 * INTERVAL,
    ]);
  });

  it("holds a due keyframe for the next capture that changes", () => {
    const captures = Array.from({ length: INTERVAL }, (_, index) =>
      frameAt(index * 10, `v${index}`),
    );
    const last = captures[INTERVAL - 1];
    captures.push(repeatAt(last, INTERVAL * 10), frameAt(INTERVAL * 10 + 10, "changed"));

    const { stored, storedInputIndices } = encode(captures);

    expect(storedInputIndices.slice(-2)).toEqual([INTERVAL - 1, INTERVAL + 1]);
    expect(isKeyframe(stored[stored.length - 1])).toBe(true);
    expect(keyframeIndices(stored)).toEqual([0, INTERVAL]);
  });

  it("reconstructs every stored frame as a sequential fold does", () => {
    const frames = compressFrames(typingCaptures(300, 1));
    expect(keyframeIndices(frames).length).toBeGreaterThan(2);

    let folded = frames[0] as EditorFrame;
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      folded = isKeyframe(frame) ? frame : applyFrameDelta(folded, frame, index);
      expect(reconstructFrameAtIndex(frames, index)?.state).toEqual(folded.state);
    }
  });
});

describe("resumeFrameStreamEncoder", () => {
  // Keystroke n is stored as frame n, from capture 3n - 1 (after the opening capture and
  // its no-op), so these prefixes end just before, on and after the second keyframe, and
  // on a no-op capture as well as on a stored one.
  it.each([3 * INTERVAL - 4, 3 * INTERVAL - 1, 3 * INTERVAL, 3 * INTERVAL + 1, 3 * INTERVAL + 15])(
    "keeps the uninterrupted keyframe cadence after the first %i captures",
    (split) => {
      const captures = typingCaptures(300, 1);
      const prefix = compressFrames(captures.slice(0, split));

      let state = resumeFrameStreamEncoder(
        prefix,
        reconstructFrameAtIndex(prefix, prefix.length - 1),
      );
      const resumed = [...prefix];
      for (const capture of captures.slice(split)) {
        const pushed = pushFrame(state, capture);
        state = pushed.state;
        if (pushed.emitted) resumed.push(pushed.emitted);
      }

      expect(resumed).toHaveLength(301);
      expect(keyframeIndices(resumed)).toEqual(keyframeIndices(compressFrames(captures)));
    },
  );

  it("starts empty when there are no frames to carry on from", () => {
    expect(resumeFrameStreamEncoder([], null)).toEqual(createFrameStreamEncoder());
  });
});

describe("pushFrame content deltas", () => {
  it("stores a matching content edit as a contentEditDelta", () => {
    const base = frameAt(0, "const a = 1;");
    const created = createContentEditDelta(base.state.content, {
      fileId: "file",
      path: "/main.ts",
      beforeVersion: 1,
      afterVersion: 2,
      beforeLength: base.state.content.length,
      afterLength: base.state.content.length,
      changes: [{ offset: 10, deleteLength: 1, text: "2" }],
    });
    if (!created) throw new Error("Expected a content edit delta");

    const first = pushFrame(createFrameStreamEncoder(), base);
    const { emitted } = pushFrame(first.state, frameAt(10, created.content), created);

    if (!emitted || isKeyframe(emitted)) throw new Error("Expected a delta frame");
    expect(emitted.contentEditDelta).toEqual(created.delta);
    expect(emitted.contentDelta).toBeUndefined();
  });
});

describe("pushFrame clears", () => {
  const withPreview = (frame: EditorFrame): EditorFrame => ({
    ...frame,
    state: { ...frame.state, previewState: { size: "medium", isOpen: true, content: "<p>hi</p>" } },
  });

  // A delta's absent previewState means "unchanged", so closing the preview mid-take used
  // to replay as still open until the next keyframe.
  it("keeps a closed preview closed in every frame that follows", () => {
    const open = withPreview(frameAt(0, "a"));
    const closed = frameAt(10, "a");
    closed.state.mouseCursor = { x: 10, y: 10, visible: true };
    const edited = { ...closed, timestamp: 20, state: { ...closed.state, content: "ab" } };

    const frames = compressFrames([open, closed, edited]);

    expect(frames).toHaveLength(3);
    expect(isKeyframe(frames[1])).toBe(true);
    for (let index = 1; index < frames.length; index++) {
      expect(reconstructFrameAtIndex(frames, index)?.state.previewState).toBeUndefined();
    }
  });

  it("stores a capture that only closes the preview as one keyframe", () => {
    const open = withPreview(frameAt(0, "a"));
    const closed = frameAt(10, "a");

    const { stored, storedInputIndices } = encode([open, closed, repeatAt(closed, 20)]);

    expect(storedInputIndices).toEqual([0, 1]);
    expect(keyframeIndices(stored)).toEqual([0, 1]);
  });

  it("keeps a cleared view state cleared", () => {
    const viewState = {
      cursorState: [],
      viewState: { scrollLeft: 0, firstPosition: { lineNumber: 1, column: 1 } },
      contributionsState: {},
    } as unknown as monaco.editor.ICodeEditorViewState;
    const withModel = frameAt(0, "a");
    withModel.state.viewState = viewState;
    const withoutModel = frameAt(10, "ab");

    const frames = compressFrames([withModel, withoutModel]);

    expect(isKeyframe(frames[1])).toBe(true);
    expect(reconstructFrameAtIndex(frames, 1)?.state.viewState).toBeNull();
  });
});
