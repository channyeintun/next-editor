import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, fromCallback } from "xstate";
import { editorMachine } from "./editorMachine";
import { getRecordingTimestamp } from "./recordingSession";
import type { Recording } from "../types";

function pinClocks() {
  const clock = { perf: 1_000, wall: 50_000 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.perf);
  vi.spyOn(Date, "now").mockImplementation(() => clock.wall);
  return (ms: number) => {
    clock.perf += ms;
    clock.wall += ms;
  };
}

const startTake = () => {
  const actor = createActor(
    editorMachine.provide({ actors: { mouseTracking: fromCallback(() => {}) } }),
    { input: { editorRef: { current: null } } },
  ).start();
  actor.send({ type: "START_RECORDING" });
  return actor;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chapter markers while recording", () => {
  it("marks a chapter where the take is, once per moment, as a safe point too", () => {
    const advance = pinClocks();
    const actor = startTake();
    const session = () => actor.getSnapshot().context.session!;

    advance(2_000);
    actor.send({ type: "ADD_CHAPTER_MARKER" });
    actor.send({ type: "ADD_CHAPTER_MARKER" });
    advance(1_000);
    actor.send({ type: "ADD_CHAPTER_MARKER", title: "  Routing " });

    expect(session().chapters).toEqual([
      { time: 2_000, title: "Chapter 1" },
      { time: 3_000, title: "Routing" },
    ]);
    expect(session().safePoints.map((point) => point.recordingTime)).toEqual([0, 2_000, 3_000]);
    actor.stop();
  });

  it("anchors a chapter marked while paused at the pause, so a retake lands there", () => {
    const advance = pinClocks();
    const actor = startTake();

    advance(2_000);
    actor.send({ type: "PAUSE_RECORDING" });
    advance(5_000);
    actor.send({ type: "ADD_CHAPTER_MARKER" });
    actor.send({ type: "RESUME_RECORDING" });
    advance(4_000);
    // The resume is a later safe point at the same moment; retaking goes there.
    actor.send({ type: "RETAKE_RECORDING" });
    expect(getRecordingTimestamp(actor.getSnapshot().context.session!)).toBe(2_000);
    actor.stop();
  });

  it("drops the chapters a retake discards, and hands the rest to the recording", async () => {
    const advance = pinClocks();
    const actor = startTake();

    advance(1_000);
    actor.send({ type: "ADD_CHAPTER_MARKER", title: "Kept" });
    advance(1_000);
    actor.send({ type: "ADD_CHAPTER_MARKER", title: "Discarded" });
    advance(1_000);
    actor.send({ type: "PAUSE_RECORDING" });
    actor.send({ type: "RESUME_RECORDING" });
    // Retake to the "Discarded" chapter's moment keeps it; once more drops it.
    actor.send({ type: "RETAKE_RECORDING" });
    actor.send({ type: "RETAKE_RECORDING" });
    expect(actor.getSnapshot().context.session!.chapters).toEqual([{ time: 1_000, title: "Kept" }]);

    actor.send({ type: "STOP_RECORDING" });
    await vi.waitFor(() => expect(actor.getSnapshot().context.recording).not.toBeNull());
    expect(actor.getSnapshot().context.recording?.chapters).toEqual([
      { time: 1_000, title: "Kept" },
    ]);
    actor.stop();
  });
});

describe("editing a recording's chapters", () => {
  const recording: Recording = {
    version: 4,
    id: "lesson",
    name: "Lesson",
    createdAt: 1,
    duration: 10_000,
    keyframeInterval: 120,
    frames: [
      {
        timestamp: 0,
        isKeyframe: true,
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
        },
      },
    ],
  };

  it("replaces the loaded recording's chapters, and ignores another recording's", async () => {
    const actor = createActor(editorMachine, { input: { editorRef: { current: null } } }).start();
    actor.send({ type: "LOAD_RECORDING", recording });
    await vi.waitFor(() => expect(actor.getSnapshot().matches("playback")).toBe(true));

    actor.send({
      type: "SET_CHAPTERS",
      recordingId: "lesson",
      chapters: [
        { time: 4_000, title: "Second" },
        { time: 0, title: "First" },
      ],
    });
    actor.send({ type: "SET_CHAPTERS", recordingId: "other", chapters: [] });

    expect(actor.getSnapshot().context.recording?.chapters).toEqual([
      { time: 0, title: "First" },
      { time: 4_000, title: "Second" },
    ]);
    actor.send({ type: "SET_CHAPTERS", recordingId: "lesson", chapters: [] });
    expect(actor.getSnapshot().context.recording?.chapters).toBeUndefined();
    actor.stop();
  });
});
