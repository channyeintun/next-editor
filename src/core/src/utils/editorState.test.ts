import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorFrame, EditorSelection, Recording } from "../types";
import type { DeltaFrame } from "./deltaTypes";
import {
  markFramesNormalized,
  normalizeDeltaFrame,
  normalizeEditorFrame,
  normalizeEditorPosition,
  normalizeEditorSelection,
  normalizeRecordingData,
  withPrimaryCursorSelection,
} from "./editorState";

const frameWithViewState = (): EditorFrame => ({
  timestamp: 0,
  state: {
    content: "abc",
    selection: {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 3,
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 3,
    },
    position: { lineNumber: 1, column: 3 },
    viewState: {
      cursorState: [
        {
          inSelectionMode: true,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 1, column: 3 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    } as unknown as monaco.editor.ICodeEditorViewState,
  },
});

describe("normalizeEditorPosition", () => {
  it("takes a finite fallback for a non-finite position, truncated and floored at 1", () => {
    expect(
      normalizeEditorPosition(
        { lineNumber: Number.NaN, column: Infinity },
        { lineNumber: 4.9, column: 0 },
      ),
    ).toEqual({ lineNumber: 4, column: 1 });
  });
});

describe("normalizeEditorSelection", () => {
  it("collapses a missing selection at the fallback position, caret included", () => {
    expect(normalizeEditorSelection(undefined, undefined, { lineNumber: 3, column: 7 })).toEqual({
      startLineNumber: 3,
      startColumn: 7,
      endLineNumber: 3,
      endColumn: 7,
      selectionStartLineNumber: 3,
      selectionStartColumn: 7,
      positionLineNumber: 3,
      positionColumn: 7,
    });
  });

  it("puts the caret at the end when only start and end are given", () => {
    expect(
      normalizeEditorSelection({
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 3,
        endColumn: 4,
      }),
    ).toEqual({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 3,
      endColumn: 4,
      selectionStartLineNumber: 1,
      selectionStartColumn: 2,
      positionLineNumber: 3,
      positionColumn: 4,
    });
  });

  it("keeps the caret of a backward selection at its start", () => {
    const backward: EditorSelection = {
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 3,
      endColumn: 4,
      selectionStartLineNumber: 3,
      selectionStartColumn: 4,
      positionLineNumber: 1,
      positionColumn: 2,
    };

    expect(normalizeEditorSelection(backward, undefined, { lineNumber: 9, column: 9 })).toEqual(
      backward,
    );
  });

  it("fills a missing field from the fallback selection before deriving it", () => {
    const fallback: EditorSelection = {
      startLineNumber: 5,
      startColumn: 6,
      endLineNumber: 7,
      endColumn: 8,
      selectionStartLineNumber: 7,
      selectionStartColumn: 8,
      positionLineNumber: 5,
      positionColumn: 6,
    };

    expect(normalizeEditorSelection({ startLineNumber: 2, endColumn: 3 }, fallback)).toEqual({
      ...fallback,
      startLineNumber: 2,
      endColumn: 3,
    });
  });

  it("falls back from non-finite values, floors at 1 and truncates", () => {
    expect(
      normalizeEditorSelection(
        {
          startLineNumber: Number.NaN,
          startColumn: Infinity,
          endLineNumber: 0,
          endColumn: -3,
          selectionStartLineNumber: 2.7,
          selectionStartColumn: -Infinity,
        },
        undefined,
        { lineNumber: 5, column: 6 },
      ),
    ).toEqual({
      startLineNumber: 5,
      startColumn: 6,
      endLineNumber: 1,
      endColumn: 1,
      selectionStartLineNumber: 2,
      selectionStartColumn: 6,
      positionLineNumber: 1,
      positionColumn: 1,
    });
  });
});

describe("normalizeEditorFrame", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Every replayed delta fold ends in normalizeEditorFrame, so each extra deep clone
  // of the view state is paid on every tick that crosses a frame.
  it("clones the view state once", () => {
    const frame = frameWithViewState();
    const clone = vi.spyOn(globalThis, "structuredClone");

    const normalized = normalizeEditorFrame(frame);

    expect(clone).toHaveBeenCalledTimes(1);
    expect(normalized.state.viewState).not.toBe(frame.state.viewState);
    expect(
      (normalized.state.viewState as unknown as { cursorState: unknown[] }).cursorState[0],
    ).toMatchObject({
      position: { lineNumber: 1, column: 3 },
      selection: frame.state.selection,
    });
  });
});

describe("normalizeRecordingData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const recordingOf = (frames: DeltaFrame[]): Recording => ({
    version: 4,
    id: "recording",
    name: "Recording",
    createdAt: 0,
    duration: 1,
    keyframeInterval: 120,
    frames,
  });

  // Loading a decoded lesson or a finished take deep-cloned every view state the
  // decoder or the capture had just normalized.
  it("does not normalize frames marked as normalized again", () => {
    const frames = [normalizeDeltaFrame({ ...frameWithViewState(), isKeyframe: true })];
    markFramesNormalized(frames);
    const clone = vi.spyOn(globalThis, "structuredClone");

    const loaded = normalizeRecordingData(recordingOf(frames));

    expect(clone).not.toHaveBeenCalled();
    expect(loaded.frames[0]).toBe(frames[0]);
    // Still the caller's own array: the machine appends streamed frames to it in place.
    expect(loaded.frames).not.toBe(frames);
  });

  it("normalizes unmarked frames once, and not again when its result is loaded", () => {
    const frame: DeltaFrame = { ...frameWithViewState(), isKeyframe: true };
    const clone = vi.spyOn(globalThis, "structuredClone");

    const once = normalizeRecordingData(recordingOf([frame]));
    const twice = normalizeRecordingData(once);

    expect(clone).toHaveBeenCalledTimes(1);
    expect(once.frames[0]).toEqual(normalizeDeltaFrame(frame));
    expect(twice.frames).toEqual(once.frames);
  });
});

