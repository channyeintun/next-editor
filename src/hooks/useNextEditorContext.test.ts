import { shallowEqual } from "@xstate/react";
import { describe, expect, it } from "vite-plus/test";
import type { Recording } from "../core/src";
import { editorMachine } from "../core/src/machine/editorMachine";
import {
  createIdleAudioState,
  createInitialContext,
  type RecordingSession,
} from "../core/src/machine/types";
import { createRecordingClock, pauseRecordingClock } from "../core/src/machine/recordingClock";
import {
  selectIsTakeInProgress,
  selectNextEditorMetadata,
  selectRecordingChapterCount,
  selectRecordingClock,
  selectRecordingMicrophoneStream,
  selectRecordingSafePoints,
  type EditorMachineSnapshot,
} from "../core/src/useNextEditor";

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
  isRecordingPaused: state.matches("recording") && Boolean(state.context.session?.clock.pausedAt),
  isPlaying: state.matches({ playback: "playing" }),
  hasEnded:
    state.matches({ playback: "ended" }) &&
    state.context.timeline.currentTime >= state.context.timeline.duration - END_EPSILON_MS,
  usesPlaybackModel: !state.context.hasManualWorkspaceOverride && getPlaybackState(state) !== null,
  currentRecording: state.context.recording,
});

const session = {
  startedAt: 1_700_000_000_500,
  startedAtPerf: 0,
  clock: createRecordingClock(),
} as RecordingSession;
const pausedSession = {
  ...session,
  clock: pauseRecordingClock(session.clock, 2_000, 1_700_000_002_500),
} as RecordingSession;

const cases: Array<[string, EditorMachineSnapshot, Partial<ReturnType<typeof legacyMetadata>>]> = [
  ["idle", snapshotAt("idle"), { isRecording: false, usesPlaybackModel: false }],
  [
    "recording",
    snapshotAt("recording", { session }),
    { isRecording: true, isRecordingPaused: false },
  ],
  [
    "recording, paused",
    snapshotAt("recording", { session: pausedSession }),
    { isRecording: true, isRecordingPaused: true },
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

describe("recording selectors", () => {
  const takeSession = {
    ...session,
    chapters: [
      { time: 0, title: "Intro" },
      { time: 500, title: "Setup" },
    ],
    safePoints: [{ recordingTime: 0, perf: 0, wall: 1_700_000_000_500, mediaTime: 0 }],
  } as RecordingSession;
  const microphoneStream = {} as MediaStream;
  const microphoneAudio = {
    ...createIdleAudioState(),
    isRecording: true,
    source: "microphone" as const,
    mediaRecorder: { stream: microphoneStream } as MediaRecorder,
  };

  interface RecordingReadings {
    clock: ReturnType<typeof selectRecordingClock>;
    microphoneStream: MediaStream | null;
    chapterCount: number;
    safePoints: RecordingSession["safePoints"] | null;
  }
  const outsideATake: RecordingReadings = {
    clock: null,
    microphoneStream: null,
    chapterCount: 0,
    safePoints: null,
  };

  const recordingCases: Array<[string, EditorMachineSnapshot, RecordingReadings]> = [
    ["idle", snapshotAt("idle"), outsideATake],
    [
      "starting a microphone take",
      snapshotAt("startingRecording", { audio: microphoneAudio }),
      outsideATake,
    ],
    [
      "recording a microphone take",
      snapshotAt("recording", { session: takeSession, audio: microphoneAudio }),
      {
        clock: { clock: takeSession.clock, startedAtPerf: takeSession.startedAtPerf },
        microphoneStream,
        chapterCount: 2,
        safePoints: takeSession.safePoints,
      },
    ],
    [
      "recording a take narrated from a file",
      snapshotAt("recording", {
        session: takeSession,
        audio: { ...microphoneAudio, source: "external" as const },
      }),
      {
        clock: { clock: takeSession.clock, startedAtPerf: takeSession.startedAtPerf },
        microphoneStream: null,
        chapterCount: 2,
        safePoints: takeSession.safePoints,
      },
    ],
    [
      "recording with the microphone recorder not yet reported",
      snapshotAt("recording", {
        session: takeSession,
        audio: { ...microphoneAudio, mediaRecorder: null },
      }),
      {
        clock: { clock: takeSession.clock, startedAtPerf: takeSession.startedAtPerf },
        microphoneStream: null,
        chapterCount: 2,
        safePoints: takeSession.safePoints,
      },
    ],
    ["recording with no session", snapshotAt("recording"), outsideATake],
    [
      "stopping a take whose session is still set",
      snapshotAt("stoppingRecording", { session: takeSession, audio: microphoneAudio }),
      outsideATake,
    ],
    ["playing", playbackAt("playing", 400), outsideATake],
  ];

  it.each(recordingCases)("reads the take when %s", (_label, snapshot, expected) => {
    expect(selectRecordingClock(snapshot)).toEqual(expected.clock);
    expect(selectRecordingMicrophoneStream(snapshot)).toBe(expected.microphoneStream);
    expect(selectRecordingChapterCount(snapshot)).toBe(expected.chapterCount);
    // By reference: useSelector compares results by reference, so a copy would re-render
    // its consumer on every snapshot.
    expect(selectRecordingSafePoints(snapshot)).toBe(expected.safePoints);
  });

  // A take in this tab is lost with the tab from the moment it starts until it is finalized.
  it.each([
    ["idle", snapshotAt("idle"), false],
    ["startingRecording", snapshotAt("startingRecording"), true],
    ["recording", snapshotAt("recording", { session: takeSession }), true],
    ["recording, paused", snapshotAt("recording", { session: pausedSession }), true],
    ["stoppingRecording", snapshotAt("stoppingRecording", { session: takeSession }), true],
    ["loading", snapshotAt("loading"), false],
    ["playing", playbackAt("playing", 400), false],
  ] as const)("says whether a take is in progress when %s", (_label, snapshot, expected) => {
    expect(selectIsTakeInProgress(snapshot)).toBe(expected);
  });
});
