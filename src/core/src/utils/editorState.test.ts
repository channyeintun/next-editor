import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorFrame, EditorSelection, Recording } from "../types";
import type { DeltaFrame } from "./deltaTypes";
import {
  markFramesNormalized,
  normalizeDeltaFrame,
  normalizeEditorFrame,
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
