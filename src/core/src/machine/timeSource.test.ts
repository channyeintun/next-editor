import { fromCallback } from "xstate";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeRecordingSnapshot } from "../runtime";
import type {
  AudioPlaybackEmit,
  AudioPlaybackEvent,
  AudioPlaybackInput,
  NarrationLoadEmitted,
} from "./audioActor";
import { fromTypedCallback } from "./fromTypedCallback";
import { getRecordingTimestamp } from "./recordingSession";
import { SYSTEM_TIME_SOURCE } from "./timeSource";
import {
  createManualTimeSource,
  createWorkspaceSnapshot,
  pinClocks,
  RecordingEditor,
  startTake,
  takeMachine,
} from "./testing/takeFixtures";

const sessionOf = (actor: ReturnType<typeof startTake>) => actor.getSnapshot().context.session!;

describe("a take's time source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps every track and the take's length on the source it was started with", async () => {
    // The page's clock is pinned and never moves: a stamp read from it would be 0 or
    // far off, never the source's time.
    pinClocks();
    const time = createManualTimeSource();
    const editor = new RecordingEditor();
    let workspace = createWorkspaceSnapshot("one");
    let runtime = {
      mode: "webcontainer",
      status: "ready",
      terminalSessions: [{ id: "t", title: "t", output: "$ npm start\n" }],
    } as RuntimeRecordingSnapshot;
    const actor = startTake(
      editor,
      { getWorkspaceSnapshot: () => workspace, getRuntimeSnapshot: () => runtime },
      takeMachine,
      { timeSource: time.source },
    );
    const session = () => sessionOf(actor);
    expect(session().startedAtPerf).toBe(time.clock.perf);
    expect(session().startedAt).toBe(time.clock.wall);

    time.advance(400);
    editor.type("!");
    actor.send({ type: "CAPTURE_FRAME" });
    expect(session().frames.at(-1)?.timestamp).toBe(400);

    time.advance(100);
    actor.send({
      type: "CAPTURE_FRAME",
      isMouseMovement: true,
      mousePosition: { x: 40, y: 10, visible: true },
    });
    expect(session().cursorEvents.at(-1)).toEqual({ timestamp: 500, x: 40, y: 10, visible: true });

    time.advance(100);
    actor.send({ type: "WHITEBOARD_EVENT", event: { timestamp: 0, isOpen: true } });
    expect(session().whiteboardEvents.at(-1)?.timestamp).toBe(600);

    time.advance(100);
    actor.send({
      type: "SLIDE_EVENT",
      event: { type: "slide_change", timestamp: 0, slideId: "b" },
    });
    expect(session().slideEvents.at(-1)?.timestamp).toBe(700);

    time.advance(100);
    workspace = createWorkspaceSnapshot("two");
    actor.send({ type: "WORKSPACE_EVENT" });
    expect(session().workspaceEvents.at(-1)?.timestamp).toBe(800);

    time.advance(100);
    runtime = {
      ...runtime,
      terminalSessions: [{ id: "t", title: "t", output: "$ npm start\nserver up\n" }],
    } as RuntimeRecordingSnapshot;
    actor.send({ type: "RUNTIME_EVENT" });
    expect(session().runtimeEvents.at(-1)?.timestamp).toBe(900);

    time.advance(1_100);
    actor.send({ type: "STOP_RECORDING" });
    await vi.waitFor(() => expect(actor.getSnapshot().context.recording).not.toBeNull());
    expect(actor.getSnapshot().context.recording?.duration).toBe(2_000);
    actor.stop();
  });

  it("pauses, resumes and marks chapters on the source", () => {
    const { advance: advancePage } = pinClocks();
    const time = createManualTimeSource();
    const editor = new RecordingEditor();
    const actor = startTake(editor, {}, takeMachine, { timeSource: time.source });
    const session = () => sessionOf(actor);

    time.advance(1_000);
    actor.send({ type: "PAUSE_RECORDING" });
    expect(session().clock.pausedAt).toEqual({ perf: time.clock.perf, wall: time.clock.wall });

    // Time on the source passes while paused; the page's clock moving says nothing.
    time.advance(5_000);
    advancePage(60_000);
    expect(getRecordingTimestamp(session())).toBe(1_000);

    actor.send({ type: "RESUME_RECORDING" });
    expect(session().safePoints.at(-1)).toMatchObject({
      recordingTime: 1_000,
      perf: time.clock.perf,
      wall: time.clock.wall,
    });

    time.advance(250);
    actor.send({ type: "ADD_CHAPTER_MARKER", title: "Next" });
    expect(session().chapters.at(-1)).toEqual({ time: 1_250, title: "Next" });
    expect(session().safePoints.at(-1)).toMatchObject({
      recordingTime: 1_250,
      perf: time.clock.perf,
    });

    editor.type("?");
    actor.send({ type: "CAPTURE_FRAME" });
    expect(session().frames.at(-1)?.timestamp).toBe(1_250);
    actor.stop();
  });

  it("keeps the page's clock when none is given", () => {
    const { advance } = pinClocks();
    const actor = startTake();
    expect(sessionOf(actor).timeSource).toBeUndefined();
    expect(sessionOf(actor).startedAtPerf).toBe(1_000);

    advance(750);
    expect(getRecordingTimestamp(sessionOf(actor))).toBe(750);
    actor.stop();
  });

  it("reads the page's clock at call time, so a pinned clock pins it", () => {
    const { advance } = pinClocks();
    expect(SYSTEM_TIME_SOURCE.perfNow()).toBe(1_000);
    advance(5);
    expect(SYSTEM_TIME_SOURCE.perfNow()).toBe(1_005);
    expect(SYSTEM_TIME_SOURCE.wallNow()).toBe(50_005);
  });
});

