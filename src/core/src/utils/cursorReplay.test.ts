import { describe, expect, it } from "vite-plus/test";
import type { EditorFrame, Recording } from "../types";
import { compressFrames } from "./frameStreamEncoder";
import { getCursorPositionAtTime, getCursorReplaySamples } from "./cursorReplay";
import { POINTER_SETTLE_MS, pointerAimDurationMs } from "./pointerMotion";

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
  version: 4,
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

    expect(samples).toHaveLength(2);
  });

  it("holds a parked pointer, then makes a hand's approach that settles before the next gesture", () => {
    const recording = createRecording([
      createFrame(0, { x: 10, y: 10, visible: true }),
      createFrame(9000, { x: 400, y: 300, visible: true }),
    ]);
    recording.cursorEvents = [
      { timestamp: 0, x: 10, y: 10, visible: true },
      { timestamp: 9000, x: 400, y: 300, visible: true },
    ];
    const samples = getCursorReplaySamples(recording);
    const glideMs = pointerAimDurationMs(Math.hypot(390, 290));
    const arriveAt = 9000 - POINTER_SETTLE_MS;
    const leaveAt = arriveAt - glideMs;

    // Two selections separated by seconds of narration: the cursor parks at the
    // first position through the idle (no slow drift across the editor)…
    expect(getCursorPositionAtTime(samples, 4500)?.cursor).toMatchObject({ x: 10, y: 10 });
    expect(getCursorPositionAtTime(samples, leaveAt)?.cursor).toMatchObject({ x: 10, y: 10 });
    // …then moves straight from where it was toward the next position, leaving
    // and landing at rest (slow at both ends, fastest in between)…
    const at = (time: number) => getCursorPositionAtTime(samples, time)!.cursor;
    const early = at(leaveAt + glideMs * 0.1);
    const mid = at(leaveAt + glideMs * 0.5);
    const late = at(leaveAt + glideMs * 0.9);
    expect(early.x - 10).toBeLessThan((mid.x - early.x) / 2);
    expect(400 - late.x).toBeLessThan((late.x - mid.x) / 2);
    expect((mid.y - 10) / (mid.x - 10)).toBeCloseTo(290 / 390);
    // …and arrives a beat before that gesture, resting there until it begins.
    expect(at(arriveAt)).toMatchObject({ x: 400, y: 300 });
    expect(at(8950)).toMatchObject({ x: 400, y: 300 });
  });

  it("times the approach by distance — a short hop is quicker than a long reach", () => {
    const hop = pointerAimDurationMs(40);
    const reach = pointerAimDurationMs(900);
    expect(hop).toBeLessThan(reach);
    expect(hop).toBeGreaterThanOrEqual(220);
    expect(reach).toBeLessThanOrEqual(800);

    const samples = [
      { timestamp: 0, x: 0, y: 0, visible: true },
      { timestamp: 5000, x: 40, y: 0, visible: true },
    ];
    const leaveAt = 5000 - POINTER_SETTLE_MS - hop;
    expect(getCursorPositionAtTime(samples, leaveAt - 1)?.cursor.x).toBe(0);
    expect(getCursorPositionAtTime(samples, leaveAt + hop / 2)?.cursor.x).toBeGreaterThan(0);
  });

  it("travels with the button state of the resting side, pressing only when the gesture starts", () => {
    const samples = [
      { timestamp: 0, x: 0, y: 0, visible: true, flags: 0 },
      { timestamp: 3000, x: 300, y: 0, visible: true, flags: 1 },
    ];

    expect(getCursorPositionAtTime(samples, 2700)?.cursor.flags).toBe(0);
    expect(getCursorPositionAtTime(samples, 2990)?.cursor.flags).toBe(0);
    expect(getCursorPositionAtTime(samples, 3000)?.cursor.flags).toBe(1);
  });

  it("glides across a short sparse gap without settling when there is no time to", () => {
    const samples = [
      { timestamp: 0, x: 0, y: 0, visible: true },
      { timestamp: 200, x: 480, y: 0, visible: true },
    ];
    const at = (time: number) => getCursorPositionAtTime(samples, time)!.cursor.x;

    expect(at(0)).toBe(0);
    expect(at(100)).toBeGreaterThan(0);
    expect(at(100)).toBeLessThan(480);
    expect(at(199)).toBeLessThan(480);
    expect(at(200)).toBe(480);
  });

  it("drops the old recorder's stray hidden {0,0} samples from a pointer that never moved", () => {
    const recording = createRecording([createFrame(0, { x: 0, y: 0, visible: true })]);
    recording.cursorEvents = [
      { timestamp: 0, x: 120, y: 80, visible: true },
      { timestamp: 500, x: 0, y: 0, visible: false },
      { timestamp: 4000, x: 120, y: 80, visible: true },
      { timestamp: 4016, x: 124, y: 82, visible: true },
    ];

    const samples = getCursorReplaySamples(recording);

    expect(samples.map((sample) => sample.visible)).toEqual([true, true]);
    expect(getCursorPositionAtTime(samples, 2000)?.cursor).toMatchObject({
      x: 120,
      y: 80,
      visible: true,
    });
  });

  it("stays on the earlier anchor across a parked gap with nowhere to travel", () => {
    // The studio pins a resting pointer to the app before the dock opens; the
    // next sample is the same spot recorded against the opened dock. Until it
    // is due, the pointer must not be placed against the dock.
    const samples = [
      {
        timestamp: 0,
        x: 1412,
        y: 693,
        visible: true,
        target: { id: "app", x: 1412, y: 693, rect: { left: 0, top: 0, width: 1440, height: 756 } },
      },
      {
        timestamp: 900,
        x: 1412,
        y: 693,
        visible: true,
        target: {
          id: "runtime-dock",
          x: 1200,
          y: 310,
          rect: { left: 212, top: 383, width: 1228, height: 333 },
        },
      },
    ];

    expect(getCursorPositionAtTime(samples, 500)?.cursor.tween?.progress).toBe(0);
    expect(getCursorPositionAtTime(samples, 900)?.cursor.target?.id).toBe("runtime-dock");
  });

  it("reads a quick tap as pressed between its press and release samples", () => {
    const samples = [
      { timestamp: 0, x: 50, y: 50, visible: true, flags: 0 },
      { timestamp: 300, x: 50, y: 50, visible: true, flags: 1 },
      { timestamp: 313, x: 50, y: 50, visible: true, flags: 0 },
    ];

    expect(getCursorPositionAtTime(samples, 290)?.cursor.flags).toBe(0);
    expect(getCursorPositionAtTime(samples, 305)?.cursor.flags).toBe(1);
    expect(getCursorPositionAtTime(samples, 320)?.cursor.flags).toBe(0);
  });

  it("keeps an older studio render's pointer hidden under a whiteboard it was resting beneath", () => {
    const recording = createRecording([createFrame(0, { x: 0, y: 0, visible: true })]);
    recording.whiteboardEvents = [
      { timestamp: 1_000, isOpen: true },
      { timestamp: 9_000, isOpen: false },
    ];
    recording.cursorEvents = [
      { timestamp: 0, x: 300, y: 200, visible: true },
      // The board opened over the resting pointer and took its hover…
      { timestamp: 1_033, x: 0, y: 0, visible: false },
      // …and the hand only moved again (34px away) once the board had closed.
      { timestamp: 9_500, x: 334, y: 200, visible: true },
    ];

    const samples = getCursorReplaySamples(recording);

    expect(getCursorPositionAtTime(samples, 5_000)?.cursor.visible).toBe(false);
  });

  it("keeps a real exit from the page that comes back somewhere else", () => {
    const recording = createRecording([createFrame(0, { x: 0, y: 0, visible: true })]);
    recording.cursorEvents = [
      { timestamp: 0, x: 120, y: 80, visible: true },
      { timestamp: 500, x: 0, y: 0, visible: false },
      { timestamp: 4000, x: 600, y: 20, visible: true },
    ];

    const samples = getCursorReplaySamples(recording);

    expect(samples.map((sample) => sample.visible)).toEqual([true, false, true]);
    expect(getCursorPositionAtTime(samples, 2000)?.cursor.visible).toBe(false);
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

  it("holds a sample's own tween as a copy", () => {
    const target = {
      id: "code-editor",
      x: 5,
      y: 6,
      rect: { left: 0, top: 0, width: 50, height: 60 },
    };
    const tween = {
      from: { x: 0, y: 0, visible: true, coordinateSpace: "root" as const, target },
      to: { x: 10, y: 20, visible: true },
      progress: 0.25,
    };
    const samples = [{ timestamp: 0, x: 3, y: 5, visible: true, tween }];

    const held = getCursorPositionAtTime(samples, 100)?.cursor;

    expect(held?.tween).toEqual(tween);
    expect(held?.tween).not.toBe(tween);
    expect(held?.tween?.from.target).not.toBe(target);
  });
});

