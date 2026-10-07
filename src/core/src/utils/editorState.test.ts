import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorFrame, Recording } from "../types";
import type { DeltaFrame } from "./deltaTypes";
import {
  markFramesNormalized,
  normalizeDeltaFrame,
  normalizeEditorFrame,
  normalizeRecordingData,
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