describe("a take that uses a real-time device", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The devices' recorders are stubbed: the take only needs to start, so its session's
  // clock can be read.
  const deviceMachine = takeMachine.provide({
    actors: {
      cameraRecording: fromCallback(() => {}),
      screenRecording: fromCallback(() => {}),
      audioPlayback: fromCallback(() => {}),
    },
  });

  // Every case starts the take on a source far from the page's pinned clock, so a session
  // that kept it would start at the source's reading, not the page's.
  const startOn = (
    start: Omit<Parameters<typeof startTake>[3], "timeSource">,
    input: Parameters<typeof startTake>[1] = {},
  ) => {
    pinClocks();
    const time = createManualTimeSource();
    const actor = startTake(new RecordingEditor(), input, deviceMachine, {
      ...start,
      timeSource: time.source,
    });
    return { actor, time };
  };

  it("keeps the page's clock when the take records the camera", () => {
    const { actor } = startOn({ enableCamera: true });
    expect(sessionOf(actor).timeSource).toBeUndefined();
    expect(sessionOf(actor).startedAtPerf).toBe(1_000);
    actor.stop();
  });

  it("keeps the page's clock when the camera is on by default", () => {
    const { actor } = startOn({}, { enableCameraRecording: true });
    expect(sessionOf(actor).timeSource).toBeUndefined();
    expect(sessionOf(actor).startedAtPerf).toBe(1_000);
    actor.stop();
  });

  it("keeps the page's clock when the take records the screen", () => {
    const { actor } = startOn({ screenStream: { getTracks: () => [] } as unknown as MediaStream });
    expect(sessionOf(actor).timeSource).toBeUndefined();
    expect(sessionOf(actor).startedAtPerf).toBe(1_000);
    actor.stop();
  });

  it("keeps the page's clock when the take plays its narration", () => {
    const { actor } = startOn({ audioBlob: new Blob(["narration"], { type: "audio/wav" }) });
    expect(actor.getSnapshot().context.audio.isRecording).toBe(true);
    expect(sessionOf(actor).timeSource).toBeUndefined();
    expect(sessionOf(actor).startedAtPerf).toBe(1_000);
    actor.stop();
  });

  it("keeps the given source when the narration is kept and not played", () => {
    const { actor, time } = startOn({
      audioBlob: new Blob(["narration"], { type: "audio/wav" }),
      externalAudioDurationMs: 3_000,
    });
    expect(sessionOf(actor).timeSource).toBe(time.source);
    expect(sessionOf(actor).startedAtPerf).toBe(time.clock.perf);
    actor.stop();
  });

  it("keeps the given source when the camera is turned off for a take it defaults on for", () => {
    const { actor, time } = startOn({ enableCamera: false }, { enableCameraRecording: true });
    expect(sessionOf(actor).timeSource).toBe(time.source);
    actor.stop();
  });
});

