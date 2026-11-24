import type * as monaco from "monaco-editor";
import { describe, expect, it } from "vite-plus/test";
import type { PreviewEvent, PreviewState } from "../../preview";
import type { Recording } from "../../types";
import type { Keyframe } from "../../utils/deltaTypes";
import { grow, load, send, type PlaybackMachine } from "../testing/replayWalk";
import { getPreviewReplayResult, PREVIEW_PANEL_BEFORE_FIRST_EVENT } from "./preview";

const OPEN_AT_3000: PreviewEvent = {
  type: "preview_open",
  timestamp: 3000,
  size: "large",
  isOpen: true,
  mode: "floating",
  content: "<p>later</p>",
};

const CLOSED = { ...PREVIEW_PANEL_BEFORE_FIRST_EVENT };

function frameAt(timestamp: number, previewState?: PreviewState): Keyframe {
  return {
    timestamp,
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
      ...(previewState ? { previewState } : {}),
    },
  };
}

function recordingWith(tracks: Partial<Recording>): Recording {
  return {
    version: 4,
    id: "preview",
    name: "Preview",
    createdAt: 0,
    duration: 10_000,
    keyframeInterval: 120,
    frames: [frameAt(0)],
    ...tracks,
  };
}

/**
 * A replay whose host panel starts open with another lesson's page, as the viewer may
 * arrive at it. Every state the panel is given is kept in `applied`.
 */
function openWithLeftoverPanel(recording: Recording) {
  const applied: PreviewState[] = [];
  const machine: PlaybackMachine = load({
    recording,
    duration: recording.duration,
    // The frame step needs an editor to run; one without a model writes nothing.
    editor: { getModel: () => null } as unknown as monaco.editor.IStandaloneCodeEditor,
    hooks: { applyPreviewState: (state) => applied.push(state) },
  });
  return { machine, applied };
}

describe("getPreviewReplayResult before the first preview event", () => {
  it("applies the closed panel on a resync, and retains nothing", () => {
    expect(
      getPreviewReplayResult({
        previewEvents: [OPEN_AT_3000],
        currentTime: 1000,
        lastAppliedIndex: -1,
        isResync: true,
      }),
    ).toEqual({ appliedStates: [CLOSED], nextIndex: -1, retainedState: undefined });
  });

  it("applies the closed panel when the clock moves back past the first event", () => {
    const result = getPreviewReplayResult({
      previewEvents: [OPEN_AT_3000],
      currentTime: 1000,
      lastAppliedIndex: 0,
      isResync: false,
    });
    expect(result.appliedStates).toEqual([CLOSED]);
    expect(result.retainedState).toBeUndefined();
  });

  it("applies nothing on a tick that has not reached the first event", () => {
    expect(
      getPreviewReplayResult({
        previewEvents: [OPEN_AT_3000],
        currentTime: 1000,
        lastAppliedIndex: -1,
        isResync: false,
      }).appliedStates,
    ).toEqual([]);
  });

  it("applies nothing for a track with no events", () => {
    expect(
      getPreviewReplayResult({
        previewEvents: [],
        currentTime: 1000,
        lastAppliedIndex: -1,
        isResync: true,
      }).appliedStates,
    ).toEqual([]);
  });

  it("folds the first event from nothing, so an event without isOpen still opens", () => {
    const opensWithoutIsOpen: PreviewEvent = {
      type: "preview_open",
      timestamp: 3000,
      size: "small",
    };
    const forward = getPreviewReplayResult({
      previewEvents: [opensWithoutIsOpen],
      currentTime: 3500,
      lastAppliedIndex: -1,
      isResync: false,
    });
    expect(forward.appliedStates).toHaveLength(1);
    expect(forward.appliedStates[0]).not.toHaveProperty("isOpen");
    expect(forward.retainedState).not.toHaveProperty("isOpen");
  });
});

describe("the preview panel through the machine before the first preview event", () => {
  it("is closed at the load, PLAY, a seek back, a paused seek, STOP and a restart", () => {
    const { machine, applied } = openWithLeftoverPanel(
      recordingWith({ previewEvents: [OPEN_AT_3000] }),
    );
    const last = () => applied.at(-1);

    expect(last(), "after the load").toEqual(CLOSED);
    send(machine, { type: "PLAY" });
    expect(last(), "after PLAY").toEqual(CLOSED);

    send(machine, { type: "TICK", currentTime: 3500 });
    expect(last()).toMatchObject({ isOpen: true, size: "large", mode: "floating" });

    send(machine, { type: "SEEK", time: 1000 });
    expect(last(), "after a seek back while playing").toEqual(CLOSED);

    send(machine, { type: "PAUSE" });
    send(machine, { type: "SEEK", time: 4000 });
    expect(last()).toMatchObject({ isOpen: true });
    send(machine, { type: "SEEK", time: 500 });
    expect(last(), "after a paused seek back").toEqual(CLOSED);

    send(machine, { type: "PLAY" });
    send(machine, { type: "TICK", currentTime: 3500 });
    expect(last()).toMatchObject({ isOpen: true });
    send(machine, { type: "STOP" });
    expect(last(), "after STOP").toEqual(CLOSED);

    send(machine, { type: "PLAY" });
    send(machine, { type: "TICK", currentTime: 10_000 });
    send(machine, { type: "FINISHED" });
    expect(machine.state).toBe("ended");
    send(machine, { type: "PLAY" });
    expect(last(), "after a restart from the end").toEqual(CLOSED);
  });

  it("leaves a recording with no preview at all alone", () => {
    const { machine, applied } = openWithLeftoverPanel(recordingWith({}));
    send(machine, { type: "PLAY" });
    send(machine, { type: "SEEK", time: 1000 });
    send(machine, { type: "STOP" });
    expect(applied).toEqual([]);
  });

  it("keeps the frames' preview state for a recording with no preview events", () => {
    const framePreview: PreviewState = { size: "large", isOpen: true, mode: "docked" };
    const { machine, applied } = openWithLeftoverPanel(
      recordingWith({ frames: [frameAt(0, framePreview)], previewEvents: [] }),
    );
    send(machine, { type: "PLAY" });
    send(machine, { type: "SEEK", time: 1000 });
    expect(applied.length).toBeGreaterThan(0);
    for (const state of applied) expect(state).toMatchObject(framePreview);
  });

  it("closes the panel when a streamed first event lies ahead of the playhead", () => {
    const { machine, applied } = openWithLeftoverPanel(recordingWith({ previewEvents: [] }));
    send(machine, { type: "PLAY" });
    send(machine, { type: "TICK", currentTime: 1000 });
    expect(applied).toEqual([]);

    grow(machine, { previewEvents: [OPEN_AT_3000] }, false);
    expect(applied).toEqual([CLOSED]);

    send(machine, { type: "TICK", currentTime: 3500 });
    expect(applied.at(-1)).toMatchObject({ isOpen: true, size: "large" });
  });
});
