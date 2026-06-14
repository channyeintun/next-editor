import { describe, expect, it } from "vite-plus/test";
import type { EditorFrame, Recording } from "../types";
import { compressFrames } from "./frameDelta";
import { getCursorPositionAtTime, getCursorReplaySamples } from "./cursorReplay";

const createFrame = (
  timestamp: number,
  mouseCursor: { x: number; y: number; visible: boolean },
): EditorFrame => ({
  timestamp,
  state: {
    content: "",
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
    mouseCursor,
  },
});

const createRecording = (frames: EditorFrame[]): Recording => ({
  version: 3,
  id: "test",
  name: "Test",
  frames: compressFrames(frames),
  keyframeInterval: 120,
  duration: frames[frames.length - 1]?.timestamp ?? 0,
  createdAt: 0,
});

describe("cursorReplay", () => {
  it("interpolates cursor positions by timestamp", () => {
    const samples = [
      { timestamp: 0, x: 0, y: 0, visible: true },
      { timestamp: 100, x: 100, y: 50, visible: true },
    ];

    const result = getCursorPositionAtTime(samples, 50);

    expect(result?.cursor).toEqual({
      x: 50,
      y: 25,
      visible: true,
      tween: {
        from: { x: 0, y: 0, visible: true },
        to: { x: 100, y: 50, visible: true },
        progress: 0.5,
      },
    });
  });

  it("interpolates target-relative cursor positions for the same target", () => {
    const samples = [
      {
        timestamp: 0,
        x: 10,
        y: 20,
        visible: true,
        target: {
          id: "code-editor",
          x: 10,
          y: 20,
          rect: { left: 0, top: 0, width: 100, height: 200 },
        },
      },
      {
        timestamp: 100,
        x: 90,
        y: 180,
        visible: true,
        target: {
          id: "code-editor",
          x: 90,
          y: 180,
          rect: { left: 0, top: 0, width: 100, height: 200 },
        },
      },
    ];

    const result = getCursorPositionAtTime(samples, 50);

    expect(result?.cursor).toEqual({
      x: 50,
      y: 100,
      visible: true,
      tween: {
        from: {
          x: 10,
          y: 20,
          visible: true,
          target: {
            id: "code-editor",
            x: 10,
            y: 20,
            rect: { left: 0, top: 0, width: 100, height: 200 },
          },
        },
        to: {
          x: 90,
          y: 180,
          visible: true,
          target: {
            id: "code-editor",
            x: 90,
            y: 180,
            rect: { left: 0, top: 0, width: 100, height: 200 },
          },
        },
        progress: 0.5,
      },
    });
  });

  it("does not interpolate across visibility changes", () => {
    const samples = [
      { timestamp: 0, x: 0, y: 0, visible: false },
      { timestamp: 100, x: 100, y: 50, visible: true },
    ];

    const result = getCursorPositionAtTime(samples, 50);

    expect(result?.cursor).toEqual({ x: 0, y: 0, visible: false });
  });

  it("prefers dense cursor events over sparse frame cursor data", () => {
    const recording = createRecording([
      createFrame(0, { x: 0, y: 0, visible: true }),
      createFrame(100, { x: 100, y: 0, visible: true }),
    ]);

    recording.cursorEvents = [
      { timestamp: 0, x: 0, y: 0, visible: true },
      { timestamp: 20, x: 20, y: 20, visible: true },
      { timestamp: 40, x: 40, y: 40, visible: true },
    ];

    const samples = getCursorReplaySamples(recording);

    expect(samples).toHaveLength(3);
    expect(samples[1]).toEqual({ timestamp: 20, x: 20, y: 20, visible: true });
  });

  it("does not synthesize stationary hold samples between recorded positions", () => {
    const recording = createRecording([
      createFrame(0, { x: 0, y: 0, visible: true }),
      createFrame(600, { x: 100, y: 100, visible: true }),
    ]);

    recording.cursorEvents = [
      { timestamp: 0, x: 0, y: 0, visible: true },
      { timestamp: 600, x: 100, y: 100, visible: true },
    ];

    const samples = getCursorReplaySamples(recording);
    const result = getCursorPositionAtTime(samples, 300);

    expect(samples).toHaveLength(2);
    expect(result?.cursor).toEqual({
      x: 50,
      y: 50,
      visible: true,
      tween: {
        from: { x: 0, y: 0, visible: true },
        to: { x: 100, y: 100, visible: true },
        progress: 0.5,
      },
    });
  });

  it("derives interpolated samples from frame-only recordings", () => {
    const recording = createRecording([
      createFrame(0, { x: 0, y: 0, visible: true }),
      createFrame(50, { x: 10, y: 20, visible: true }),
      createFrame(100, { x: 20, y: 40, visible: true }),
    ]);
    const samples = getCursorReplaySamples(recording);
    const result = getCursorPositionAtTime(samples, 75);

    expect(samples).toHaveLength(3);
    expect(result?.cursor).toEqual({
      x: 15,
      y: 30,
      visible: true,
      tween: {
        from: { x: 10, y: 20, visible: true },
        to: { x: 20, y: 40, visible: true },
        progress: 0.5,
      },
    });
  });
});