// Streaming playback hands Cursor a new Recording per chunk while appending to the
// same track arrays; a new samples array restarts Cursor's rAF loop, so it must
// change only when the samples can.
describe("getCursorReplaySamples caching", () => {
  const streamed = () => {
    const recording = createRecording([createFrame(0, { x: 0, y: 0, visible: true })]);
    recording.cursorEvents = [
      { timestamp: 0, x: 10, y: 10, visible: true },
      { timestamp: 100, x: 20, y: 20, visible: true },
    ];
    recording.slideEvents = [];
    return recording;
  };

  it("returns the same samples for a new Recording over the same tracks", () => {
    const recording = streamed();
    const samples = getCursorReplaySamples(recording);

    expect(getCursorReplaySamples({ ...recording, duration: 5_000 })).toBe(samples);
  });

  it("recomputes when a cursor event is appended", () => {
    const recording = streamed();
    const samples = getCursorReplaySamples(recording);

    recording.cursorEvents!.push({ timestamp: 200, x: 30, y: 30, visible: true });
    const next = getCursorReplaySamples({ ...recording });

    expect(next).not.toBe(samples);
    expect(next).toHaveLength(samples.length + 1);
  });

  it("recomputes when a slide opens, since an overlay span changes the cleanup", () => {
    const recording = streamed();
    recording.cursorEvents!.push(
      // Hidden just after 1 s and back near the same spot much later: a stray leave
      // to drop, unless a slide opened over the pointer then.
      { timestamp: 1_033, x: 0, y: 0, visible: false },
      { timestamp: 9_500, x: 22, y: 20, visible: true },
    );
    const samples = getCursorReplaySamples(recording);
    expect(samples.some((sample) => !sample.visible)).toBe(false);

    recording.slideEvents!.push({ timestamp: 1_000, type: "slide_open", slideId: "s1" });
    const next = getCursorReplaySamples({ ...recording });

    expect(next).not.toBe(samples);
    expect(next.some((sample) => !sample.visible)).toBe(true);
  });

  it("caches the frames-only path until frames are appended", () => {
    const recording = createRecording([createFrame(0, { x: 0, y: 0, visible: true })]);
    const samples = getCursorReplaySamples(recording);
    expect(getCursorReplaySamples({ ...recording })).toBe(samples);

    recording.frames.push(...compressFrames([createFrame(50, { x: 5, y: 5, visible: true })]));
    expect(getCursorReplaySamples({ ...recording })).not.toBe(samples);
  });
});