describe("withPrimaryCursorSelection", () => {
  // A backward selection: the caret sits at its start.
  const remoteSelection: EditorSelection = {
    startLineNumber: 2,
    startColumn: 3,
    endLineNumber: 4,
    endColumn: 6,
    selectionStartLineNumber: 4,
    selectionStartColumn: 6,
    positionLineNumber: 2,
    positionColumn: 3,
  };
  const remotePosition = { lineNumber: 2, column: 3 };

  const twoCursorViewState = () =>
    ({
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 1, column: 1 },
          extra: "kept",
        },
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: 5, column: 1 },
          position: { lineNumber: 5, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    }) as unknown as monaco.editor.ICodeEditorViewState;

  it("replaces the primary cursor and keeps the other cursors", () => {
    const viewState = twoCursorViewState();

    const result = withPrimaryCursorSelection(viewState, remoteSelection, remotePosition);

    expect(result?.cursorState[0]).toEqual({
      inSelectionMode: true,
      selectionStart: { lineNumber: 4, column: 6 },
      position: remotePosition,
      selection: remoteSelection,
      extra: "kept",
    });
    expect(result?.cursorState[1]).toBe(viewState.cursorState[1]);
    expect(result?.viewState).toBe(viewState.viewState);
  });

  it("leaves selection mode off for a collapsed selection", () => {
    const caret: EditorSelection = {
      ...remoteSelection,
      endLineNumber: 2,
      endColumn: 3,
      selectionStartLineNumber: 2,
      selectionStartColumn: 3,
    };

    const result = withPrimaryCursorSelection(twoCursorViewState(), caret, remotePosition);

    expect(result?.cursorState[0]).toMatchObject({ inSelectionMode: false });
  });

  it("does not write into its input", () => {
    const viewState = twoCursorViewState();
    const before = structuredClone(viewState);
    const primary = viewState.cursorState[0];

    const result = withPrimaryCursorSelection(viewState, remoteSelection, remotePosition);

    expect(result).not.toBe(viewState);
    expect(result?.cursorState).not.toBe(viewState.cursorState);
    expect(viewState.cursorState[0]).toBe(primary);
    expect(viewState).toEqual(before);
  });

  it("passes null and a view state without cursors through", () => {
    const noCursors = { ...twoCursorViewState(), cursorState: [] };

    expect(withPrimaryCursorSelection(null, remoteSelection, remotePosition)).toBeNull();
    expect(withPrimaryCursorSelection(noCursors, remoteSelection, remotePosition)).toBe(noCursors);
  });
});