describe("a narration file kept but not played", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const narration = () => new Blob(["narration"], { type: "audio/wav" });

  // Every audioPlayback child the machine spawns, and what it is sent. The kept file
  // must reach none of them while the take records.
  const machineWithPlayers = () => {
    const players: { input: AudioPlaybackInput; events: AudioPlaybackEvent["type"][] }[] = [];
    const machine = takeMachine.provide({
      actors: {
        audioPlayback: fromTypedCallback<
          AudioPlaybackEvent,
          AudioPlaybackInput,
          AudioPlaybackEmit,
          NarrationLoadEmitted
        >(({ input, receive }) => {
          const player = { input, events: [] as AudioPlaybackEvent["type"][] };
          players.push(player);
          receive((event) => {
            player.events.push(event.type);
          });
        }),
      },
    });
    return { machine, players };
  };

  it("spawns no player, survives a pause, a resume and a retake, and ends on STOP", async () => {
    pinClocks();
    const time = createManualTimeSource();
    const { machine, players } = machineWithPlayers();
    const audioBlob = narration();
    const editor = new RecordingEditor();
    const actor = startTake(editor, {}, machine, {
      audioBlob,
      timeSource: time.source,
      externalAudioDurationMs: 3_000,
    });

    const { audio } = actor.getSnapshot().context;
    expect(audio).toMatchObject({
      blob: audioBlob,
      source: "external",
      isRecording: false,
      externalDurationMs: 3_000,
    });
    expect(actor.getSnapshot().children.recordingAudioPlayer).toBeUndefined();

    time.advance(1_000);
    actor.send({ type: "PAUSE_RECORDING" });
    time.advance(500);
    actor.send({ type: "RESUME_RECORDING" });
    time.advance(1_000);
    actor.send({ type: "RETAKE_RECORDING" });
    expect(actor.getSnapshot().matches({ recording: "paused" })).toBe(true);
    expect(getRecordingTimestamp(sessionOf(actor))).toBe(1_000);
    actor.send({ type: "RESUME_RECORDING" });
    expect(actor.getSnapshot().status).toBe("active");
    expect(players).toEqual([]);

    // Recorded time runs past the file's length; the take is cut to it.
    time.advance(4_000);
    actor.send({ type: "STOP_RECORDING" });
    expect(actor.getSnapshot().matches("loading")).toBe(true);
    await vi.waitFor(() => expect(actor.getSnapshot().context.recording).not.toBeNull());

    const recording = actor.getSnapshot().context.recording!;
    expect(recording.audioBlob).toBe(audioBlob);
    expect(recording.audioSource).toBe("external");
    expect(recording.duration).toBe(3_000);
    actor.stop();
  });

  it("keeps a take shorter than the file at its recorded length", async () => {
    pinClocks();
    const time = createManualTimeSource();
    const { machine } = machineWithPlayers();
    const actor = startTake(new RecordingEditor(), {}, machine, {
      audioBlob: narration(),
      timeSource: time.source,
      externalAudioDurationMs: 3_000,
    });

    time.advance(1_200);
    actor.send({ type: "STOP_RECORDING" });
    await vi.waitFor(() => expect(actor.getSnapshot().context.recording).not.toBeNull());
    expect(actor.getSnapshot().context.recording?.duration).toBe(1_200);
    actor.stop();
  });

  it("still plays a file given without a length", () => {
    pinClocks();
    const { machine, players } = machineWithPlayers();
    const audioBlob = narration();
    const actor = startTake(new RecordingEditor(), {}, machine, { audioBlob });

    expect(actor.getSnapshot().context.audio).toMatchObject({
      isRecording: true,
      externalDurationMs: null,
    });
    expect(players).toHaveLength(1);
    expect(players[0].input.blob).toBe(audioBlob);
    expect(players[0].events).toEqual(["PLAY"]);
    actor.stop();
  });
});
