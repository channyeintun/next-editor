import { shallowEqual } from "@xstate/react";
import { describe, expect, it } from "vite-plus/test";
import type { Recording } from "../core/src";
import { editorMachine } from "../core/src/machine/editorMachine";
import { createInitialContext, type RecordingSession } from "../core/src/machine/types";
import { selectNextEditorMetadata, type EditorMachineSnapshot } from "../core/src/useNextEditor";

// The epsilon isAtPlaybackEnd allows (editorMachineHelpers.ts PLAYBACK_END_EPSILON_MS).
const END_EPSILON_MS = 100;
const DURATION_MS = 1000;

const recording: Recording = {
  version: 4,
  id: "rec-1",
  name: "Test recording",
  createdAt: 1_700_000_000_000,
  duration: DURATION_MS,
  keyframeInterval: 120,
  frames: [],
};

type StateValue = Parameters<typeof editorMachine.resolveState>[0]["value"];

const snapshotAt = (
  value: StateValue,
  overrides: Partial<ReturnType<typeof createInitialContext>> = {},
): EditorMachineSnapshot => {
  const context = createInitialContext({ editorRef: { current: null } });
  return editorMachine.resolveState({ value, context: { ...context, ...overrides } });
};

const playbackAt = (
  state: "ready" | "playing" | "paused" | "ended",
  currentTime: number,
  overrides: Partial<ReturnType<typeof createInitialContext>> = {},
) =>
  snapshotAt(
    { playback: state },
    {
      recording,
      timeline: {
        ...createInitialContext({ editorRef: { current: null } }).timeline,
        currentTime,
        duration: DURATION_MS,
      },
      ...overrides,
    },
  );

// The eight per-field selectors useNextEditorMetadata subscribed to before they were
// folded into selectNextEditorMetadata, kept here as the oracle. isPaused and
// isRecordingAudio were dropped because no consumer read them.
const getPlaybackState = (state: EditorMachineSnapshot) => {
  if (state.matches({ playback: "playing" })) return "playing";
  if (state.matches({ playback: "paused" })) return "paused";
  if (state.matches({ playback: "ended" })) return "ended";
  return null;
};
const legacyMetadata = (state: EditorMachineSnapshot) => ({
  isRecording: state.matches("recording"),
  isPlaying: state.matches({ playback: "playing" }),
  hasEnded:
    state.matches({ playback: "ended" }) &&
    state.context.timeline.currentTime >= state.context.timeline.duration - END_EPSILON_MS,
  usesPlaybackModel: !state.context.hasManualWorkspaceOverride && getPlaybackState(state) !== null,
  currentRecording: state.context.recording,
  recordingStartTime: state.context.session?.startedAt || null,
});

const session = { startedAt: 1_700_000_000_500, startedAtPerf: 0 } as RecordingSession;

const cases: Array<[string, EditorMachineSnapshot, Partial<ReturnType<typeof legacyMetadata>>]> = [
  ["idle", snapshotAt("idle"), { isRecording: false, usesPlaybackModel: false }],
  [
    "recording",
    snapshotAt("recording", { session }),
    { isRecording: true, recordingStartTime: session.startedAt },
  ],
  ["ready", playbackAt("ready", 0), { isPlaying: false, usesPlaybackModel: false }],
  ["playing", playbackAt("playing", 400), { isPlaying: true, usesPlaybackModel: true }],
  ["paused", playbackAt("paused", 400), { isPlaying: false, usesPlaybackModel: true }],
  [
    "ended below the epsilon",
    playbackAt("ended", DURATION_MS - END_EPSILON_MS - 1),
    { hasEnded: false, usesPlaybackModel: true },
  ],
  [
    "ended at the epsilon",
    playbackAt("ended", DURATION_MS - END_EPSILON_MS),
    { hasEnded: true, usesPlaybackModel: true },
  ],
  [
    "manual workspace override",
    playbackAt("paused", 400, { hasManualWorkspaceOverride: true }),
    { usesPlaybackModel: false },
  ],
];

describe("selectNextEditorMetadata", () => {
  it.each(cases)("matches the per-field selectors when %s", (_label, snapshot, expected) => {
    const metadata = selectNextEditorMetadata(snapshot);
    expect(metadata).toEqual(legacyMetadata(snapshot));
    expect(metadata).toMatchObject(expected);
  });

  it("is shallow-equal across a currentTime-only change, so consumers skip the render", () => {
    const before = selectNextEditorMetadata(playbackAt("playing", 400));
    const after = selectNextEditorMetadata(playbackAt("playing", 416));
    expect(before).not.toBe(after);
    expect(shallowEqual(before, after)).toBe(true);
  });
});
